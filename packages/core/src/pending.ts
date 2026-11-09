// Upgrade radar: which code is a DAO about to deploy, and can we get the exact bytes before the
// deciding vote? Three sources, all public and checkable:
//
// 1. Sputnik proposals. UpgradeRemote / UpgradeSelf carry the code hash; FunctionCall proposals to
//    an upgrade method (near-plugins `up_deploy_code {"hash"}`, `add_release_info {"hash"}`, ...)
//    carry it in their args.
// 2. near-plugins `Upgradable` staging (`up_staged_code_hash`): code that one call can deploy.
// 3. The bytes themselves. Sputnik stores the code with `store_blob`, whose transaction args ARE
//    the wasm, before the proposal can execute. Found through the FastNEAR transactions API and accepted only if
//    sha256(args) equals the proposed hash, so the API is not trusted for content.
//
// Browser-safe: WebCrypto, fetch and the shared Rpc client only. Rules: docs/GUARDIAN_DESIGN.md.
import { Rpc, RpcAnswerError, type Network } from "./rpc.ts";
import { base58, base64ToBytes, bytesToBase64, codeHash, sha256 } from "./hash.ts";
import { analyzeSputnikPolicy } from "./controller.ts";
import { effectiveHash } from "./history.ts";

export type ProposalState = "pending" | "expired" | "executed" | "rejected" | "removed" | "failed" | "moved";

export interface UpgradeProposal {
  dao: string;
  id: number;
  proposer: string;
  description: string;
  kind: "UpgradeRemote" | "UpgradeSelf" | "FunctionCall";
  /** Contract whose code would change (UpgradeSelf: the DAO itself; FunctionCall: the receiver). */
  target: string;
  /** Method the DAO will call (UpgradeRemote / FunctionCall). */
  method: string | null;
  /** A controller the DAO calls to deploy code to `target` (an `upgrade`/`unrestricted_upgrade`
   *  FunctionCall whose args name `contract_id`, as in aurora-controller-factory). Null otherwise. */
  via: string | null;
  /** `add_release_info`: registers code in a controller for later deployment to the accounts it
   *  manages; `target` (the controller) does not run it, so there is nothing to time. */
  registers_release: boolean;
  /** base58 sha256 of the new code, if determinable. */
  code_hash: string | null;
  hash_from: "proposal" | "args-hash" | "args-code" | null;
  /** Raw Sputnik status. */
  status: string;
  /** InProgress past submission_time + proposal_period => "expired". */
  state: ProposalState;
  submitted_at_ms: number;
  expires_at_ms: number;
  votes: { approve: number; reject: number; remove: number };
  /** Approvals needed for this kind (from get_policy via analyzeSputnikPolicy). */
  required: number | null;
}

/** Method names through which a FunctionCall proposal replaces code. Anchored: `deploy_token` or
 *  `deploy_native_token` (bridge factories deploying *other* contracts) must not match. */
export const UPGRADE_METHODS =
  /^(?:upgrade|up_deploy_code|up_stage_code|deploy|deploy_code|update_contract|unrestricted_upgrade|add_release_info|stage_code|set_code|upgrade_contract)$/;

/** Sputnik policy label per proposal kind (sputnikdao2 `ProposalKind::to_policy_label`). */
const POLICY_LABEL: Record<UpgradeProposal["kind"], string> = { UpgradeRemote: "upgrade_remote", UpgradeSelf: "upgrade_self", FunctionCall: "call" };

const STATE: Record<string, ProposalState> = {
  InProgress: "pending",
  Approved: "executed",
  Rejected: "rejected",
  Removed: "removed",
  Expired: "expired",
  Moved: "moved",
  Failed: "failed",
};

const HASH_FIELDS = ["hash", "code_hash", "codeHash", "new_code_hash"];
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function hasWasmMagic(b: Uint8Array, at = 0): boolean {
  return b.length >= at + 8 && WASM_MAGIC.every((x, i) => b[at + i] === x);
}

/** A 32-byte hash written as base58, hex (64 chars, optional 0x), a JSON byte array, or padded
 *  base64 (rainbowbridge.sputnik-dao.near #219 passes `{"hash":"Zbhu…biHw="}` to up_deploy_code). */
export function normaliseHash(v: unknown): string | null {
  if (Array.isArray(v)) {
    if (v.length !== 32 || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return null;
    return base58.encode(Uint8Array.from(v as number[]));
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  const hex = s.match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  if (hex) return base58.encode(Uint8Array.from(hex[1].match(/../g)!.map((h) => parseInt(h, 16))));
  // 32 bytes in base64 are 44 chars ending in one "="; base58 never contains "=", "+" or "/".
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    const b = safeB64(s);
    return b.length === 32 ? base58.encode(b) : null;
  }
  try {
    return base58.decode(s).length === 32 ? s : null;
  } catch {
    return null;
  }
}

/** JSON object args, or null (binary/borsh args, arrays, invalid UTF-8). */
function jsonArgs(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** The hash a JSON args object names (top-level hash-like field), synchronously. */
function hashFromJsonArgs(bytes: Uint8Array): string | null {
  const obj = jsonArgs(bytes);
  if (!obj) return null;
  for (const f of HASH_FIELDS) {
    const h = normaliseHash((obj as Record<string, unknown>)[f]);
    if (h) return h;
  }
  return null;
}

/** Code hash carried by FunctionCall args: a JSON hash field (base58, hex or 32-byte array), or the
 *  args are the wasm itself (`\0asm`, or a borsh Vec<u8> of it), in which case the hash is sha256 of
 *  that wasm. */
export async function hashFromArgs(argsBase64: string): Promise<{ hash: string; from: "args-hash" | "args-code" } | null> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(argsBase64);
  } catch {
    return null;
  }
  const code = codeInArgs(bytes);
  if (code) return { hash: await codeHash(code), from: "args-code" };
  const h = hashFromJsonArgs(bytes);
  return h ? { hash: h, from: "args-hash" } : null;
}

/** nanoseconds (string or number) → milliseconds. BigInt keeps the precision JSON numbers lose. */
function nsToMs(ns: unknown): number {
  if (ns === null || ns === undefined || ns === "") return NaN;
  try {
    return Number(BigInt(typeof ns === "number" ? Math.round(ns) : String(ns)) / 1_000_000n);
  } catch {
    return NaN;
  }
}

/** Decode one raw Sputnik proposal. null if it is not an upgrade proposal. Synchronous, so a
 *  FunctionCall whose args are raw wasm gets code_hash null here; listUpgradeProposals fills it in. */
export function decodeUpgradeProposal(dao: string, raw: any, policy: any, nowMs: number): UpgradeProposal | null {
  const kindObj = raw?.kind;
  if (!kindObj || typeof kindObj !== "object") return null;
  let kind: UpgradeProposal["kind"];
  let target: string;
  let method: string | null = null;
  let via: string | null = null;
  let registers_release = false;
  let code_hash: string | null = null;
  let hash_from: UpgradeProposal["hash_from"] = null;
  if (kindObj.UpgradeRemote) {
    const k = kindObj.UpgradeRemote;
    kind = "UpgradeRemote";
    target = k.receiver_id;
    method = k.method_name ?? null;
    code_hash = normaliseHash(k.hash);
    hash_from = code_hash ? "proposal" : null;
  } else if (kindObj.UpgradeSelf) {
    kind = "UpgradeSelf";
    target = dao;
    code_hash = normaliseHash(kindObj.UpgradeSelf.hash);
    hash_from = code_hash ? "proposal" : null;
  } else if (kindObj.FunctionCall) {
    const k = kindObj.FunctionCall;
    const actions: any[] = (k.actions ?? []).filter((a: any) => typeof a?.method_name === "string" && UPGRADE_METHODS.test(a.method_name));
    if (!actions.length) return null;
    kind = "FunctionCall";
    target = k.receiver_id;
    // Several upgrade actions in one proposal (e.g. stage then deploy): report the first one that
    // names a hash, else the first one.
    const withHash = actions.map((a) => ({ a, h: a.args ? hashFromJsonArgs(safeB64(a.args)) : null })).find((x) => x.h);
    const chosen = withHash?.a ?? actions[0];
    method = chosen.method_name;
    if (withHash) (code_hash = withHash.h), (hash_from = "args-hash");
    const args = chosen.args ? jsonArgs(safeB64(chosen.args)) : null;
    if (/^(?:upgrade|unrestricted_upgrade)$/.test(method!) && typeof args?.contract_id === "string" && args.contract_id !== k.receiver_id) {
      via = k.receiver_id;
      target = args.contract_id;
    }
    registers_release = method === "add_release_info";
  } else return null;

  const label = POLICY_LABEL[kind];
  const dao_ = analyzeSputnikPolicy(policy, [label]);
  const required = dao_.requiredApprovals;
  // Votes are tallied per role; count the role whose threshold sets `required`. Without one (e.g.
  // token-weighted), fall back to distinct voters.
  let votes = { approve: 0, reject: 0, remove: 0 };
  const counts = dao_.roleName ? raw.vote_counts?.[dao_.roleName] : undefined;
  if (Array.isArray(counts)) votes = { approve: Number(counts[0] ?? 0), reject: Number(counts[1] ?? 0), remove: Number(counts[2] ?? 0) };
  else if (!dao_.roleName && raw.votes && typeof raw.votes === "object") {
    for (const v of Object.values(raw.votes)) {
      if (v === "Approve") votes.approve++;
      else if (v === "Reject") votes.reject++;
      else if (v === "Remove") votes.remove++;
    }
  }

  const submitted_at_ms = nsToMs(raw.submission_time);
  // Uses the *current* policy's period: a policy change after submission is not replayed.
  const expires_at_ms = submitted_at_ms + nsToMs(policy?.proposal_period);
  const status = String(raw.status ?? "");
  let state: ProposalState = STATE[status] ?? "pending";
  // sputnikdao2 policy.rs: expired when submission_time + proposal_period < block_timestamp.
  if (status === "InProgress" && nowMs > expires_at_ms) state = "expired";

  return {
    dao,
    id: Number(raw.id),
    proposer: String(raw.proposer ?? ""),
    description: String(raw.description ?? ""),
    kind,
    target,
    method,
    via,
    registers_release,
    code_hash,
    hash_from,
    status,
    state,
    submitted_at_ms,
    expires_at_ms,
    votes,
    required,
  };
}

/** Can this proposal still execute? `pending`, or `failed` inside its period: sputnikdao2 v3
 *  (`Action::Finalize`, commit 3d568f9) recomputes a Failed proposal's status and re-executes it if
 *  the approvals still stand, in one call by any role with Finalize permission. v2.0 (c2cf155) only
 *  lets Finalize expire it; the DAO's version is not checked here, so this errs towards "live". */
export function isLive(p: UpgradeProposal, nowMs: number): boolean {
  return p.state === "pending" || (p.state === "failed" && nowMs <= p.expires_at_ms);
}

function safeB64(s: string): Uint8Array {
  try {
    return base64ToBytes(s);
  } catch {
    return new Uint8Array();
  }
}

/** FunctionCall proposals whose args are the wasm itself: hash them (async, WebCrypto). */
async function fillArgsCode(p: UpgradeProposal, raw: any): Promise<UpgradeProposal> {
  if (p.kind !== "FunctionCall" || p.code_hash) return p;
  for (const a of raw.kind.FunctionCall.actions ?? []) {
    if (a.method_name !== p.method || !a.args) continue;
    const h = await hashFromArgs(a.args);
    if (h) return { ...p, code_hash: h.hash, hash_from: h.from };
  }
  return p;
}

/** The wasm a FunctionCall proposal carries inline (hash_from "args-code"): re-read the proposal
 *  with get_proposal and return the args of its upgrade action, only if they hash to `hash`.
 *  listUpgradeProposals keeps only the hash, so a proposal list stays small. null if the proposal
 *  is gone (removed) or carries no matching wasm. */
export async function proposalArgsCode(rpc: Rpc, dao: string, id: number, hash: string, method?: string | null): Promise<Uint8Array | null> {
  let raw: any;
  try {
    raw = await rpc.view<any>(dao, "get_proposal", { id });
  } catch (e) {
    if (e instanceof RpcAnswerError || e instanceof SyntaxError) return null;
    throw e;
  }
  for (const a of raw?.kind?.FunctionCall?.actions ?? []) {
    if ((method && a?.method_name !== method) || typeof a?.args !== "string") continue;
    const code = codeInArgs(safeB64(a.args));
    if (code && (await codeHash(code)) === hash) return new Uint8Array(code);
  }
  return null;
}

const PAGE = 50;

/** Upgrade proposals of a Sputnik DAO, newest first. `last`: stop after this many upgrade
 *  proposals (default: scan every proposal). `target`: only proposals that change this contract. */
export async function listUpgradeProposals(rpc: Rpc, dao: string, opts: { last?: number; nowMs?: number; target?: string } = {}): Promise<UpgradeProposal[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const [lastId, policy] = await Promise.all([rpc.view<number>(dao, "get_last_proposal_id"), rpc.view<any>(dao, "get_policy")]);
  const out: UpgradeProposal[] = [];
  const want = opts.last ?? Infinity;
  // get_last_proposal_id is the next id to assign; ids run 0..lastId-1. Removed proposals are
  // deleted from storage, so pages can come back short.
  for (let end = Number(lastId); end > 0 && out.length < want; end -= PAGE) {
    const from = Math.max(0, end - PAGE);
    const page = await rpc.view<any[]>(dao, "get_proposals", { from_index: from, limit: end - from });
    for (const raw of [...(page ?? [])].sort((a, b) => Number(b.id) - Number(a.id))) {
      const p = decodeUpgradeProposal(dao, raw, policy, nowMs);
      if (!p || (opts.target && p.target !== opts.target)) continue;
      out.push(await fillArgsCode(p, raw));
      if (out.length >= want) break;
    }
  }
  return out;
}

// ── near-plugins Upgradable staging ─────────────────────────────────────────────────────────────

export interface StagedUpgrade {
  contract: string;
  staged_hash: string | null;
  live_hash: string;
  /** near-plugins `staging_timestamp`: the earliest time `up_deploy_code` accepts the staged code,
   *  i.e. stage time + staging_duration (near-plugins `up_stage_code`), not the stage time itself. */
  staging_timestamp_ms: number | null;
  staging_duration_ms: number | null;
  pending: boolean;
}

/** Staged code on a near-plugins `Upgradable` contract. null if the contract does not export
 *  `up_staged_code_hash`. Older plugin versions return the hash as a raw 32-byte array, newer ones
 *  as base58; both are normalised. Staged == live (the plugin keeps staged code after deploying)
 *  means nothing is pending. */
export async function stagedUpgrade(rpc: Rpc, contract: string): Promise<StagedUpgrade | null> {
  let raw: unknown;
  try {
    raw = await rpc.view<unknown>(contract, "up_staged_code_hash");
  } catch (e) {
    if (e instanceof RpcAnswerError) return null; // MethodNotFound, no code, or a panic: not Upgradable
    throw e;
  }
  const staged_hash = raw === null || raw === undefined ? null : normaliseHash(raw);
  const live_hash = effectiveHash(await rpc.viewAccount(contract));
  const delay = await rpc.tryView<{ staging_duration?: unknown; staging_timestamp?: unknown }>(contract, "up_get_delay_status");
  const ms = (v: unknown) => (v === null || v === undefined ? null : Number.isFinite(nsToMs(v)) ? nsToMs(v) : null);
  return {
    contract,
    staged_hash,
    live_hash,
    staging_timestamp_ms: ms(delay?.staging_timestamp),
    staging_duration_ms: ms(delay?.staging_duration),
    pending: staged_hash !== null && staged_hash !== live_hash,
  };
}

/** The staged bytes themselves (near-plugins `up_staged_code`), checked against `hash`.
 *  near-plugins declares it `#[result_serializer(borsh)]`, so the view returns borsh
 *  `Option<Vec<u8>>` (tag byte, u32 LE length, bytes), not JSON; a JSON view cannot read it.
 *  A JSON answer (base64 string or byte array) is still accepted for other implementations. */
export async function stagedCode(rpc: Rpc, contract: string, hash: string): Promise<Uint8Array | null> {
  let raw: Uint8Array;
  try {
    // Same request shape as Rpc.view, so recorded fixtures and the per-instance cache are shared.
    const r = await rpc.call<{ result: number[] }>("query", { request_type: "call_function", account_id: contract, method_name: "up_staged_code", args_base64: bytesToBase64(new TextEncoder().encode("{}")), finality: "final" });
    raw = new Uint8Array(r.result);
  } catch (e) {
    if (e instanceof RpcAnswerError) return null; // no such method / account: nothing staged we can read
    throw e;
  }
  const code = borshOptionBytes(raw) ?? jsonBytes(raw);
  if (!code || !code.length) return null;
  return (await codeHash(code)) === hash ? code : null;
}

const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** borsh Option<Vec<u8>>: [0] = None; [1, len u32 LE, ...len bytes] = Some. Anything else: null. */
function borshOptionBytes(b: Uint8Array): Uint8Array | null {
  if (b.length === 1 && b[0] === 0) return new Uint8Array();
  if (b.length >= 5 && b[0] === 1 && u32le(b, 1) === b.length - 5) return b.subarray(5);
  return null;
}

function jsonBytes(b: Uint8Array): Uint8Array | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {
    return null;
  }
  if (typeof v === "string") return safeB64(v);
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return Uint8Array.from(v as number[]);
  return null;
}

// ── The bytes: FastNEAR transactions API ────────────────────────────────────────────────────────

export interface TxApi {
  (path: "/v0/account" | "/v0/transactions", body: unknown): Promise<any>;
}
export const TX_API: Record<Network, string> = { mainnet: "https://tx.main.fastnear.com", testnet: "https://tx.test.fastnear.com" };

export function txApi(network: Network, fetchImpl: typeof fetch = (...a) => fetch(...a)): TxApi {
  const base = TX_API[network];
  return async (path, body) => {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      try {
        const r = await fetchImpl(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 429 || r.status >= 500) {
          last = new Error(`tx API HTTP ${r.status}`);
          continue;
        }
        if (!r.ok) throw Object.assign(new Error(`tx API ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { final: true });
        return await r.json();
      } catch (e) {
        if ((e as any)?.final) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
}

/** /v0/transactions accepts at most 20 hashes per request (its 400 answer says "Limit is 20"). */
const TX_BATCH = 20;

/** FunctionCall actions in a transaction, including those inside a NEP-366 delegate action and a
 *  `DelegateV2` (nearcore ActionView::DelegateV2, whose payload is the versioned enum
 *  `{"V2": DelegateActionV2}` in JSON; same receiver_id/actions fields). */
function functionCalls(tx: any): { receiver: string; method: string; args: string }[] {
  const out: { receiver: string; method: string; args: string }[] = [];
  const walk = (receiver: string, actions: any[]) => {
    for (const a of actions ?? []) {
      if (a?.FunctionCall) out.push({ receiver, method: a.FunctionCall.method_name, args: a.FunctionCall.args ?? "" });
      const d = a?.Delegate?.delegate_action;
      if (d) walk(d.receiver_id, d.actions);
      const v = a?.DelegateV2?.delegate_action;
      for (const inner of v && typeof v === "object" ? Object.values(v) : []) if ((inner as any)?.receiver_id) walk((inner as any).receiver_id, (inner as any).actions);
    }
  };
  walk(tx?.receiver_id, tx?.actions);
  return out;
}

/** The wasm a call carries: raw input (Sputnik store_blob, near-plugins up_stage_code), or a borsh
 *  Vec<u8> (u32 little-endian length, then the bytes) as some older stage methods take it. */
function codeInArgs(args: Uint8Array): Uint8Array | null {
  if (hasWasmMagic(args)) return args;
  if (hasWasmMagic(args, 4) && u32le(args, 0) === args.length - 4) return args.subarray(4);
  return null;
}

/** Scan `dao`'s transactions (it is the real receiver), newest first, for a call whose args are
 *  wasm with sha256 == `hash` (Sputnik `store_blob`; also a direct `up_stage_code` when `dao` is
 *  the near-plugins contract itself). Stops after `maxPages` account pages (default 20, 200 txs
 *  each). The returned code always hashes to `hash`. */
export async function fetchPendingCode(opts: { api: TxApi; dao: string; hash: string; maxPages?: number }): Promise<{ code: Uint8Array; tx: string; signer: string; height: number } | null> {
  const want = base58.decode(opts.hash);
  if (want.length !== 32) throw new Error(`not a 32-byte base58 hash: ${opts.hash}`);
  const maxPages = opts.maxPages ?? 20;
  let resume: unknown = undefined;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { account_id: opts.dao, is_real_receiver: true };
    if (resume !== undefined && resume !== null) body.resume_token = resume;
    const r = await opts.api("/v0/account", body);
    const entries: any[] = (r?.account_txs ?? []).filter((t: any) => t?.is_success !== false && !seen.has(t.transaction_hash));
    entries.forEach((t) => seen.add(t.transaction_hash));
    const height = new Map(entries.map((t) => [t.transaction_hash as string, Number(t.tx_block_height)]));
    for (let i = 0; i < entries.length; i += TX_BATCH) {
      const hashes = entries.slice(i, i + TX_BATCH).map((t) => t.transaction_hash);
      const d = await opts.api("/v0/transactions", { tx_hashes: hashes });
      // Keep newest-first order (the API does not promise to preserve request order).
      const txs: any[] = [...(d?.transactions ?? [])].sort((a, b) => hashes.indexOf(a?.transaction?.hash) - hashes.indexOf(b?.transaction?.hash));
      for (const t of txs) {
        const tx = t?.transaction;
        for (const fc of functionCalls(tx)) {
          if (fc.receiver !== opts.dao) continue;
          const code = codeInArgs(safeB64(fc.args));
          if (!code) continue;
          const got = await sha256(code);
          if (got.length === 32 && got.every((b, k) => b === want[k])) {
            return { code: new Uint8Array(code), tx: tx.hash, signer: tx.signer_id, height: height.get(tx.hash) ?? Number(t?.execution_outcome?.block_height ?? 0) };
          }
        }
      }
    }
    resume = r?.resume_token;
    if (!entries.length && !(r?.account_txs ?? []).length) break;
    if (resume === undefined || resume === null) break;
  }
  return null;
}
