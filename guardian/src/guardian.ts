// Keyhole Guardian: radar events -> assessment -> alert -> fire the hatches whose trigger matches.
//
// What firing means: submitting a withdraw-to-self that the depositor signed in advance. The
// guardian cannot change what was signed (receiver, method, args, deposit are covered by the
// signature), so the worst a faulty guardian can do is exit the user early, or fail to exit.
// Before relaying, the guardian checks that the signed bytes are what the record says (so a hatch
// that names one venue cannot run a call on another) and that the deposit it would pay is within
// its cap.
//
// An event whose handling keeps failing is retried with backoff for a bounded time, then reported
// once as CAUTION with ASSESSMENT_FAILED and committed. A failed relay is retried with backoff while
// its trigger still holds, for up to fireRetry.windowMs (default 30 minutes).
//
// State is kept in memory only: primed pairs, retry schedules and the last alerts are lost on a
// restart (the caller persists only the fired hatch ids).
import { isLive, type Rpc } from "../../packages/core/src/index.ts";
import { decodeHatch, verifyHatch, type Hatch } from "../../packages/hatch/src/index.ts";
import { assessPending, type AssessDeps, type Assessment, type ReplacedCode } from "./assess.ts";
import { Radar, type RadarEvent } from "./radar.ts";

export interface FireResult {
  hatch: string;
  account: string;
  venue: string;
  tx: string | null;
  ok: boolean;
  error?: string;
  at: string;
}

export interface Alert {
  schema: "keyhole.alert/1";
  event: RadarEvent["kind"];
  target: string;
  dao: string | null;
  proposal_id: number | null;
  /** Approvals still missing before the DAO executes it, when known. 1 = the next vote lands it. */
  votes_to_execute: number | null;
  assessment: Assessment | null;
  fired: FireResult[];
  /** For an "unreadable" event: what could not be read. For an ASSESSMENT_FAILED alert: the last
   *  error handling the event gave. */
  error?: string;
  /** Set on an alert that only reports a retried fire. */
  retry?: number;
  at: string;
}

export interface HatchDriver {
  health(h: Hatch): Promise<{ state: string; reasons: string[] }>;
  fire(h: Hatch): Promise<{ tx: string | null; ok: boolean; error?: string }>;
}

export interface GuardianOptions {
  rpc: Rpc;
  assess: AssessDeps;
  radar: Radar;
  hatches: () => Hatch[];
  driver: HatchDriver | null;
  /** Called for every alert (log, feed file, registry, notification). */
  onAlert?: (a: Alert) => void | Promise<void>;
  /** Called when handling one event failed; that event is reported again on the next tick. */
  onError?: (e: unknown, ev: RadarEvent | null) => void;
  /** Hatch ids already fired (persisted by the caller). */
  fired?: Set<string>;
  now?: () => Date;
  /** For tests: replace the assessor. */
  assessor?: typeof assessPending;
  /** Most yoctoNEAR a relayed hatch may attach (the relayer pays it). Default 1. */
  maxDeposit?: bigint;
  /** Pending code whose bytes cannot be read: how often to re-read before keeping the CAUTION. */
  unreadableRetry?: { attempts: number; baseMs: number; maxMs: number };
  /** A relay that failed (RPC error, relayer out of gas, health check error): retried with backoff
   *  (baseMs doubling to maxMs) while its trigger still holds, for up to windowMs after the first
   *  failure. Never after the hatch is USED / REVOKED / EXPIRED / STALE. */
  fireRetry?: RetryPolicy;
  /** Handling an event threw (assessment, relay, alert sink): re-tried with backoff for up to
   *  windowMs, then one CAUTION / ASSESSMENT_FAILED alert and the event is committed. */
  failureRetry?: RetryPolicy;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  windowMs: number;
}

export const DEFAULT_MAX_DEPOSIT = 1n;
export const DEFAULT_UNREADABLE_RETRY = { attempts: 10, baseMs: 2_000, maxMs: 60_000 };
export const DEFAULT_FIRE_RETRY: RetryPolicy = { baseMs: 3_000, maxMs: 60_000, windowMs: 30 * 60_000 };
export const DEFAULT_FAILURE_RETRY: RetryPolicy = { baseMs: 3_000, maxMs: 60_000, windowMs: 5 * 60_000 };

const backoff = (p: RetryPolicy, attempts: number) => Math.min(p.baseMs * 2 ** (attempts - 1), p.maxMs);
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/** Should this hatch fire for this assessment? Pure, so the policy is testable on its own. A
 *  proposal "can still matter" while it can execute (isLive: pending, or failed inside its period,
 *  which sputnikdao2 v3 re-executes on Finalize) and once it executed (the drain may be ahead). */
export function shouldFire(h: Hatch, a: Assessment, ev: RadarEvent, nowMs: number = Date.now()): boolean {
  if (ev.kind === "unreadable") return false;
  if (h.venue !== a.target) return false;
  if (h.trigger === "manual") return false;
  const matters = ev.kind !== "proposal" || isLive(ev.proposal, nowMs) || ev.proposal.state === "executed";
  if (h.trigger === "any-upgrade") return matters;
  // "stop": only on the deterministic STOP verdict, and only while it can still matter.
  return a.grade.fire && matters;
}

/** Why the guardian must not relay this hatch, or null. The record is only a label: what runs is
 *  the signed bytes, so they must match it, and the deposit the relayer would pay is capped. */
export function fireRefusal(h: Hatch, maxDeposit: bigint = DEFAULT_MAX_DEPOSIT): string | null {
  const v = verifyHatch(h);
  if (!v.ok) return `the record does not match its signed bytes (${v.checks.filter((c) => c.startsWith("FAIL")).join("; ")})`;
  let deposit: bigint;
  if (h.mode === "delegate") {
    let d: ReturnType<typeof decodeHatch>;
    try {
      d = decodeHatch(h);
    } catch (e) {
      return `the signed delegate does not decode: ${(e as Error).message}`;
    }
    if (d.receiverId !== h.venue) return `the signed call goes to ${d.receiverId}, not the venue ${h.venue}`;
    if (d.senderId !== h.account) return `the signed call is from ${d.senderId}, not ${h.account}`;
    deposit = d.actions.reduce((s, x) => s + BigInt(x.deposit), 0n);
  } else deposit = BigInt(h.deposit);
  if (deposit > maxDeposit) return `the signed call attaches ${deposit} yoctoNEAR, above the relay cap of ${maxDeposit} yoctoNEAR (raise it with --max-deposit)`;
  return null;
}

/** What an alert is about, for duplicate suppression. */
function subjectOf(ev: RadarEvent): string {
  if (ev.kind === "proposal") return `proposal:${ev.dao}#${ev.proposal.id}`;
  if (ev.kind === "staged") return `staged:${ev.target}:${ev.staged.staged_hash}`;
  if (ev.kind === "deployed") return `deployed:${ev.target}:${ev.new_hash}`;
  return `unreadable:${ev.target}`;
}

/** What a failure budget is about: the subject, and a proposal's state (executing it is news). */
const failureKey = (ev: RadarEvent) => (ev.kind === "proposal" ? `${subjectOf(ev)}:${ev.proposal.state}` : subjectOf(ev));

/** The assessment reported when assessing `ev` kept failing: CAUTION, nothing graded. */
function failedAssessment(ev: RadarEvent, error: string, attempts: number, minutes: number, at: string): Assessment | null {
  if (ev.kind === "unreadable") return null;
  const p = ev.kind === "proposal" ? ev.proposal : null;
  const hash = ev.kind === "proposal" ? ev.proposal.code_hash : ev.kind === "staged" ? ev.staged.staged_hash : ev.new_hash;
  const live = ev.kind === "deployed" ? ev.old_hash : ev.kind === "proposal" ? (ev.prev_live?.hash ?? "unknown") : "unknown";
  return {
    schema: "keyhole.assessment/1",
    target: ev.target,
    dao: ev.kind === "proposal" ? ev.dao : null,
    proposal: p,
    staged: ev.kind === "staged" ? ev.staged : null,
    live_hash: live,
    pending_hash: hash,
    code_source: null,
    pending_size: null,
    replaced: null,
    verified: { reproducible: null, sourcescan: null, registry_review: null },
    summary: [],
    grade: {
      verdict: "CAUTION",
      flags: ["ASSESSMENT_FAILED"],
      reasons: [{ severity: "caution", text: `The guardian could not assess this change (${attempts} attempt${attempts > 1 ? "s" : ""} over ${minutes} min; last error: ${error}). What the change does is unknown.` }],
      diff: null,
      fire: false,
      headline: `CAUTION: the change for ${ev.target} could not be assessed (${error.slice(0, 120)}).`,
    },
    review: null,
    at,
  };
}

export class Guardian {
  readonly fired: Set<string>;
  /** target:hash -> assessment, so the same code is graded once. */
  readonly cache = new Map<string, Assessment>();
  private assessFn: typeof assessPending;
  /** dao#id:hash -> re-read schedule for pending code whose bytes were not readable. */
  private readonly unreadable = new Map<string, { attempts: number; nextAt: number; last: Assessment }>();
  /** hatch id -> a fire that failed and is retried while its trigger still holds. */
  private readonly retryFires = new Map<string, { ev: RadarEvent; a: Assessment; attempts: number; firstAt: number; nextAt: number }>();
  /** subject -> signature of the last alert, so an unchanged re-report is not alerted twice. */
  private readonly lastAlert = new Map<string, string>();
  /** failureKey -> retry schedule of an event whose handling threw. */
  private readonly failures = new Map<string, { attempts: number; firstAt: number; nextAt: number }>();
  /** failureKey -> the ASSESSMENT_FAILED assessment kept once the failure budget ran out. */
  /** Gave up after the failure budget: the CAUTION is reused until `until`, then the event is
   *  assessed afresh (an outage must not stop a STOP hatch for the rest of a proposal's period). */
  private readonly gaveUp = new Map<string, { a: Assessment | null; error: string; until: number }>();
  /** target:new_hash -> the code a deployed event saw it replace. */
  private readonly replacedBy = new Map<string, ReplacedCode & { seenMs: number }>();
  constructor(readonly o: GuardianOptions) {
    this.fired = o.fired ?? new Set();
    this.assessFn = o.assessor ?? assessPending;
  }

  private nowMs() {
    return (this.o.now?.() ?? new Date()).getTime();
  }
  private now() {
    return new Date(this.nowMs()).toISOString();
  }

  async watchHatches(): Promise<void> {
    for (const h of this.o.hatches()) {
      try {
        await this.o.radar.watch(h.venue);
      } catch (e) {
        this.o.onError?.(e, null); // one hatch whose venue cannot be resolved does not stop the others
      }
    }
  }

  /** A cached assessment made against `base` (the code a change replaced), if there is one. */
  private cachedAgainst(key: string, base: ReplacedCode | null): Assessment | null {
    const c = this.cache.get(key);
    if (!c || !base || c.live_hash !== base.hash || !c.code_source || c.grade.flags.includes("REPLACED_CODE_UNAVAILABLE")) return null;
    return c;
  }

  /** Cache an after-the-change assessment, but never let one that compares the code with itself
   *  (NO_CHANGE) replace one made against the code it replaced. */
  private storeAfterChange(key: string, a: Assessment): void {
    const c = this.cache.get(key);
    if (c && a.pending_hash !== null && a.live_hash === a.pending_hash && c.live_hash !== a.pending_hash && c.code_source) return;
    if (!c || a.code_source) this.cache.set(key, a);
  }

  /** Assess `ev`. done = false: not finished (bytes not readable yet), report it again later. */
  private async assessEvent(ev: RadarEvent): Promise<{ a: Assessment | null; done: boolean }> {
    const nowMs = this.nowMs();
    if (ev.kind === "unreadable") return { a: null, done: true };
    if (ev.kind === "staged") {
      const key = `${ev.target}:${ev.staged.staged_hash}`;
      const a = this.cache.get(key) ?? (await this.assessFn(this.o.assess, { target: ev.target, hash: ev.staged.staged_hash, staged: ev.staged }));
      this.cache.set(key, a);
      return { a, done: true };
    }
    if (ev.kind === "deployed") {
      // Graded against the code it replaced: a pending-time assessment made against that code, or a
      // fresh one that reads it at the block where the radar last saw it live.
      const key = `${ev.target}:${ev.new_hash}`;
      const base = { hash: ev.old_hash, height: ev.old_height };
      this.replacedBy.set(key, { ...base, seenMs: this.nowMs() });
      const a = this.cachedAgainst(key, base) ?? (await this.assessFn(this.o.assess, { target: ev.target, hash: ev.new_hash, deployed: true, replaced: base }));
      this.storeAfterChange(key, a);
      return { a, done: true };
    }
    const p = ev.proposal;
    const live = isLive(p, nowMs);
    if (!p.code_hash || !(live || p.state === "executed")) return { a: null, done: true };
    const key = `${p.target}:${p.code_hash}`;
    if (p.state === "executed") {
      let base = ev.prev_live;
      if (base && base.hash === p.code_hash) {
        // The radar's last live read is already the new code: the deployed event of this change was
        // handled first (e.g. the DAO was unreadable, or this event failed, on the pass the code
        // changed). Grade against the code that change replaced, never the new code against itself.
        // Only a change seen after this proposal was submitted can be its own; an older change to the
        // same code (an earlier proposal) makes this one a no-op redeploy, and NO_CHANGE is right.
        const rec = this.replacedBy.get(key);
        const ownChange = rec && rec.seenMs >= p.submitted_at_ms ? rec : null;
        if (ownChange) base = { hash: ownChange.hash, height: ownChange.height };
        else if (!rec) {
          // No change to this code was seen: either the code was already live before the proposal
          // (a no-op upgrade, NO_CHANGE is right) or an earlier assessment made against other code.
          const c = this.cache.get(key);
          if (c && c.live_hash !== p.code_hash && c.code_source && !c.grade.flags.includes("REPLACED_CODE_UNAVAILABLE") && Date.parse(c.at) >= p.submitted_at_ms) return { a: c, done: true };
        }
      }
      const a = this.cachedAgainst(key, base) ?? (await this.assessFn(this.o.assess, { target: p.target, hash: p.code_hash, dao: ev.dao, proposal: p, deployed: true, replaced: base }));
      this.storeAfterChange(key, a);
      return { a, done: true };
    }
    const cached = this.cache.get(key);
    if (cached) return { a: cached, done: true };
    // Bytes not readable yet (the tx index lags a few seconds) or not at all: re-read with backoff,
    // then keep the CAUTION.
    const rkey = `${ev.dao}#${p.id}:${p.code_hash}`;
    const r = this.unreadable.get(rkey);
    if (r && nowMs < r.nextAt) return { a: r.last, done: false };
    const a = await this.assessFn(this.o.assess, { target: p.target, hash: p.code_hash, dao: ev.dao, proposal: p });
    const budget = this.o.unreadableRetry ?? DEFAULT_UNREADABLE_RETRY;
    const attempts = (r?.attempts ?? 0) + 1;
    if (a.code_source || attempts >= budget.attempts) {
      this.cache.set(key, a);
      this.unreadable.delete(rkey);
      return { a, done: true };
    }
    this.unreadable.set(rkey, { attempts, nextAt: nowMs + Math.min(budget.baseMs * 2 ** (attempts - 1), budget.maxMs), last: a });
    return { a, done: false };
  }

  /** Check, health-check and relay one hatch. A failed relay is retried on later ticks. */
  private async fireOne(h: Hatch, a: Assessment, ev: RadarEvent): Promise<FireResult> {
    const res = (tx: string | null, ok: boolean, error?: string): FireResult => ({ hatch: h.id, account: h.account, venue: h.venue, tx, ok, error, at: this.now() });
    const refusal = fireRefusal(h, this.o.maxDeposit ?? DEFAULT_MAX_DEPOSIT);
    if (refusal) {
      this.retryFires.delete(h.id);
      return res(null, false, `not fired: refused: ${refusal}`);
    }
    const prev = this.retryFires.get(h.id);
    const attempts = (prev?.attempts ?? 0) + 1;
    const failed = (r: FireResult) => {
      // Retried with backoff, while the trigger holds (retryFailedFires checks), within the window.
      const policy = this.o.fireRetry ?? DEFAULT_FIRE_RETRY;
      const nowMs = this.nowMs();
      const firstAt = prev?.firstAt ?? nowMs;
      const nextAt = nowMs + backoff(policy, attempts);
      if (nextAt - firstAt <= policy.windowMs) this.retryFires.set(h.id, { ev, a, attempts, firstAt, nextAt });
      else this.retryFires.delete(h.id);
      return r;
    };
    let health: { state: string; reasons: string[] };
    try {
      health = await this.o.driver!.health(h);
    } catch (e) {
      return failed(res(null, false, `not fired: health check failed: ${String((e as Error).message).slice(0, 200)}`));
    }
    if (health.state !== "ARMED") {
      // USED / REVOKED / EXPIRED / STALE do not come back: never retried, never fired twice.
      this.retryFires.delete(h.id);
      return res(null, false, `not fired: hatch is ${health.state} (${health.reasons.join("; ")})`);
    }
    let r: { tx: string | null; ok: boolean; error?: string };
    try {
      r = await this.o.driver!.fire(h);
    } catch (e) {
      r = { tx: null, ok: false, error: String((e as Error).message).slice(0, 200) };
    }
    if (r.ok) {
      this.fired.add(h.id);
      this.retryFires.delete(h.id);
      return res(r.tx, true, r.error);
    }
    return failed(res(r.tx, false, r.error));
  }

  private alertOf(ev: RadarEvent, a: Assessment | null, fired: FireResult[], error?: string): Alert {
    const p = ev.kind === "proposal" ? ev.proposal : null;
    return {
      schema: "keyhole.alert/1",
      event: ev.kind,
      target: ev.target,
      dao: ev.kind === "proposal" ? ev.dao : ev.kind === "unreadable" ? ev.dao : null,
      proposal_id: p ? p.id : null,
      votes_to_execute: p && p.required !== null ? Math.max(0, p.required - p.votes.approve) : null,
      assessment: a,
      fired,
      ...(ev.kind === "unreadable" ? { error: ev.error } : error !== undefined ? { error } : {}),
      at: this.now(),
    };
  }

  /** Assess, fire, alert. Returns the alert (null when it would repeat the last one unchanged) and
   *  whether the event is finished (commit it) or must be reported again. With `failed`, the
   *  failure budget ran out: report that assessment (ASSESSMENT_FAILED) instead of assessing. */
  async process(ev: RadarEvent, failed?: { a: Assessment | null; error: string }): Promise<{ alert: Alert | null; done: boolean }> {
    const { a, done } = failed ? { a: failed.a, done: true } : await this.assessEvent(ev);
    const fired: FireResult[] = [];
    if (a && this.o.driver) {
      const nowMs = this.nowMs();
      for (const h of this.o.hatches()) {
        if (this.fired.has(h.id) || !shouldFire(h, a, ev, nowMs)) continue;
        const rf = this.retryFires.get(h.id);
        if (rf && nowMs < rf.nextAt) continue; // a failed relay is backing off; retryFailedFires owns it
        fired.push(await this.fireOne(h, a, ev));
      }
    }
    const alert = this.alertOf(ev, a, fired, failed?.error);
    const subject = subjectOf(ev);
    const p = ev.kind === "proposal" ? ev.proposal : null;
    const sig = JSON.stringify([p && `${p.status}/${p.state}/${p.votes.approve}`, a?.pending_hash, a?.grade.verdict, a?.grade.flags, a?.code_source?.kind ?? null, ev.kind === "unreadable" ? ev.error : (failed?.error ?? null)]);
    if (!fired.length && this.lastAlert.get(subject) === sig) return { alert: null, done };
    await this.o.onAlert?.(alert);
    this.lastAlert.set(subject, sig);
    return { alert, done };
  }

  /** Handle one event (no radar commit). Null when the alert would repeat the last one. */
  async handle(ev: RadarEvent): Promise<Alert | null> {
    return (await this.process(ev)).alert;
  }

  /** Re-try fires that failed, while what triggered them still holds. */
  private async retryFailedFires(skip: Set<string>): Promise<Alert[]> {
    const out: Alert[] = [];
    if (!this.o.driver || !this.retryFires.size) return out;
    const hatches = new Map(this.o.hatches().map((h) => [h.id, h]));
    const nowMs = this.nowMs();
    for (const [id, rf] of [...this.retryFires]) {
      if (skip.has(id)) continue;
      const h = hatches.get(id);
      const cur = this.o.radar.current(rf.ev);
      if (!h || this.fired.has(id) || !cur || !shouldFire(h, rf.a, cur, nowMs)) {
        this.retryFires.delete(id);
        continue;
      }
      if (nowMs < rf.nextAt) continue; // backing off
      try {
        const fr = await this.fireOne(h, rf.a, cur);
        const alert = { ...this.alertOf(cur, rf.a, [fr]), retry: rf.attempts + 1 };
        await this.o.onAlert?.(alert);
        out.push(alert);
      } catch (e) {
        this.o.onError?.(e, cur);
      }
    }
    return out;
  }

  /** One radar pass; every event is assessed and acted on in order, each on its own: an event whose
   *  handling throws is not committed, so the radar reports it again; it is retried with backoff
   *  (skipped, not committed, until its next attempt is due) until failureRetry.windowMs after its
   *  first failure, then reported once as CAUTION / ASSESSMENT_FAILED and committed. */
  async tick(): Promise<Alert[]> {
    await this.watchHatches();
    const scan = await this.o.radar.scan();
    scan.commitQuiet();
    const out: Alert[] = [];
    const before = new Map([...this.retryFires].map(([id, r]) => [id, r.attempts]));
    const policy = this.o.failureRetry ?? DEFAULT_FAILURE_RETRY;
    const seen = new Set<string>();
    for (const ev of scan.events) {
      const fk = failureKey(ev);
      seen.add(fk);
      const nowMs = this.nowMs();
      const f = this.failures.get(fk);
      if (f && nowMs < f.nextAt) continue; // backing off: reported again by the radar, not committed
      const g = this.gaveUp.get(fk);
      if (g && nowMs >= g.until) this.gaveUp.delete(fk);
      try {
        const r = await this.process(ev, g && nowMs < g.until ? g : undefined);
        this.failures.delete(fk);
        if (r.done) scan.commit(ev);
        if (r.alert) out.push(r.alert);
      } catch (e) {
        this.o.onError?.(e, ev);
        const attempts = (f?.attempts ?? 0) + 1;
        const firstAt = f?.firstAt ?? nowMs;
        const nextAt = nowMs + backoff(policy, attempts);
        if (nextAt - firstAt <= policy.windowMs) {
          this.failures.set(fk, { attempts, firstAt, nextAt });
          continue;
        }
        // Budget spent: one alert that says the change could not be assessed, then commit.
        this.failures.delete(fk);
        const error = errText(e);
        const failed = { a: failedAssessment(ev, error, attempts, Math.round((nowMs - firstAt) / 60_000), this.now()), error, until: nowMs + policy.windowMs };
        this.gaveUp.set(fk, failed);
        try {
          const r = await this.process(ev, failed);
          if (r.alert) out.push(r.alert);
        } catch (e2) {
          this.o.onError?.(e2, ev);
        }
        scan.commit(ev);
      }
    }
    // An event missing from one pass (its DAO unreadable, say) keeps its budget; only long-gone ones are dropped.
    for (const [k, f] of [...this.failures]) if (!seen.has(k) && this.nowMs() - f.firstAt > 2 * policy.windowMs) this.failures.delete(k);
    // Hatches already attempted in this tick (their retry count moved) wait for the next one.
    const attempted = new Set([...this.retryFires].filter(([id, r]) => before.get(id) !== r.attempts).map(([id]) => id));
    out.push(...(await this.retryFailedFires(attempted)));
    return out;
  }
}
