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
  heartbeatMs?: number;
  /** When more than this many blocks behind the head, skip to the head (logged). */
  maxLag?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Settled = { ok: true; value: any } | { ok: false; error: unknown };
const settle = (p: Promise<any>): Promise<Settled> => p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
/** Base URL of the neardata block API (override for tests: KH_NEARDATA_BASE=http://…/v0). */
const neardata = (network: Network) => (globalThis as any).process?.env?.KH_NEARDATA_BASE ?? `https://${network}.neardata.xyz/v0`;
const short = (h?: string) => (h ? `${h.slice(0, 6)}…` : "?");

// neardata's public tier allows 180 requests/minute per IP. Space requests out (token bucket),
// honour Retry-After on 429, and never burst. Override with KH_NEARDATA_RPM.
const RPM = Number((globalThis as any).process?.env?.KH_NEARDATA_RPM ?? 150);
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 60_000 / RPM;
  if (at > now) await sleep(at - now);
}
export const neardataStats = { requests: 0, rateLimited: 0 };
async function getJson(url: string, tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      await slot();
      neardataStats.requests++;
      const r = await fetch(url, { redirect: "follow" });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      if (r.status === 429) {
        neardataStats.rateLimited++;
        const ra = Number(r.headers.get("retry-after"));
        nextSlot = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10_000);
      }
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(300 * 2 ** i);
    }
  }
}

export async function lastFinal(network: Network): Promise<number> {
  return (await getJson(`${neardata(network)}/last_block/final`)).block.header.height;
}

export async function follow(opts: FollowOptions): Promise<WatchEvent[]> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rpc = new Rpc({ network: opts.network });
  const base = neardata(opts.network);
  // Code hash per watched account as of the last event this run saw; before that, the previous
  // hash is read from the chain at height-1, so replays from an old height are correct too.
  const known = new Map<string, string>();
  const started = Date.now();
  const expired = () => Boolean(opts.signal?.aborted || (opts.durationMs && Date.now() - started > opts.durationMs));
  let head = 0;
  for (let i = 0; !head; i++) {
    if (expired()) return [];
    try {
      head = await lastFinal(opts.network);
    } catch (e) {
      log(`[watch] ${opts.network}: cannot read the final block (${String((e as Error).message).slice(0, 80)}); retrying`);
      await sleep(Math.min(30000, 2000 * (i + 1)));
    }
  }
  let h = opts.from ?? head;
  const recent: Map<string, TxSummary>[] = [];
  const prefetch = new Map<number, Promise<Settled>>();
  const seen: WatchEvent[] = [];
  log(`[watch] ${opts.network} from block ${h.toLocaleString("en-US")}; watching ${[...opts.watch].join(", ") || "(none)"}${opts.all ? "; network-wide deploy feed on" : ""}`);
  let scanned = 0;
  let failures = 0;
  let skipped = 0;
  let lastBeat = Date.now();
  while (!opts.signal?.aborted) {
    if (opts.durationMs && Date.now() - started > opts.durationMs) break;
    if (opts.heartbeatMs && Date.now() - lastBeat > opts.heartbeatMs) {
      lastBeat = Date.now();
      log(`[watch] ${opts.network} at block ${h.toLocaleString("en-US")} (head ${head.toLocaleString("en-US")}, lag ${head - h}); scanned ${scanned}, skipped ${skipped} blocks; ${seen.length} event(s); neardata ${neardataStats.requests} req, ${neardataStats.rateLimited} rate-limited`);
    }
    if (h > head) {
      await sleep(500);
      head = await lastFinal(opts.network).catch((e) => {
        log(`[watch] ${opts.network}: head refresh failed (${String((e as Error)?.message ?? e).slice(0, 80)}); keeping ${head}`);
        return head;
      });
      // Too far behind (e.g. rate-limited): jump to the head and say so, rather than lag forever.
      if (opts.maxLag && head - h > opts.maxLag) {
        log(`[watch] ${opts.network}: ${head - h} blocks behind; skipping to head ${head.toLocaleString("en-US")} (blocks ${h}–${head - 1} not scanned)`);
        skipped += head - h;
        h = head;
      }
      continue;
    }
    // Prefetch up to 6 blocks ahead when behind, so a mainnet follower keeps up (~1-2 blocks/s).
    // Prefetched promises are settled immediately (never left as unhandled rejections, which would
    // terminate Node); a failed prefetch is simply retried below.
    for (let k = 0; k < (failures ? 1 : 3) && h + k <= head; k++) if (!prefetch.has(h + k)) prefetch.set(h + k, settle(getJson(`${base}/block/${h + k}`)));
    let block: any;
    try {
      const got = await (prefetch.get(h) ?? settle(getJson(`${base}/block/${h}`)));
      if (!got.ok) throw got.error;
      block = got.value;
    } catch (e) {
      // Transient neardata/network failure: log, back off and retry the same height.
      prefetch.delete(h);
      failures++;
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
      log(`[watch] ${opts.network} block ${h}: ${String((e as Error)?.message ?? e).slice(0, 120)}; retry in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    prefetch.delete(h);
    failures = 0;
    scanned++;
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
