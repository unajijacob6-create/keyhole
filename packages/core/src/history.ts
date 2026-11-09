// When did this account's code last change? Found from public archival RPC alone, by searching
// block heights for the boundary where the effective code hash became the current one. Anyone can
// re-check the answer with two view_account calls (at height-1 and height).
//
// Limit: if the code changed A → B → A inside the window, the search can land on an older
// boundary. The result says "found by search", not "the only change".
import { Rpc, RpcAnswerError, ARCHIVAL_RPC, type AccountView, type Transport } from "./rpc.ts";
import { EMPTY_CODE_HASH } from "./hash.ts";
import { ev, type Evidence } from "./evidence.ts";

export function effectiveHash(a: Pick<AccountView, "code_hash" | "global_contract_hash" | "global_contract_account_id">): string {
  if (a.code_hash !== EMPTY_CODE_HASH) return a.code_hash;
  if (a.global_contract_hash) return a.global_contract_hash;
  if (a.global_contract_account_id) return `global:${a.global_contract_account_id}`;
  return EMPTY_CODE_HASH;
}

export interface CodeChange {
  status: "found" | "unchanged-since" | "unknown";
  /** First block at which the current code was in place (status "found"). */
  height?: number;
  timestamp?: string; // ISO
  previousHash?: string;
  /** For "unchanged-since": the code was already current at this height. */
  sinceHeight?: number;
  sinceTimestamp?: string;
  calls: number;
  evidence: Evidence[];
  note?: string;
}

export interface HistoryOptions {
  /** How far back to look, in blocks. Default ~120 days at 1 block/s-ish. */
  maxLookback?: number;
  transport?: Transport;
  archivalUrl?: string;
}

export async function lastCodeChange(rpc: Rpc, account: string, currentHash: string, headHeight: number, opts: HistoryOptions = {}): Promise<CodeChange> {
  const arch = new Rpc({ network: rpc.network, url: opts.archivalUrl ?? ARCHIVAL_RPC[rpc.network], transport: opts.transport, retries: 7 });
  const maxLookback = opts.maxLookback ?? 10_000_000;
  const hashAt = async (h: number): Promise<string | null> => {
    try {
      return effectiveHash(await arch.viewAccount(account, h));
    } catch (e) {
      if (e instanceof RpcAnswerError && /UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null; // account did not exist yet
      if (e instanceof RpcAnswerError && /UNKNOWN_BLOCK/.test(e.message)) return "__missing_block__";
      throw e;
    }
  };
  const blockTime = async (h: number) => {
    try {
      const b = await arch.block({ block_id: h });
      return new Date(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n)).toISOString();
    } catch {
      return undefined;
    }
  };
  try {
    // Exponential search backwards for a height where the hash differs.
    let hi = headHeight; // hash == current
    let lo: number | null = null;
    let loHash: string | null = null;
    for (let step = 1000; ; step *= 4) {
      const h = Math.max(1, headHeight - step);
      let x = await hashAt(h);
      // Skipped heights (no block produced) — try a neighbour.
      for (let k = 1; x === "__missing_block__" && k < 5; k++) x = await hashAt(h - k);
      if (x !== currentHash) {
        lo = h;
        loHash = x;
        break;
      }
      hi = h;
      if (step >= maxLookback || h === 1) {
        return { status: "unchanged-since", sinceHeight: h, sinceTimestamp: await blockTime(h), calls: arch.calls, evidence: [ev.account(rpc.network, account, h)] };
      }
    }
    // Binary search: hash(lo) != current, hash(hi) == current.
    while (hi - lo! > 1) {
      const mid = Math.floor((lo! + hi) / 2);
      const x = await hashAt(mid);
      if (x === "__missing_block__") {
        // Probe the next produced block upward.
        let m2 = mid + 1;
        let y = await hashAt(m2);
        while (y === "__missing_block__" && m2 < hi) y = await hashAt(++m2);
        if (y === currentHash) hi = m2;
        else (lo = m2), (loHash = y);
        if (m2 >= hi) break;
        continue;
      }
      if (x === currentHash) hi = mid;
      else (lo = mid), (loHash = x);
    }
    return {
      status: "found",
      height: hi,
      timestamp: await blockTime(hi),
      previousHash: loHash ?? "(account did not exist)",
      calls: arch.calls,
      evidence: [ev.account(rpc.network, account, lo!), ev.account(rpc.network, account, hi)],
      note: "found by archival search; re-check view_account at both heights",
    };
  } catch (e) {
    return { status: "unknown", calls: arch.calls, evidence: [], note: `archival RPC unavailable: ${String((e as Error).message).slice(0, 120)}` };
  }
}
