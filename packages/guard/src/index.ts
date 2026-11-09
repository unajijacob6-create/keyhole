// @keyhole/guard — a pre-call check for agents, enforced in code (not in a prompt).
//
//   await guardCall("vault.example.near", { methodName: "deposit", deposit: 1n }, { execute });
//
// STOP    → throws GuardRefusal; `execute` is never called.
// CAUTION → asks a human (policy.ask) or follows policy.onCaution ("allow" | "deny").
// OK      → executes.
// The verdict comes from @keyhole/core's deterministic grade on fresh public-RPC data, and (default
// on) from the grade of every upgrade of the target that has not executed yet: live Sputnik
// proposals of the controlling DAO and near-plugins staged code (./pending.ts). A pending upgrade
// graded STOP refuses the call even when the live code grades OK.
//
// Optional auto-hatch (testnet only): pass `hatch` and, after a successful execute, the guard arms a
// @keyhole/hatch delegate hatch (a withdraw-to-self signed in advance) for the same venue and
// returns it with the result.
import type { Account, Provider } from "near-api-js";
import { inspect, type InspectOptions, type KeyholeReport, type Verdict } from "../../core/src/index.ts";
import type { Hatch, HatchTrigger } from "../../hatch/src/index.ts";
import { checkPendingUpgrades, describePending, type PendingCheck, type PendingDeps, type PendingUpgrade } from "./pending.ts";

export { checkPendingUpgrades, controllersOf, describePending, pendingFromAssessment, type PendingCheck, type PendingDeps, type PendingUpgrade } from "./pending.ts";

export interface GuardedCall {
  methodName: string;
  args?: unknown;
  deposit?: bigint | string;
  gas?: bigint | string;
}

export interface GuardPolicy {
  /** What to do on CAUTION when no `ask` is given. Default "deny" (fail closed). */
  onCaution?: "allow" | "deny";
  /** Ask a human on CAUTION; resolve true to proceed. `pending` carries the pending-upgrade grades. */
  ask?: (report: KeyholeReport, call: GuardedCall, pending: PendingCheck | null) => Promise<boolean>;
  /** Pin the code hash the agent was configured against; any other hash is refused. */
  expectCodeHash?: string;
  /** Grade upgrades that have not executed yet (live DAO proposals, near-plugins staged code).
   *  Default true. false skips it: the decision then rests on the live code alone. */
  checkPending?: boolean;
}

/** Arm a delegate hatch for the same venue after a successful execute (testnet only). `owner` must
 *  be the account that made the deposit: the hatch is a withdraw-to-self it signs. */
export interface AutoHatch {
  owner: Account;
  provider: Provider;
  method: string;
  args: Record<string, unknown>;
  deposit?: string | bigint;
  gas?: string | bigint;
  ttlBlocks?: number;
  trigger?: HatchTrigger;
}

export interface GuardOptions<T> {
  execute: (accountId: string, call: GuardedCall) => Promise<T>;
  policy?: GuardPolicy;
  inspect?: InspectOptions;
  /** RPC, tx API, registry and optional reviewer for the pending-upgrade check. Default: the
   *  inspect options' rpc / rpcUrl / transport and public endpoints. */
  pending?: PendingDeps;
  log?: (line: string) => void;
  /** Inject a report (tests). */
  report?: KeyholeReport;
}

export interface GuardHatchOptions<T> extends GuardOptions<T> {
  hatch: AutoHatch;
}

export interface HatchedResult<T> {
  result: T;
  /** The armed hatch, or null if arming failed after the call went through (see hatchError). */
  hatch: Hatch | null;
  hatchError: string | null;
}

export class GuardRefusal extends Error {
  readonly verdict: Verdict;
  readonly report: KeyholeReport;
  /** The pending upgrade that caused a STOP refusal (DAO, proposal id, pending hash, headline, grade). */
  readonly pending: PendingUpgrade | null;
  /** The whole pending-upgrade check, when it ran. */
  readonly pendingCheck: PendingCheck | null;
  constructor(message: string, verdict: Verdict, report: KeyholeReport, extra: { pending?: PendingUpgrade | null; pendingCheck?: PendingCheck | null } = {}) {
    super(message);
    this.name = "GuardRefusal";
    this.verdict = verdict;
    this.report = report;
    this.pending = extra.pending ?? null;
    this.pendingCheck = extra.pendingCheck ?? null;
  }
}

export interface GuardDecision {
  allowed: boolean;
  verdict: Verdict;
  reason: string;
  report: KeyholeReport;
  /** Pending-upgrade check, or null when it did not run (policy off, or refused before it). */
  pending: PendingCheck | null;
  /** The pending upgrade that made the verdict STOP, if one did. */
  pendingStop: PendingUpgrade | null;
}

export async function decide(
  accountId: string,
  call: GuardedCall,
  policy: GuardPolicy = {},
  opts: { inspect?: InspectOptions; report?: KeyholeReport; pending?: PendingDeps } = {},
): Promise<GuardDecision> {
  const report = opts.report ?? (await inspect(accountId, { history: false, ...opts.inspect }));
  const g = report.grade;
  const top = g.reasons.find((r) => r.severity === "stop") ?? g.reasons[0];
  const base = { report, pending: null, pendingStop: null };
  if (policy.expectCodeHash && report.code?.hash !== policy.expectCodeHash) {
    return { ...base, allowed: false, verdict: "STOP", reason: `code hash ${report.code?.hash ?? "none"} is not the pinned ${policy.expectCodeHash}` };
  }
  if (g.verdict === "STOP") return { ...base, allowed: false, verdict: "STOP", reason: top?.text ?? g.headline };

  let pending: PendingCheck | null = null;
  if (policy.checkPending !== false) {
    const i = opts.inspect ?? {};
    pending = await checkPendingUpgrades(report, { rpc: i.rpc, rpcUrl: i.rpcUrl, transport: i.transport, nowMs: i.nowMs, ...opts.pending });
    if (pending.verdict === "STOP") {
      const stop = pending.upgrades.find((u) => u.verdict === "STOP")!;
      return { report, pending, pendingStop: stop, allowed: false, verdict: "STOP", reason: `pending upgrade graded STOP (${describePending(stop)}): ${stop.headline}` };
    }
  }

  if (g.verdict === "CAUTION" || pending?.verdict === "CAUTION") {
    const why = [g.verdict === "CAUTION" && g.headline, pending?.verdict === "CAUTION" && pending.headline].filter(Boolean).join("; ");
    if (policy.ask) {
      const yes = await policy.ask(report, call, pending);
      return { report, pending, pendingStop: null, allowed: yes, verdict: "CAUTION", reason: yes ? `a human approved after CAUTION: ${why}` : `a human declined after CAUTION: ${why}` };
    }
    const allow = policy.onCaution === "allow";
    return { report, pending, pendingStop: null, allowed: allow, verdict: "CAUTION", reason: `${why}${allow ? " (policy: allow on CAUTION)" : " (policy: deny on CAUTION)"}` };
  }
  return { report, pending, pendingStop: null, allowed: true, verdict: "OK", reason: pending?.upgrades.length ? `${g.headline} ${pending.headline}` : g.headline };
}

export function guardCall<T>(accountId: string, call: GuardedCall, opts: GuardHatchOptions<T>): Promise<HatchedResult<T>>;
export function guardCall<T>(accountId: string, call: GuardedCall, opts: GuardOptions<T>): Promise<T>;
export async function guardCall<T>(accountId: string, call: GuardedCall, opts: GuardOptions<T> & { hatch?: AutoHatch }): Promise<T | HatchedResult<T>> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const what = `${accountId}.${call.methodName}(${call.args ? JSON.stringify(call.args).slice(0, 60) : ""})`;
  // Auto-hatch is a testnet feature: refuse the whole call up front, before anything is decided or sent.
  if (opts.hatch) {
    const net = await opts.hatch.provider.getNetworkId();
    if (net !== "testnet") throw new Error(`refused ${what}: auto-hatch is testnet-only and the provider is on ${net}`);
    if (!accountId.endsWith(".testnet")) throw new Error(`refused ${what}: auto-hatch is testnet-only and ${accountId} is not a .testnet account`);
    // The key is added through the owner's own connection, so that must be testnet too.
    const owner = opts.hatch.owner as { accountId: string; provider?: { getNetworkId?: () => Promise<string> } };
    if (!owner.accountId.endsWith(".testnet")) throw new Error(`refused ${what}: auto-hatch is testnet-only and the owner ${owner.accountId} is not a .testnet account`);
    const ownerNet = await owner.provider?.getNetworkId?.();
    if (ownerNet !== undefined && ownerNet !== "testnet") throw new Error(`refused ${what}: auto-hatch is testnet-only and the owner's connection is on ${ownerNet}`);
  }
  const d = await decide(accountId, call, opts.policy, { inspect: opts.inspect, report: opts.report, pending: opts.pending });
  const glyph = d.verdict === "OK" ? "[OK]" : d.verdict === "CAUTION" ? "[!!]" : "[XX]";
  if (!d.allowed) {
    log(`[guard] ${glyph} ${d.verdict} refused ${what}: ${d.reason}`);
    throw new GuardRefusal(`refused ${what}: ${d.reason}`, d.verdict, d.report, { pending: d.pendingStop, pendingCheck: d.pending });
  }
  log(`[guard] ${glyph} ${d.verdict} allowed ${what}${d.verdict === "OK" ? "" : ": " + d.reason}`);
  const result = await opts.execute(accountId, call);
  if (!opts.hatch) return result;

  const h = opts.hatch;
  try {
    const { armDelegateHatch } = await import("../../hatch/src/index.ts");
    const hatch = await armDelegateHatch({ owner: h.owner, provider: h.provider, venue: accountId, method: h.method, args: h.args, deposit: h.deposit, gas: h.gas, ttlBlocks: h.ttlBlocks, trigger: h.trigger });
    log(`[guard] hatch ${hatch.id} armed: ${hatch.account} -> ${accountId}.${hatch.method} (trigger ${hatch.trigger}, valid to block ${hatch.max_block_height})`);
    return { result, hatch, hatchError: null };
  } catch (e) {
    // The call already went through: return its result, and say loudly that no hatch exists.
    const err = String((e as Error)?.message ?? e);
    log(`[guard] [!!] the call succeeded but arming the hatch failed: ${err}`);
    return { result, hatch: null, hatchError: err };
  }
}
