// @keyhole/guard — a pre-call check for agents, enforced in code (not in a prompt).
//
//   await guardCall("vault.example.near", { methodName: "deposit", deposit: 1n }, { execute });
//
// STOP    → throws GuardRefusal; `execute` is never called.
// CAUTION → asks a human (policy.ask) or follows policy.onCaution ("allow" | "deny").
// OK      → executes.
// The verdict comes from @keyhole/core's deterministic grade on fresh public-RPC data.
import { inspect, type InspectOptions, type KeyholeReport, type Verdict } from "../../core/src/index.ts";

export interface GuardedCall {
  methodName: string;
  args?: unknown;
  deposit?: bigint | string;
  gas?: bigint | string;
}

export interface GuardPolicy {
  /** What to do on CAUTION when no `ask` is given. Default "deny" (fail closed). */
  onCaution?: "allow" | "deny";
  /** Ask a human on CAUTION; resolve true to proceed. */
  ask?: (report: KeyholeReport, call: GuardedCall) => Promise<boolean>;
  /** Pin the code hash the agent was configured against; any other hash is refused. */
  expectCodeHash?: string;
}

export interface GuardOptions<T> {
  execute: (accountId: string, call: GuardedCall) => Promise<T>;
  policy?: GuardPolicy;
  inspect?: InspectOptions;
  log?: (line: string) => void;
  /** Inject a report (tests). */
  report?: KeyholeReport;
}

export class GuardRefusal extends Error {
  readonly verdict: Verdict;
  readonly report: KeyholeReport;
  constructor(message: string, verdict: Verdict, report: KeyholeReport) {
    super(message);
    this.name = "GuardRefusal";
    this.verdict = verdict;
    this.report = report;
  }
}

export interface GuardDecision {
  allowed: boolean;
  verdict: Verdict;
  reason: string;
  report: KeyholeReport;
}

export async function decide(accountId: string, call: GuardedCall, policy: GuardPolicy = {}, opts: { inspect?: InspectOptions; report?: KeyholeReport } = {}): Promise<GuardDecision> {
  const report = opts.report ?? (await inspect(accountId, { history: false, ...opts.inspect }));
  const g = report.grade;
  const top = g.reasons.find((r) => r.severity === "stop") ?? g.reasons[0];
  if (policy.expectCodeHash && report.code?.hash !== policy.expectCodeHash) {
    return { allowed: false, verdict: "STOP", reason: `code hash ${report.code?.hash ?? "none"} is not the pinned ${policy.expectCodeHash}`, report };
  }
  if (g.verdict === "STOP") return { allowed: false, verdict: "STOP", reason: top?.text ?? g.headline, report };
  if (g.verdict === "CAUTION") {
    if (policy.ask) {
      const yes = await policy.ask(report, call);
      return { allowed: yes, verdict: "CAUTION", reason: yes ? "a human approved after CAUTION" : "a human declined after CAUTION", report };
    }
    const allow = policy.onCaution === "allow";
    return { allowed: allow, verdict: "CAUTION", reason: `${g.headline}${allow ? " (policy: allow on CAUTION)" : " (policy: deny on CAUTION)"}`, report };
  }
  return { allowed: true, verdict: "OK", reason: g.headline, report };
}

export async function guardCall<T>(accountId: string, call: GuardedCall, opts: GuardOptions<T>): Promise<T> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const d = await decide(accountId, call, opts.policy, { inspect: opts.inspect, report: opts.report });
  const glyph = d.verdict === "OK" ? "[OK]" : d.verdict === "CAUTION" ? "[!!]" : "[XX]";
  const what = `${accountId}.${call.methodName}(${call.args ? JSON.stringify(call.args).slice(0, 60) : ""})`;
  if (!d.allowed) {
    log(`[guard] ${glyph} ${d.verdict} refused ${what}: ${d.reason}`);
    throw new GuardRefusal(`refused ${what}: ${d.reason}`, d.verdict, d.report);
  }
  log(`[guard] ${glyph} ${d.verdict} allowed ${what}${d.verdict === "OK" ? "" : ": " + d.reason}`);
  return opts.execute(accountId, call);
}
