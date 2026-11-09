// Keyhole Guardian: radar events -> assessment -> alert -> fire the hatches whose trigger matches.
//
// What firing means: submitting a withdraw-to-self that the depositor signed in advance. The
// guardian cannot change what was signed (receiver, method, args, deposit are covered by the
// signature), so the worst a faulty guardian can do is exit the user early, or fail to exit.
import type { Rpc } from "../../packages/core/src/index.ts";
import type { Hatch } from "../../packages/hatch/src/index.ts";
import { assessPending, type AssessDeps, type Assessment } from "./assess.ts";
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
  /** Hatch ids already fired (persisted by the caller). */
  fired?: Set<string>;
  now?: () => Date;
  /** For tests: replace the assessor. */
  assessor?: typeof assessPending;
}

/** Should this hatch fire for this assessment? Pure, so the policy is testable on its own. */
export function shouldFire(h: Hatch, a: Assessment, ev: RadarEvent): boolean {
  if (h.venue !== a.target) return false;
  if (h.trigger === "manual") return false;
  if (h.trigger === "any-upgrade") return ev.kind !== "proposal" || ev.proposal.state === "pending" || ev.proposal.state === "executed";
  // "stop": only on the deterministic STOP verdict, and only while it can still matter: a pending
  // proposal, staged code, or code that already landed (the drain may still be ahead).
  if (!a.grade.fire) return false;
  if (ev.kind === "proposal") return ev.proposal.state === "pending" || ev.proposal.state === "executed";
  return true;
}

export class Guardian {
  readonly fired: Set<string>;
  /** pending hash -> assessment, so the same code is graded once. */
  readonly cache = new Map<string, Assessment>();
  private assessFn: typeof assessPending;
  constructor(readonly o: GuardianOptions) {
    this.fired = o.fired ?? new Set();
    this.assessFn = o.assessor ?? assessPending;
  }

  private now() {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  async watchHatches(): Promise<void> {
    for (const h of this.o.hatches()) await this.o.radar.watch(h.venue);
  }

  async handle(ev: RadarEvent): Promise<Alert> {
    let a: Assessment | null = null;
    let dao: string | null = null;
    let votesToExecute: number | null = null;
    if (ev.kind === "proposal") {
      dao = ev.dao;
      const p = ev.proposal;
      if (p.required !== null) votesToExecute = Math.max(0, p.required - p.votes.approve);
      if (p.code_hash && (p.state === "pending" || p.state === "executed")) {
        const key = `${p.target}:${p.code_hash}`;
        a = this.cache.get(key) ?? (await this.assessFn(this.o.assess, { target: p.target, hash: p.code_hash, dao, proposal: p, deployed: p.state === "executed" }));
        // Bytes not readable yet (the tx index lags a few seconds): grade again on the next tick.
        if (a.code_source || p.state !== "pending") this.cache.set(key, a);
        else this.o.radar.forget(dao, p.id);
      }
    } else if (ev.kind === "staged") {
      const key = `${ev.target}:${ev.staged.staged_hash}`;
      a = this.cache.get(key) ?? (await this.assessFn(this.o.assess, { target: ev.target, hash: ev.staged.staged_hash, staged: ev.staged }));
      this.cache.set(key, a);
    } else {
      const key = `${ev.target}:${ev.new_hash}`;
      a = this.cache.get(key) ?? (await this.assessFn(this.o.assess, { target: ev.target, hash: ev.new_hash, deployed: true }));
      this.cache.set(key, a);
    }

    const fired: FireResult[] = [];
    if (a && this.o.driver) {
      for (const h of this.o.hatches()) {
        if (this.fired.has(h.id) || !shouldFire(h, a, ev)) continue;
        const health = await this.o.driver.health(h);
        if (health.state !== "ARMED") {
          fired.push({ hatch: h.id, account: h.account, venue: h.venue, tx: null, ok: false, error: `not fired: hatch is ${health.state} (${health.reasons.join("; ")})`, at: this.now() });
          continue;
        }
        const r = await this.o.driver.fire(h);
        if (r.ok) this.fired.add(h.id);
        fired.push({ hatch: h.id, account: h.account, venue: h.venue, tx: r.tx, ok: r.ok, error: r.error, at: this.now() });
      }
    }
    const alert: Alert = {
      schema: "keyhole.alert/1",
      event: ev.kind,
      target: ev.target,
      dao,
      proposal_id: ev.kind === "proposal" ? ev.proposal.id : null,
      votes_to_execute: votesToExecute,
      assessment: a,
      fired,
      at: this.now(),
    };
    await this.o.onAlert?.(alert);
    return alert;
  }

  /** One radar pass; every event is assessed and acted on in order. */
  async tick(): Promise<Alert[]> {
    await this.watchHatches();
    const out: Alert[] = [];
    for (const ev of await this.o.radar.tick()) out.push(await this.handle(ev));
    return out;
  }
}
