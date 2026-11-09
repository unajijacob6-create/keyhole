// A small mock NEAR chain for guardian tests (offline): accounts with code that changes over
// blocks, Sputnik DAOs with proposals, injectable failures. Answers in the shapes the RPC uses.
import fs from "node:fs";
import path from "node:path";
import { codeHash, EMPTY_CODE_HASH, Rpc, type Transport } from "../../packages/core/src/index.ts";

const ROOT = path.join(import.meta.dirname, "../..");
export const wasm = (name: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro", `${name}.wasm`)));
export const V1 = wasm("demo_vault_v1");
/** v1 + `sweep`, which reaches transfer: unverified, v1 -> v2 is STOP. */
export const V2 = wasm("demo_vault_v2");

export const NOW = Date.parse("2026-11-10T00:00:00Z");
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export const policy = (threshold: [number, number] = [1, 2]) => ({
  roles: [{ name: "council", kind: { Group: ["a.testnet", "b.testnet"] }, permissions: ["*:*"], vote_policy: {} }],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold },
  proposal_bond: "1",
  proposal_period: "604800000000000",
  bounty_bond: "1",
  bounty_forgiveness_period: "1",
});

export const upgradeRemote = (id: number, target: string, hash: string, status: string, approvals: number, ageMs = 60_000) => ({
  id,
  proposer: "a.testnet",
  description: "",
  status,
  submission_time: ns(NOW - ageMs),
  kind: { UpgradeRemote: { receiver_id: target, method_name: "upgrade", hash } },
  vote_counts: approvals ? { council: [approvals, 0, 0] } : {},
  votes: {},
});

/** FunctionCall `upgrade` whose args are the wasm itself (hash_from "args-code"). */
export const argsCodeProposal = (id: number, target: string, code: Uint8Array, status: string, approvals: number) => ({
  ...upgradeRemote(id, target, "", status, approvals),
  kind: { FunctionCall: { receiver_id: target, actions: [{ method_name: "upgrade", args: b64(code), deposit: "0", gas: "1" }] } },
});

export class Chain {
  height = 1000;
  /** account -> code over time ({from height, code}); null code = no contract. */
  readonly code: Record<string, { from: number; code: Uint8Array | null }[]> = {};
  readonly daos: Record<string, { policy: unknown; proposals: any[] }> = {};
  /** Heights below this are garbage-collected on the regular node (archival still has them). */
  gcBelow = 0;
  /** Return an HTTP status to fail a request (e.g. 503), or null. */
  fail: (params: any) => number | null = () => null;
  readonly calls: any[] = [];

  setCode(account: string, code: Uint8Array | null) {
    this.height += 1;
    (this.code[account] ??= []).push({ from: this.height, code });
  }
  advance(n = 1) {
    this.height += n;
  }
  codeAt(account: string, h: number): Uint8Array | null | undefined {
    const log = this.code[account];
    if (!log) return undefined;
    let cur: Uint8Array | null | undefined = undefined;
    for (const e of log) if (e.from <= h) cur = e.code;
    return cur;
  }

  rpc(o: { archival?: boolean } = {}): Rpc {
    const transport: Transport = async (_url, body) => {
      const { method, params } = JSON.parse(body);
      this.calls.push(params);
      const status = this.fail(params);
      if (status) return { status, json: {} };
      const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: "k", result } });
      const err = (name: string) => ({ status: 200, json: { jsonrpc: "2.0", id: "k", error: { name: "HANDLER_ERROR", cause: { name }, data: name } } });
      if (method !== "query") return err("UNKNOWN_BLOCK");
      const h: number = params.block_id ?? this.height;
      if (params.block_id !== undefined && !o.archival && h < this.gcBelow) return err("GARBAGE_COLLECTED_BLOCK");
      const code = this.codeAt(params.account_id, h);
      if (params.request_type === "view_account") {
        if (code === undefined && !this.daos[params.account_id]) return err("UNKNOWN_ACCOUNT");
        return ok({ amount: "1", locked: "0", code_hash: code ? await codeHash(code) : EMPTY_CODE_HASH, storage_usage: 1, block_height: h, block_hash: "x" });
      }
      if (params.request_type === "view_code") {
        if (!code) return err("NO_CONTRACT_CODE");
        return ok({ hash: await codeHash(code), code_base64: b64(code), block_height: h, block_hash: "x" });
      }
      if (params.request_type === "call_function") {
        const dao = this.daos[params.account_id];
        const view = (v: unknown) => ok({ result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [], block_height: h, block_hash: "x" });
        const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString() || "{}");
        if (dao && params.method_name === "get_last_proposal_id") return view(dao.proposals.length);
        if (dao && params.method_name === "get_policy") return view(dao.policy);
        if (dao && params.method_name === "get_proposals") return view(dao.proposals.slice(args.from_index, args.from_index + args.limit));
        if (dao && params.method_name === "get_proposal") return dao.proposals[args.id] ? view(dao.proposals[args.id]) : err("FunctionCallError");
        return err("MethodResolveError");
      }
      return err("UNKNOWN_ACCOUNT");
    };
    return new Rpc({ network: "testnet", transport, cache: false, retries: 0 });
  }
}

/** A tx API with no transactions (no store_blob to find). */
export const emptyTxApi = async (p: string) => (p === "/v0/account" ? { account_txs: [], resume_token: null } : { transactions: [] });
