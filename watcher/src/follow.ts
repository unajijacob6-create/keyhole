// Follow NEAR blocks from neardata.xyz and report code/key changes.
//  - watchlist mode: every change on a watched account is posted to the Keyhole registry
//    (ChangeObserved / KeyAdded) and appended to the JSONL feed;
//  - network-wide mode (--all): every code deploy on the network is appended to the feed.
import fs from "node:fs";
import path from "node:path";
import { Rpc, effectiveHash, type Network } from "../../packages/core/src/index.ts";
import { extractEvents, summarizeTransactions, type TxSummary, type WatchEvent } from "./extract.ts";

export interface Poster {
  attest?(code_hash: string, attestation: Record<string, unknown>): Promise<{ id: number; tx: string }>;
  changeObserved(e: { account: string; old_hash: string; new_hash: string; block_height: number }): Promise<{ id: number; tx: string }>;
  keyAdded(e: { account: string; public_key: string; block_height: number; code_hash: string }): Promise<{ id: number; tx: string }>;
}

export interface FollowOptions {
  network: Network;
  watch: Set<string>;
  all?: boolean;
  from?: number;
  /** Stop after this many ms (default: run until stopped). */
  durationMs?: number;
  /** Stop once this predicate returns true for an event. */
  until?: (e: WatchEvent) => boolean;
  feed?: string;
  poster?: Poster;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h?: string) => (h ? `${h.slice(0, 6)}…` : "?");

async function getJson(url: string, tries = 6): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(300 * 2 ** i);
    }
  }
}

export async function lastFinal(network: Network): Promise<number> {
  return (await getJson(`https://${network}.neardata.xyz/v0/last_block/final`)).block.header.height;
}

export async function follow(opts: FollowOptions): Promise<WatchEvent[]> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rpc = new Rpc({ network: opts.network });
  const base = `https://${opts.network}.neardata.xyz/v0`;
  // Code hash per watched account as of the last event this run saw; before that, the previous
  // hash is read from the chain at height-1, so replays from an old height are correct too.
  const known = new Map<string, string>();
  let head = await lastFinal(opts.network);
  let h = opts.from ?? head;
  const started = Date.now();
  const recent: Map<string, TxSummary>[] = [];
  const seen: WatchEvent[] = [];
  log(`[watch] ${opts.network} from block ${h.toLocaleString("en-US")}; watching ${[...opts.watch].join(", ") || "(none)"}${opts.all ? "; network-wide deploy feed on" : ""}`);
  while (!opts.signal?.aborted) {
    if (opts.durationMs && Date.now() - started > opts.durationMs) break;
    if (h > head) {
      await sleep(500);
      head = await lastFinal(opts.network).catch(() => head);
      continue;
    }
    const block = await getJson(`${base}/block/${h}`);
    if (!block) {
      h++; // no block at this height
      continue;
    }
    const recentTxs = new Map<string, TxSummary>(recent.flatMap((m) => [...m]));
    const events = extractEvents(block, recentTxs);
    recent.push(summarizeTransactions(block));
    if (recent.length > 8) recent.shift();
    for (const e of events) {
      const watched = opts.watch.has(e.account);
      const isCode = e.kind === "DeployContract" || e.kind === "DeployGlobalContract" || e.kind === "UseGlobalContract";
      if (!watched && !(opts.all && isCode)) continue;
      seen.push(e);
      const line: Record<string, unknown> = { ...e, network: opts.network, observedAt: new Date().toISOString() };
      let msg = `[watch] block ${e.height.toLocaleString("en-US")}  ${e.account}  ${e.kind} (${e.origin})`;
      if (watched && opts.poster) {
        try {
          if (e.kind === "DeployContract" || e.kind === "UseGlobalContract") {
            let newHash = e.newHash;
            if (!newHash) newHash = effectiveHash(await rpc.viewAccount(e.account, e.height));
            if (newHash.startsWith("global:")) newHash = (await rpc.viewCode(e.account, e.height)).hash;
            const old = known.get(e.account) ?? effectiveHash(await rpc.viewAccount(e.account, e.height - 1).catch(() => ({ code_hash: "11111111111111111111111111111111" }) as any));
            msg += `  ${short(old)} → ${short(newHash)}`;
            if (old !== newHash) {
              const p = await opts.poster.changeObserved({ account: e.account, old_hash: old, new_hash: newHash, block_height: e.height });
              msg += `  → registry ChangeObserved #${p.id} (tx ${p.tx.slice(0, 8)}…)`;
              line.attestation = { kind: "ChangeObserved", id: p.id, tx: p.tx };
            } else msg += "  (same code redeployed; not attested)";
            known.set(e.account, newHash);
          } else if (e.kind === "AddFullAccessKey") {
            const codeHash = known.get(e.account) ?? effectiveHash(await rpc.viewAccount(e.account, e.height));
            const p = await opts.poster.keyAdded({ account: e.account, public_key: e.publicKey!, block_height: e.height, code_hash: codeHash.startsWith("global:") ? "11111111111111111111111111111111" : codeHash });
            msg += `  ${e.publicKey}  → registry KeyAdded #${p.id} (tx ${p.tx.slice(0, 8)}…)`;
            line.attestation = { kind: "KeyAdded", id: p.id, tx: p.tx };
          }
        } catch (err) {
          msg += `  (posting failed: ${String((err as Error).message).slice(0, 100)})`;
        }
      } else if (e.newHash) msg += `  new code ${short(e.newHash)}`;
      log(msg);
      if (opts.feed) {
        fs.mkdirSync(path.dirname(opts.feed), { recursive: true });
        fs.appendFileSync(opts.feed, JSON.stringify(line) + "\n");
      }
      if (opts.until?.(e)) return seen;
    }
    h++;
  }
  return seen;
}
