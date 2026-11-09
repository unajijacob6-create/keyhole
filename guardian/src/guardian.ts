// Keyhole Guardian: radar events -> assessment -> alert -> fire the hatches whose trigger matches.
//
// What firing means: submitting a withdraw-to-self that the depositor signed in advance. The
// guardian cannot change what was signed (receiver, method, args, deposit are covered by the
// signature), so the worst a faulty guardian can do is exit the user early, or fail to exit.
// Before relaying, the guardian checks that the signed bytes are what the record says (so a hatch
// that names one venue cannot run a call on another) and that the deposit it would pay is within
// its cap.
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
  /** For an "unreadable" event: what could not be read. */
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
  /** Attempts per hatch when the relay fails (RPC error, relayer out of gas). Default 5. */
  fireAttempts?: number;
}

export const DEFAULT_MAX_DEPOSIT = 1n;
export const DEFAULT_UNREADABLE_RETRY = { attempts: 10, baseMs: 2_000, maxMs: 60_000 };
export const DEFAULT_FIRE_ATTEMPTS = 5;

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

export class Guardian {
  readonly fired: Set<string>;
  /** target:hash -> assessment, so the same code is graded once. */
  readonly cache = new Map<string, Assessment>();
  private assessFn: typeof assessPending;
  /** dao#id:hash -> re-read schedule for pending code whose bytes were not readable. */
  private readonly unreadable = new Map<string, { attempts: number; nextAt: number; last: Assessment }>();
  /** hatch id -> a fire that failed and is retried while its trigger still holds. */
  private readonly retryFires = new Map<string, { ev: RadarEvent; a: Assessment; attempts: number }>();
  /** subject -> signature of the last alert, so an unchanged re-report is not alerted twice. */
  private readonly lastAlert = new Map<string, string>();
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
      const a = this.cachedAgainst(key, base) ?? (await this.assessFn(this.o.assess, { target: ev.target, hash: ev.new_hash, deployed: true, replaced: base }));
      if (!this.cache.has(key) || a.code_source) this.cache.set(key, a);
      return { a, done: true };
    }
    const p = ev.proposal;
    const live = isLive(p, nowMs);
    if (!p.code_hash || !(live || p.state === "executed")) return { a: null, done: true };
    const key = `${p.target}:${p.code_hash}`;
    if (p.state === "executed") {
      const base = ev.prev_live;
      const a = this.cachedAgainst(key, base) ?? (await this.assessFn(this.o.assess, { target: p.target, hash: p.code_hash, dao: ev.dao, proposal: p, deployed: true, replaced: base }));
      if (!this.cache.has(key) || a.code_source) this.cache.set(key, a);
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
    const attempts = (this.retryFires.get(h.id)?.attempts ?? 0) + 1;
    const failed = (r: FireResult) => {
      if (attempts < (this.o.fireAttempts ?? DEFAULT_FIRE_ATTEMPTS)) this.retryFires.set(h.id, { ev, a, attempts });
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

  private alertOf(ev: RadarEvent, a: Assessment | null, fired: FireResult[]): Alert {
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
      ...(ev.kind === "unreadable" ? { error: ev.error } : {}),
      at: this.now(),
    };
  }

  /** Assess, fire, alert. Returns the alert (null when it would repeat the last one unchanged) and
   *  whether the event is finished (commit it) or must be reported again. */
  async process(ev: RadarEvent): Promise<{ alert: Alert | null; done: boolean }> {
    const { a, done } = await this.assessEvent(ev);
    const fired: FireResult[] = [];
    if (a && this.o.driver) {
      const nowMs = this.nowMs();
      for (const h of this.o.hatches()) {
        if (this.fired.has(h.id) || !shouldFire(h, a, ev, nowMs)) continue;
        fired.push(await this.fireOne(h, a, ev));
      }
    }
    const alert = this.alertOf(ev, a, fired);
    const subject = subjectOf(ev);
    const p = ev.kind === "proposal" ? ev.proposal : null;
    const sig = JSON.stringify([p && `${p.status}/${p.state}/${p.votes.approve}`, a?.pending_hash, a?.grade.verdict, a?.grade.flags, a?.code_source?.kind ?? null, ev.kind === "unreadable" ? ev.error : null]);
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
   *  handling throws is not committed, so the radar reports it again next tick. */
  async tick(): Promise<Alert[]> {
    await this.watchHatches();
    const scan = await this.o.radar.scan();
    scan.commitQuiet();
    const out: Alert[] = [];
    const before = new Map([...this.retryFires].map(([id, r]) => [id, r.attempts]));
    for (const ev of scan.events) {
      try {
        const r = await this.process(ev);
        if (r.done) scan.commit(ev);
        if (r.alert) out.push(r.alert);
      } catch (e) {
        this.o.onError?.(e, ev);
      }
    }
    // Hatches already attempted in this tick (their retry count moved) wait for the next one.
    const attempted = new Set([...this.retryFires].filter(([id, r]) => before.get(id) !== r.attempts).map(([id]) => id));
    out.push(...(await this.retryFailedFires(attempted)));
    return out;
  }
}
