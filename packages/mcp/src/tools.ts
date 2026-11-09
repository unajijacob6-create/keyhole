// The four Keyhole tools an agent can call before it moves money, as plain functions with injected
// dependencies (so tests run them on a fake chain). Read-only: no tool takes a key, signs, or sends a
// transaction. Every answer carries the evidence fields Keyhole already produces.
import {
  KEYHOLE_REGISTRY,
  Rpc,
  effectiveHash,
  inspect,
  isLive,
  listUpgradeProposals,
  registryRpc,
  stagedUpgrade,
  txApi,
  type KeyholeReport,
  type Network,
  type TxApi,
  type UpgradeProposal,
  type Verdict,
} from "../../core/src/index.ts";
import { assessPending, type AssessDeps, type Assessment } from "../../../guardian/src/assess.ts";
import { controllersOf, decide, pendingFromAssessment, type PendingCheck, type PendingUpgrade } from "../../guard/src/index.ts";
import { decodeHatch, verifyHatch, type Hatch } from "../../hatch/src/index.ts";

export interface McpDeps {
  /** A fresh RPC client per tool call (a long-running server must not reuse cached answers). */
  rpc: (network: Network) => Rpc;
  /** FastNEAR transactions API (reads the bytes a DAO stored with store_blob). */
  txApi: (network: Network) => TxApi;
  /** Ask the Keyhole registry (testnet) for reproducible-build / AI-review attestations. */
  registry: boolean;
  /** Read near-plugins code_deployers from a contract's declared GitHub source (inspect). */
  sourceRoles: boolean;
  nowMs: () => number;
  /** Most tx-API requests one tool call may spend looking for store_blob bytes (each assessment
   *  scans the DAO's transactions newest first). Past it, the bytes count as not found. */
  txBudget: number;
}

export const defaultDeps = (): McpDeps => ({
  rpc: (network) => new Rpc({ network }),
  txApi: (network) => txApi(network),
  registry: true,
  sourceRoles: true,
  nowMs: () => Date.now(),
  txBudget: 120,
});

type Json = Record<string, unknown>;
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties: false };
  run: (args: any, deps: McpDeps) => Promise<unknown>;
}

const ACCOUNT = { type: "string", pattern: "^(?=.{2,64}$)(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+$", description: "NEAR account id, e.g. v2.ref-finance.near" };
const NETWORK = { type: "string", enum: ["mainnet", "testnet"], description: "Default mainnet (testnet for ids ending in .testnet)." };
const netOf = (account: string | undefined, n?: Network): Network => n ?? (account?.endsWith(".testnet") ? "testnet" : "mainnet");
const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function registryFor(deps: McpDeps, rpc: Rpc, network: Network): AssessDeps["registry"] {
  if (!deps.registry) return null;
  return { rpc: network === KEYHOLE_REGISTRY.network ? rpc : registryRpc(), account: KEYHOLE_REGISTRY.account };
}

/** A tx API that stops answering (empty pages) after `budget` requests; `spent()` says whether it did. */
function budgeted(api: TxApi, budget: number): TxApi & { exhausted: () => boolean } {
  let used = 0;
  let hit = false;
  const f = (async (path, body) => {
    if (used >= budget) {
      hit = true;
      return path === "/v0/account" ? { account_txs: [] } : { transactions: [] };
    }
    used++;
    return api(path, body);
  }) as TxApi & { exhausted: () => boolean };
  f.exhausted = () => hit;
  return f;
}

// ── keyhole_inspect ─────────────────────────────────────────────────────────────────────────────

export function inspectSummary(r: KeyholeReport) {
  return {
    schema: "keyhole.mcp.inspect/1",
    contract: r.account,
    network: r.network,
    at: r.at,
    exists: r.exists,
    verdict: r.grade.verdict,
    class: r.grade.class,
    headline: r.grade.headline,
    flags: r.grade.flags,
    who_can_change_the_code: r.paths.map((p) => ({ via: p.via, control: p.control, methods: p.methods ?? [], text: p.text, evidence: p.evidence })),
    owners: r.owners.map((o) => ({
      account: o.account,
      source: o.source,
      uncertain: o.uncertain ?? false,
      note: o.note ?? null,
      actor: o.actor ? { summary: o.actor.summary, single_key: o.actor.singleKey, full_access_keys: o.actor.fullAccessKeys, dao: o.actor.dao ? { required_approvals: o.actor.dao.requiredApprovals, role: o.actor.dao.roleName, role_size: o.actor.dao.roleSize, proposal_kind: o.actor.dao.proposalKind } : null } : null,
    })),
    reasons: r.grade.reasons,
    code: r.code,
    keys: { full_access: r.keys.fullAccess.length, function_call: r.keys.functionCall.length },
    verification: {
      sourcescan: r.sourcescan?.status ?? null,
      nep330: r.nep330 ? { present: r.nep330.present, build_info: r.nep330.hasBuildInfo, repo: r.nep330.repoStatus } : null,
      registry: r.registry ? { available: r.registry.available, attestations_for_hash: r.registry.forHash.length } : null,
    },
    last_change: r.lastChange,
    rpc_calls: r.rpcCalls,
    disclaimer: r.disclaimer,
  };
}

const inspectTool: ToolDef = {
  name: "keyhole_inspect",
  title: "Who can change this NEAR contract?",
  description:
    "Keyhole's trust check of a NEAR contract from public RPC: verdict (OK / CAUTION / STOP), who can replace its code (keys, owner, DAO threshold, global-contract publisher), whether the code is verified, and the reasons, each with the RPC request that re-checks it. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      contract: ACCOUNT,
      network: NETWORK,
      history: { type: "boolean", description: "Also find the last code change in archival RPC (about 25 extra requests). Default false." },
    },
    required: ["contract"],
    additionalProperties: false,
  },
  async run(a: { contract: string; network?: Network; history?: boolean }, deps) {
    const network = netOf(a.contract, a.network);
    const rpc = deps.rpc(network);
    const r = await inspect(a.contract, { network, rpc, history: a.history ?? false, registry: deps.registry ? undefined : false, sourceRoles: deps.sourceRoles ? undefined : false, nowMs: deps.nowMs() });
    return inspectSummary(r);
  },
};

// ── keyhole_pending ─────────────────────────────────────────────────────────────────────────────

function gradeSummary(u: PendingUpgrade, a: Assessment) {
  return {
    verdict: u.verdict,
    headline: u.headline,
    flags: u.flags,
    reasons: a.grade.reasons,
    summary: a.summary,
    live_hash: a.live_hash,
    pending_hash: a.pending_hash,
    code_source: a.code_source,
    pending_size: a.pending_size,
    verified: a.verified,
  };
}

function proposalSummary(p: UpgradeProposal, nowMs: number) {
  return {
    dao: p.dao,
    id: p.id,
    kind: p.kind,
    target: p.target,
    via: p.via,
    method: p.method,
    description: p.description.length > 200 ? p.description.slice(0, 200) + "…" : p.description,
    proposer: p.proposer,
    status: p.status,
    state: p.state,
    live: isLive(p, nowMs),
    votes: p.votes,
    required: p.required,
    submitted_at: iso(p.submitted_at_ms),
    expires_at: iso(p.expires_at_ms),
    code_hash: p.code_hash,
    hash_from: p.hash_from,
  };
}

const pendingTool: ToolDef = {
  name: "keyhole_pending",
  title: "Which upgrade is coming?",
  description:
    "Upgrade proposals of the Sputnik DAO that controls a contract (or of a given DAO), newest first, and near-plugins staged code. Upgrades that can still execute are graded like the Keyhole guardian does: the exact bytes (from the DAO's store_blob transaction or up_staged_code) diffed against the live code, plus verification of the new hash; each grade gives verdict, flags, headline, pending hash and where the bytes came from. Settled proposals are listed with their state and whether their code is the code that runs now. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      contract: { ...ACCOUNT, description: "Contract whose upgrades to list; its controlling DAO(s) are resolved by inspect." },
      dao: { ...ACCOUNT, description: "A Sputnik DAO; lists its upgrade proposals for every target." },
      network: NETWORK,
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Upgrade proposals per DAO, newest first. Default 5." },
    },
    additionalProperties: false,
  },
  async run(a: { contract?: string; dao?: string; network?: Network; limit?: number }, deps) {
    if (!a.contract === !a.dao) throw new Error("give exactly one of contract or dao");
    const network = netOf(a.contract ?? a.dao, a.network);
    const rpc = deps.rpc(network);
    const nowMs = deps.nowMs();
    const limit = a.limit ?? 5;
    const api = budgeted(deps.txApi(network), deps.txBudget);
    const assessDeps: AssessDeps = { rpc, api, registry: registryFor(deps, rpc, network), reviewer: null, now: () => new Date(nowMs) };
    let daos: string[];
    let upgradable = false;
    if (a.contract) {
      // Same controller rule as keyhole_check_call (inspect with source-declared roles), so the two
      // tools cannot disagree about which DAOs to search.
      const r = await inspect(a.contract, { network, rpc, history: false, registry: deps.registry ? undefined : false, sourceRoles: deps.sourceRoles ? undefined : false, nowMs });
      const c = controllersOf(r);
      daos = c.daos;
      upgradable = c.upgradable;
    } else daos = [a.dao!];

    const notes: string[] = [];
    let complete = true;
    const proposals: unknown[] = [];
    const live: Verdict[] = [];
    const liveHash = new Map<string, Promise<string | null>>();
    const codeOf = (t: string) => liveHash.get(t) ?? liveHash.set(t, rpc.viewAccount(t).then(effectiveHash, () => null)).get(t)!;
    for (const dao of daos) {
      const props = await listUpgradeProposals(rpc, dao, { last: limit, nowMs, target: a.contract });
      for (const p of props) {
        const isLiveNow = isLive(p, nowMs);
        const item: Json = proposalSummary(p, nowMs);
        const current = await codeOf(p.target);
        item.is_current_code = p.code_hash && current ? p.code_hash === current : null;
        // Only upgrades that can still execute are graded: for a settled one the code it replaced is
        // no longer at hand (the diff would count every capability as new), and it cannot be beaten.
        if (p.registers_release) item.not_graded = "add_release_info registers code with a controller for later; the controller does not run it";
        else if (!isLiveNow) item.not_graded = `settled (${p.state}); only upgrades that can still execute are graded`;
        else {
          try {
            const a2 = await assessPending(assessDeps, { target: p.target, hash: p.code_hash, dao, proposal: p });
            const u = pendingFromAssessment(a2, p);
            item.grade = gradeSummary(u, a2);
            if (!a2.code_source && api.exhausted()) item.note = `bytes not found within this call's tx-index budget (${deps.txBudget} requests)`;
            live.push(u.verdict);
          } catch (e) {
            item.grade = null;
            item.error = String((e as Error)?.message ?? e).slice(0, 300);
            live.push("CAUTION");
          }
        }
        proposals.push(item);
      }
      if (props.length >= limit) {
        // Newest first, one policy period for all: if the oldest listed could still execute, an older one could too.
        const oldest = props.at(-1)!;
        const open = !(oldest.expires_at_ms < nowMs);
        if (open) complete = false;
        notes.push(`${dao}: showing the newest ${limit} upgrade proposals${a.contract ? ` for ${a.contract}` : ""}; ${open ? `the oldest (#${oldest.id}) is still inside its proposal period, so older live ones are not ruled out: raise limit` : "older ones are past their proposal period"}`);
      }
    }

    let staged: unknown = null;
    if (a.contract && upgradable) {
      const s = await stagedUpgrade(rpc, a.contract);
      if (s?.pending) {
        const a2 = await assessPending(assessDeps, { target: a.contract, hash: s.staged_hash, staged: s });
        const u = pendingFromAssessment(a2, null);
        staged = { ...s, staging_timestamp: s.staging_timestamp_ms === null ? null : iso(s.staging_timestamp_ms), grade: gradeSummary(u, a2) };
        live.push(u.verdict);
      } else staged = s ? { ...s, pending: false } : null;
    }
    if (a.contract && !daos.length) notes.push(`no controlling Sputnik DAO found for ${a.contract} (inspect owners); only near-plugins staging was checked`);
    const verdict: Verdict = live.includes("STOP") ? "STOP" : live.includes("CAUTION") || !complete ? "CAUTION" : "OK";
    return {
      schema: "keyhole.mcp.pending/1",
      contract: a.contract ?? null,
      dao: a.dao ?? null,
      network,
      controllers: daos,
      live_count: live.length,
      live_complete: complete,
      live_verdict: verdict,
      live_headline: live.length
        ? `${live.length} upgrade${live.length > 1 ? "s" : ""} can still execute; worst grade ${verdict}.`
        : complete
          ? "No upgrade that can still execute was found."
          : "None found among the proposals read, but older ones may still execute (see notes).",
      proposals,
      staged,
      notes,
      limits: "A grade describes what the new code can do that the live code cannot (export and call-graph diff) and whether its hash is verified; a logic change inside an existing method is invisible to it. STOP is a grade, not proof of malice.",
    };
  },
};

// ── keyhole_check_call ──────────────────────────────────────────────────────────────────────────

function pendingBrief(p: PendingCheck | null) {
  if (!p) return null;
  return {
    verdict: p.verdict,
    headline: p.headline,
    daos: p.daos,
    staged_checked: p.staged_checked,
    upgrades: p.upgrades.map((u) => ({ source: u.source, dao: u.dao, proposal_id: u.proposal_id, state: u.state, votes: u.votes, expires_at: u.expires_at, pending_hash: u.pending_hash, verdict: u.verdict, headline: u.headline, flags: u.flags, code_source: u.code_source, summary: u.assessment?.summary ?? [], error: u.error })),
    ignored: p.ignored.length,
    errors: p.errors,
  };
}

const checkCallTool: ToolDef = {
  name: "keyhole_check_call",
  title: "Would guardCall allow this call?",
  description:
    "What @keyhole/guard's guardCall would decide for a call to a contract, WITHOUT executing anything: OK (it would execute), CAUTION (it would ask a human or follow policy.onCaution, default deny) or STOP (it refuses), with the reasons from the live code's grade and from every pending upgrade that can still execute. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      contract: ACCOUNT,
      method: { type: "string", minLength: 1, maxLength: 256, description: "Method the agent is about to call, e.g. deposit." },
      deposit: { type: "string", pattern: "^[0-9]{1,40}$", description: "Attached deposit in yoctoNEAR (echoed; the verdict does not depend on it)." },
      network: NETWORK,
      expect_code_hash: { type: "string", maxLength: 64, description: "Code hash the agent was configured against; any other hash is STOP." },
      check_pending: { type: "boolean", description: "Grade upgrades that have not executed yet (default true)." },
    },
    required: ["contract", "method"],
    additionalProperties: false,
  },
  async run(a: { contract: string; method: string; deposit?: string; network?: Network; expect_code_hash?: string; check_pending?: boolean }, deps) {
    const network = netOf(a.contract, a.network);
    const rpc = deps.rpc(network);
    const nowMs = deps.nowMs();
    const api = budgeted(deps.txApi(network), deps.txBudget);
    const d = await decide(
      a.contract,
      { methodName: a.method, deposit: a.deposit },
      { onCaution: "deny", expectCodeHash: a.expect_code_hash, checkPending: a.check_pending ?? true },
      { inspect: { network, rpc, nowMs, registry: deps.registry ? undefined : false, sourceRoles: deps.sourceRoles ? undefined : false }, pending: { rpc, api, registry: registryFor(deps, rpc, network), nowMs } },
    );
    const what =
      d.verdict === "OK" ? "guardCall would execute the call." : d.verdict === "CAUTION" ? "guardCall would ask a human (policy.ask) or follow policy.onCaution; with the default policy it refuses." : "guardCall would refuse (GuardRefusal); execute would never be called.";
    return {
      schema: "keyhole.mcp.check-call/1",
      contract: a.contract,
      method: a.method,
      deposit: a.deposit ?? null,
      network,
      decision: d.verdict,
      would_execute_by_default: d.allowed,
      what_guardcall_does: what,
      reason: d.reason,
      pending_stop: d.pendingStop ? { dao: d.pendingStop.dao, proposal_id: d.pendingStop.proposal_id, pending_hash: d.pendingStop.pending_hash, headline: d.pendingStop.headline } : null,
      live_code: { verdict: d.report.grade.verdict, class: d.report.grade.class, headline: d.report.grade.headline, code_hash: d.report.code?.hash ?? null, reasons: d.report.grade.reasons },
      pending: pendingBrief(d.pending),
      executed: false,
      note: "Nothing was signed or sent. Run the call through guardCall itself: the chain can change between this check and your transaction.",
    };
  },
};

// ── keyhole_verify_hatch ────────────────────────────────────────────────────────────────────────

const big = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const verifyHatchTool: ToolDef = {
  name: "keyhole_verify_hatch",
  title: "Is this escape hatch what it claims?",
  description:
    "Offline check of a keyhole.hatch/1 record (the withdraw-to-self a depositor signs in advance with @keyhole/hatch): the signature is valid over the NEP-461 hash and every record field matches the signed bytes. Returns the checks and what the signed delegate action actually says (sender, receiver, method, args, deposit, nonce, max block height). No network, no keys.",
  inputSchema: {
    type: "object",
    properties: {
      hatch: { type: ["object", "string"], description: "The hatch record as JSON (object or string), as @keyhole/hatch produces it when a depositor arms a hatch." },
    },
    required: ["hatch"],
    additionalProperties: false,
  },
  async run(a: { hatch: Hatch | string }) {
    const h: Hatch = typeof a.hatch === "string" ? JSON.parse(a.hatch) : a.hatch;
    let result: { ok: boolean; checks: string[] };
    try {
      result = verifyHatch(h);
    } catch (e) {
      result = { ok: false, checks: [`FAIL: ${String((e as Error)?.message ?? e)}`] };
    }
    let signed: unknown = null;
    if (h.signed_delegate) {
      try {
        const d = decodeHatch(h);
        signed = { sender: d.senderId, receiver: d.receiverId, actions: d.actions, nonce: big(d.nonce), max_block_height: big(d.maxBlockHeight), public_key: d.publicKey };
      } catch (e) {
        signed = { error: String((e as Error)?.message ?? e) };
      }
    }
    return {
      schema: "keyhole.mcp.verify-hatch/1",
      ok: result.ok,
      checks: result.checks,
      record: { id: h.id, network: h.network, account: h.account, venue: h.venue, method: h.method, args: h.args, deposit: h.deposit, gas: h.gas, mode: h.mode, trigger: h.trigger, max_block_height: h.max_block_height, created_at: h.created_at },
      signed,
      note: "Offline: says nothing about whether the hatch is still usable on chain (key present, nonce unused, height not passed). @keyhole/hatch hatchHealth checks that.",
    };
  },
};

export const TOOLS: ToolDef[] = [inspectTool, pendingTool, checkCallTool, verifyHatchTool];
