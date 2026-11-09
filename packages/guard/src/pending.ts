// Pending-upgrade check for @keyhole/guard: before an agent deposits, find code changes that have not
// executed yet and grade them the way the guardian does.
//
//   1. Sputnik proposals of the DAO(s) that control the target (inspect owners with a DAO actor, as
//      guardian/src/radar.ts resolveController does; plus the target itself if it is a Sputnik DAO),
//      kept only while they can still execute (core isLive: pending, or failed inside its period).
//   2. near-plugins staged code (up_staged_code_hash differs from the live hash).
//
// Each one is graded by guardian/src/assess.ts assessPending (exact bytes from the DAO's store_blob
// transaction or up_staged_code, export/call-graph diff, verification of the new hash). Fail closed:
// an RPC error, an unreadable proposal list or bytes that cannot be fetched give CAUTION, never OK.
import { assessPending, type AssessDeps, type Assessment, type CodeSource, type Reviewer } from "../../../guardian/src/assess.ts";
import {
  KEYHOLE_REGISTRY,
  Rpc,
  isLive,
  listUpgradeProposals,
  registryRpc,
  stagedUpgrade,
  txApi,
  type KeyholeReport,
  type Network,
  type ProposalState,
  type Transport,
  type TxApi,
  type UpgradeProposal,
  type Verdict,
} from "../../core/src/index.ts";

export interface PendingDeps {
  /** RPC for the target's network. Default: a new Rpc for the report's network. */
  rpc?: Rpc;
  /** Used only when `rpc` is not given. */
  rpcUrl?: string;
  transport?: Transport;
  /** FastNEAR transactions API, to read the bytes a DAO stored with store_blob. Default: txApi(network). */
  api?: TxApi;
  /** Keyhole registry (ReproducibleBuild / AiReview by code hash). Default: the testnet registry.
   *  null: do not ask it. */
  registry?: { rpc: Rpc; account: string } | null;
  /** Optional AI reviewer passed through to assessPending. Default none: the deterministic grade only. */
  reviewer?: Reviewer | null;
  nowMs?: number;
  /** Upgrade proposals per DAO for this target to read, newest first (default 20). If all of them
   *  are recent enough that older ones could still be live, the check says so and returns CAUTION. */
  last?: number;
}

export interface PendingUpgrade {
  source: "proposal" | "staged";
  target: string;
  dao: string | null;
  proposal_id: number | null;
  proposal_kind: UpgradeProposal["kind"] | null;
  method: string | null;
  state: ProposalState | null;
  votes: { approve: number; required: number | null } | null;
  expires_at: string | null;
  pending_hash: string | null;
  verdict: Verdict;
  headline: string;
  flags: string[];
  /** Where the bytes came from (store_blob tx, up_staged_code), or null if they could not be read. */
  code_source: CodeSource;
  assessment: Assessment | null;
  error: string | null;
}

export interface PendingCheck {
  schema: "keyhole.pending-check/1";
  target: string;
  network: Network;
  verdict: Verdict;
  headline: string;
  /** Sputnik DAOs whose proposals were read. */
  daos: string[];
  /** Whether near-plugins staging was read (the code exports up_staged_code_hash). */
  staged_checked: boolean;
  /** Upgrades that can still execute, graded. Settled proposals are not listed. */
  upgrades: PendingUpgrade[];
  /** Upgrade proposals read and left out because they can no longer execute. */
  ignored: { dao: string; proposal_id: number; state: ProposalState }[];
  /** Why the check could not rule things out (each one makes the verdict at least CAUTION). */
  errors: string[];
}

const RANK: Record<Verdict, number> = { OK: 0, CAUTION: 1, STOP: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[b] > RANK[a] ? b : a);
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const short = (h: string | null) => (h ? (h.length > 12 ? `${h.slice(0, 8)}…` : h) : "unknown");

/** The DAOs that control `report.account` and whether it has near-plugins staging. Same rule as
 *  guardian/src/radar.ts resolveController, from a report the guard already has (no second inspect),
 *  plus the target itself when it is a Sputnik DAO (it upgrades itself through UpgradeSelf). */
export function controllersOf(report: Pick<KeyholeReport, "account" | "owners" | "wasm">): { daos: string[]; upgradable: boolean } {
  const daos = new Set<string>();
  for (const o of report.owners ?? []) if (o.actor?.dao) daos.add(o.account);
  const exports = report.wasm?.exports ?? [];
  if (exports.includes("get_policy") && exports.includes("get_proposals") && exports.includes("get_last_proposal_id")) daos.add(report.account);
  return { daos: [...daos], upgradable: exports.includes("up_staged_code_hash") };
}

/** One graded upgrade, with the guard's rule that unreadable bytes are never OK. */
export function pendingFromAssessment(a: Assessment, p: UpgradeProposal | null): PendingUpgrade {
  let verdict: Verdict = a.grade.verdict;
  let headline = a.grade.headline;
  // Bytes not obtainable is never OK (gradeUpgrade already says CAUTION; this keeps it so). The one
  // exception is a proposal for the code that already runs: equal sha256, nothing to read.
  if (verdict === "OK" && a.code_source === null && !a.grade.flags.includes("NO_CHANGE")) {
    verdict = "CAUTION";
    headline = `CAUTION: the pending code ${short(a.pending_hash)} for ${a.target} could not be read, so it was not compared with the live code.`;
  }
  return {
    source: p ? "proposal" : "staged",
    target: a.target,
    dao: p?.dao ?? null,
    proposal_id: p?.id ?? null,
    proposal_kind: p?.kind ?? null,
    method: p?.method ?? null,
    state: p?.state ?? null,
    votes: p ? { approve: p.votes.approve, required: p.required } : null,
    expires_at: p && Number.isFinite(p.expires_at_ms) ? new Date(p.expires_at_ms).toISOString() : null,
    pending_hash: a.pending_hash,
    verdict,
    headline,
    flags: [...a.grade.flags],
    code_source: a.code_source,
    assessment: a,
    error: null,
  };
}

function failed(target: string, p: UpgradeProposal | null, hash: string | null, e: unknown): PendingUpgrade {
  const where = p ? `proposal #${p.id} of ${p.dao}` : `staged code on ${target}`;
  return {
    source: p ? "proposal" : "staged",
    target,
    dao: p?.dao ?? null,
    proposal_id: p?.id ?? null,
    proposal_kind: p?.kind ?? null,
    method: p?.method ?? null,
    state: p?.state ?? null,
    votes: p ? { approve: p.votes.approve, required: p.required } : null,
    expires_at: p && Number.isFinite(p.expires_at_ms) ? new Date(p.expires_at_ms).toISOString() : null,
    pending_hash: hash,
    verdict: "CAUTION",
    headline: `CAUTION: ${where} (code ${short(hash)}) could not be graded: ${msg(e)}`,
    flags: ["PENDING_CODE_UNAVAILABLE"],
    code_source: null,
    assessment: null,
    error: msg(e),
  };
}

/** Where a pending upgrade is, in words, for refusals and logs. */
export function describePending(u: PendingUpgrade): string {
  const where = u.source === "proposal" ? `proposal #${u.proposal_id} of ${u.dao}` : `near-plugins staged code on ${u.target}`;
  return `${where}, code ${u.pending_hash ?? "unknown"}`;
}

/** Grade every upgrade of `report.account` that can still execute. Never throws: a failure is a
 *  CAUTION with the reason in `errors`. */
export async function checkPendingUpgrades(report: KeyholeReport, deps: PendingDeps = {}): Promise<PendingCheck> {
  const target = report.account;
  const network: Network = report.network ?? (target.endsWith(".testnet") ? "testnet" : "mainnet");
  const nowMs = deps.nowMs ?? Date.now();
  const last = deps.last ?? 20;
  const { daos, upgradable } = controllersOf(report);
  const out: PendingCheck = { schema: "keyhole.pending-check/1", target, network, verdict: "OK", headline: "", daos, staged_checked: upgradable, upgrades: [], ignored: [], errors: [] };

  if (daos.length || upgradable) {
    try {
      const rpc = deps.rpc ?? new Rpc({ network, url: deps.rpcUrl, transport: deps.transport });
      const assessDeps: AssessDeps = {
        rpc,
        api: deps.api ?? txApi(network),
        registry: deps.registry === undefined ? { rpc: network === KEYHOLE_REGISTRY.network ? rpc : registryRpc(), account: KEYHOLE_REGISTRY.account } : deps.registry,
        reviewer: deps.reviewer ?? null,
        now: () => new Date(nowMs),
      };
      for (const dao of daos) {
        let props: UpgradeProposal[];
        try {
          props = await listUpgradeProposals(rpc, dao, { last, nowMs, target });
        } catch (e) {
          out.errors.push(`could not read the upgrade proposals of ${dao}: ${msg(e)}`);
          continue;
        }
        // Newest first. If the oldest one read could still be inside its period, an older one could
        // too (same policy period, earlier submission is the only way to be older): not ruled out.
        const oldest = props.at(-1);
        if (props.length >= last && oldest && !(oldest.expires_at_ms < nowMs)) {
          out.errors.push(`read the newest ${last} upgrade proposals of ${dao} for ${target}; the oldest (#${oldest.id}) is still inside its proposal period, so older live ones were not ruled out`);
        }
        for (const p of props) {
          // add_release_info registers code in a controller for later; the controller does not run it.
          if (!isLive(p, nowMs) || p.registers_release) {
            out.ignored.push({ dao, proposal_id: p.id, state: p.state });
            continue;
          }
          try {
            out.upgrades.push(pendingFromAssessment(await assessPending(assessDeps, { target, hash: p.code_hash, dao, proposal: p }), p));
          } catch (e) {
            out.upgrades.push(failed(target, p, p.code_hash, e));
          }
        }
      }
      if (upgradable) {
        try {
          const s = await stagedUpgrade(rpc, target);
          if (s?.pending) {
            try {
              out.upgrades.push(pendingFromAssessment(await assessPending(assessDeps, { target, hash: s.staged_hash, staged: s }), null));
            } catch (e) {
              out.upgrades.push(failed(target, null, s.staged_hash, e));
            }
          }
        } catch (e) {
          out.errors.push(`could not read near-plugins staged code of ${target}: ${msg(e)}`);
        }
      }
    } catch (e) {
      out.errors.push(`pending-upgrade check failed: ${msg(e)}`);
    }
  }

  for (const u of out.upgrades) out.verdict = worst(out.verdict, u.verdict);
  if (out.errors.length) out.verdict = worst(out.verdict, "CAUTION");
  const top = out.upgrades.find((u) => u.verdict === out.verdict && u.verdict !== "OK");
  if (top) out.headline = `pending upgrade ${top.verdict} (${describePending(top)}): ${top.headline}`;
  else if (out.errors.length) out.headline = `CAUTION: pending upgrades could not be ruled out: ${out.errors[0]}`;
  else if (out.upgrades.length) out.headline = `${out.upgrades.length} pending upgrade${out.upgrades.length > 1 ? "s" : ""} for ${target}, graded OK.`;
  else if (!daos.length && !upgradable) out.headline = `No controlling Sputnik DAO and no near-plugins staging found for ${target}; nothing pending to grade.`;
  else out.headline = `No upgrade of ${target} is pending (${[daos.length && `proposals of ${daos.join(", ")}`, upgradable && "near-plugins staging"].filter(Boolean).join("; ")}).`;
  return out;
}
