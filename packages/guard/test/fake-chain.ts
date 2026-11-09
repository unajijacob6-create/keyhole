// An offline chain for guard and MCP tests: an Rpc over a fake transport (the pattern of
// guardian/test/radar.test.ts), a fake FastNEAR tx API holding store_blob transactions, a Sputnik
// policy, and a tiny wasm builder for contracts whose bytes only need the right exports.
import fs from "node:fs";
import path from "node:path";
import { Rpc, bytesToBase64, codeHash, EMPTY_CODE_HASH, type AccessKeyInfo, type Transport, type TxApi } from "../../core/src/index.ts";

export const ROOT = path.join(import.meta.dirname, "../../..");
export const wasm = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/out", name)));

export const DAO = "dao.testnet";
export const VAULT = "vault.testnet";
export const NOW = Date.parse("2026-11-10T00:00:00Z");
export const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const WEEK_NS = "604800000000000";

export const policy = {
  roles: [{ name: "council", kind: { Group: ["a.testnet", "b.testnet"] }, permissions: ["*:*"], vote_policy: {} }],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "1",
  proposal_period: WEEK_NS,
  bounty_bond: "1",
  bounty_forgiveness_period: "1",
};

/** A Sputnik UpgradeRemote proposal for `target`, `ageMs` old. */
export const proposal = (id: number, status: string, hash: string, o: { ageMs?: number; approvals?: number; target?: string } = {}) => ({
  id,
  proposer: "a.testnet",
  description: `upgrade #${id}`,
  status,
  submission_time: ns(NOW - (o.ageMs ?? 60_000)),
  kind: { UpgradeRemote: { receiver_id: o.target ?? VAULT, method_name: "upgrade", hash } },
  vote_counts: o.approvals ? { council: [o.approvals, 0, 0] } : {},
  votes: {},
});

const leb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

/** A valid wasm module whose only content is `exports` (each a no-op function). */
export function tinyWasm(exports: string[]): Uint8Array {
  const n = exports.length;
  const enc = new TextEncoder();
  const types = section(1, [1, 0x60, 0, 0]);
  const funcs = section(3, [...leb(n), ...exports.map(() => 0)]);
  const exps = section(7, [...leb(n), ...exports.flatMap((e, i) => [...leb(enc.encode(e).length), ...enc.encode(e), 0x00, ...leb(i)])]);
  const code = section(10, [...leb(n), ...exports.flatMap(() => [2, 0, 0x0b])]);
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...exps, ...code]);
}
export const DAO_WASM = tinyWasm(["get_policy", "get_proposals", "get_last_proposal_id", "get_proposal", "add_proposal", "act_proposal", "store_blob"]);

type View = unknown | ((args: any) => unknown);
export interface ChainState {
  accounts: Record<string, { code?: Uint8Array; keys?: AccessKeyInfo[] }>;
  /** account -> method -> JSON answer (or a function of the args). */
  views: Record<string, Record<string, View>>;
  /** account -> method -> raw result bytes (e.g. borsh up_staged_code). */
  raw?: Record<string, Record<string, Uint8Array>>;
  /** Make a request fail like an outage (HTTP 500). */
  outage?: (params: any) => boolean;
  height?: number;
}

export interface FakeChain {
  rpc: Rpc;
  transport: Transport;
  /** Every request, as "<request_type>[ <account>.<method>]". */
  log: string[];
}

export function fakeChain(state: ChainState): FakeChain {
  const log: string[] = [];
  const transport: Transport = async (_url, body) => {
    const { method, params } = JSON.parse(body);
    const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: "k", result } });
    const err = (name: string) => ({ status: 200, json: { jsonrpc: "2.0", id: "k", error: { name: "HANDLER_ERROR", cause: { name }, message: name } } });
    log.push(method === "block" ? "block" : `${params.request_type} ${params.account_id}${params.method_name ? "." + params.method_name : ""}`);
    if (state.outage?.(params)) return { status: 500, json: null };
    if (method === "block") return ok({ header: { height: state.height ?? 1000, timestamp_nanosec: ns(NOW) } });
    const acct = state.accounts[params.account_id];
    switch (params.request_type) {
      case "view_account":
        if (!acct) return err("UNKNOWN_ACCOUNT");
        return ok({ amount: "1", locked: "0", code_hash: acct.code ? await codeHash(acct.code) : EMPTY_CODE_HASH, storage_usage: 1, block_height: state.height ?? 1000, block_hash: "x" });
      case "view_access_key_list":
        if (!acct) return err("UNKNOWN_ACCOUNT");
        return ok({ keys: acct.keys ?? [] });
      case "view_code":
        if (!acct) return err("UNKNOWN_ACCOUNT");
        if (!acct.code) return err("NO_CONTRACT_CODE");
        return ok({ hash: await codeHash(acct.code), code_base64: bytesToBase64(acct.code) });
      case "call_function": {
        if (!acct) return err("UNKNOWN_ACCOUNT");
        const raw = state.raw?.[params.account_id]?.[params.method_name];
        if (raw) return ok({ result: [...raw], logs: [] });
        const views = state.views[params.account_id] ?? {};
        if (!(params.method_name in views)) return err("MethodNotFound");
        const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString() || "{}");
        const v = views[params.method_name];
        const answer = typeof v === "function" ? (v as (a: any) => unknown)(args) : v;
        return ok({ result: [...new TextEncoder().encode(JSON.stringify(answer))], logs: [] });
      }
    }
    return err("UNKNOWN_REQUEST");
  };
  return { rpc: new Rpc({ network: "testnet", transport, cache: false, retries: 0 }), transport, log };
}

/** Sputnik views over a mutable proposal list. */
export function daoViews(proposals: any[]): Record<string, View> {
  return {
    get_policy: policy,
    get_last_proposal_id: () => proposals.length,
    get_proposals: (a: { from_index: number; limit: number }) => proposals.slice(a.from_index, a.from_index + a.limit),
  };
}

/** A FastNEAR tx API whose index of `dao` holds one store_blob transaction per blob. */
export function fakeTxApi(dao: string, blobs: Uint8Array[]): TxApi & { calls: string[] } {
  const calls: string[] = [];
  const txs = blobs.map((b, i) => ({ hash: `TX${i}`, signer_id: "a.testnet", receiver_id: dao, actions: [{ FunctionCall: { method_name: "store_blob", args: bytesToBase64(b), gas: 1, deposit: "0" } }] }));
  const api = (async (p: string, body: any) => {
    calls.push(p);
    if (p === "/v0/account") return body.resume_token ? { account_txs: [] } : { account_txs: txs.map((t, i) => ({ transaction_hash: t.hash, tx_block_height: 900 + i, is_success: true })) };
    return { transactions: body.tx_hashes.map((h: string) => ({ transaction: txs.find((t) => t.hash === h) })) };
  }) as TxApi & { calls: string[] };
  api.calls = calls;
  return api;
}

/** borsh Option<Vec<u8>> Some(bytes), as near-plugins up_staged_code returns it. */
export function borshSome(b: Uint8Array): Uint8Array {
  const n = b.length;
  return new Uint8Array([1, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...b]);
}
