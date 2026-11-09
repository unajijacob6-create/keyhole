// Watchlist poller: the authoritative way to detect changes on watched accounts, independent of the
// neardata block stream (whose free tier allows 180 requests/minute per IP, which shared CI IPs
// exhaust). Every interval it reads each account's effective code hash and full-access keys over
// RPC. On a change it finds the exact block by archival bisection, then reports and attests it.
import fs from "node:fs";
import path from "node:path";
import { Rpc, ARCHIVAL_RPC, RpcAnswerError, effectiveHash, lastCodeChange, type Network } from "../../packages/core/src/index.ts";
import type { Poster } from "./follow.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PollOptions {
  network: Network;
  accounts: string[];
  intervalMs?: number;
  durationMs?: number;
  poster?: Poster;
  feed?: string;
  log?: (l: string) => void;
  signal?: AbortSignal;
  /** For tests: inject RPC clients. */
  rpc?: Rpc;
  archival?: Rpc;
}

/** First block height in (lo, hi] at which `pred` is true, given pred(lo) false and pred(hi) true. */
export async function bisect(lo: number, hi: number, pred: (h: number) => Promise<boolean>): Promise<number> {
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export async function keyAddedAt(archival: Rpc, account: string, publicKey: string, seenAt: number, notBefore: number): Promise<number> {
  const has = async (h: number) => {
    try {
      await archival.call("query", { request_type: "view_access_key", account_id: account, public_key: publicKey, block_id: h });
      return true;
    } catch (e) {
      if (e instanceof RpcAnswerError) return false; // UNKNOWN_ACCESS_KEY / account missing / block missing
      throw e;
    }
  };
  return bisect(notBefore, seenAt, has);
}

export async function pollWatchlist(opts: PollOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rpc = opts.rpc ?? new Rpc({ network: opts.network });
  const archival = opts.archival ?? new Rpc({ network: opts.network, url: ARCHIVAL_RPC[opts.network], retries: 7 });
  const interval = opts.intervalMs ?? 60_000;
  const started = Date.now();
  const state = new Map<string, { hash: string; faks: Set<string>; height: number }>();
  let events = 0;

  const read = async (account: string) => {
    const fresh = new Rpc({ network: opts.network, url: rpc.url }); // no cross-tick cache
    const head = (await fresh.block({ finality: "final" })).header.height as number;
    const acct = await fresh.viewAccount(account, head);
    const keys = await fresh.call<{ keys: any[] }>("query", { request_type: "view_access_key_list", account_id: account, block_id: head });
    return { head, hash: effectiveHash(acct), faks: new Set(keys.keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key as string)) };
  };
  const emit = (line: Record<string, unknown>) => {
    if (!opts.feed) return;
    fs.mkdirSync(path.dirname(opts.feed), { recursive: true });
    fs.appendFileSync(opts.feed, JSON.stringify({ ...line, network: opts.network, observedAt: new Date().toISOString(), source: "poll" }) + "\n");
  };

  log(`[poll] ${opts.network}: watching ${opts.accounts.length} account(s) every ${interval / 1000}s`);
  while (!opts.signal?.aborted && !(opts.durationMs && Date.now() - started > opts.durationMs)) {
    for (const account of opts.accounts) {
      try {
        const now = await read(account);
        const prev = state.get(account);
        state.set(account, { hash: now.hash, faks: now.faks, height: now.head });
        if (!prev) continue; // first observation is the baseline
        if (now.hash !== prev.hash) {
          // Find the exact block where the current hash first appears, between the two observations.
          let height = now.head;
          const lc = await lastCodeChange(rpc, account, now.hash, now.head, { maxLookback: Math.max(1000, now.head - prev.height + 10) });
          if (lc.status === "found" && lc.height) height = lc.height;
          let msg = `[poll] block ${height.toLocaleString("en-US")}  ${account}  code ${prev.hash.slice(0, 6)}… → ${now.hash.slice(0, 6)}…`;
          let attestation: unknown;
          if (opts.poster && !now.hash.startsWith("global:") && !prev.hash.startsWith("global:")) {
            const p = await opts.poster.changeObserved({ account, old_hash: prev.hash, new_hash: now.hash, block_height: height });
            msg += `  → registry ChangeObserved #${p.id}`;
            attestation = { kind: "ChangeObserved", id: p.id, tx: p.tx };
          }
          log(msg);
          emit({ kind: "DeployContract", account, height, oldHash: prev.hash, newHash: now.hash, attestation });
          events++;
        }
        for (const pk of now.faks) {
          if (prev.faks.has(pk)) continue;
          const height = await keyAddedAt(archival, account, pk, now.head, prev.height).catch(() => now.head);
          let msg = `[poll] block ${height.toLocaleString("en-US")}  ${account}  full-access key added ${pk.slice(0, 16)}…`;
          let attestation: unknown;
          if (opts.poster) {
            const p = await opts.poster.keyAdded({ account, public_key: pk, block_height: height, code_hash: now.hash.startsWith("global:") ? "11111111111111111111111111111111" : now.hash });
            msg += `  → registry KeyAdded #${p.id}`;
            attestation = { kind: "KeyAdded", id: p.id, tx: p.tx };
          }
          log(msg);
          emit({ kind: "AddFullAccessKey", account, height, publicKey: pk, attestation });
          events++;
        }
      } catch (e) {
        // RPC, archival or registry trouble: log and try again next round; never exit.
        log(`[poll] ${account}: ${String((e as Error)?.message ?? e).slice(0, 140)}; will retry`);
      }
    }
    const left = opts.durationMs ? opts.durationMs - (Date.now() - started) : interval;
    await sleep(Math.max(0, Math.min(interval, left)));
  }
  log(`[poll] ${opts.network}: stopped; ${events} change(s) reported`);
  return events;
}
