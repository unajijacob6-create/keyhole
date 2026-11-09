// Upgrade radar: for each watched contract, watch every place a code change shows up before it
// lands, plus the change itself as a fallback.
//   1. Sputnik proposals of the DAO that controls it (UpgradeRemote / FunctionCall upgrade-like).
//   2. near-plugins staged code (up_staged_code_hash differs from the live hash).
//   3. The live code hash (post-deploy: too late to beat the change, but not always too late to
//      beat the drain, which usually needs a second transaction).
//
// A pass never loses news: scan() reads everything first and changes no state; the caller commits
// each event once it has handled it, so an event whose handling failed is reported again on the
// next pass. A target or DAO that cannot be read is reported once (an "unreadable" event) and does
// not stop the others.
import {
  effectiveHash,
  inspect,
  isLive,
  listUpgradeProposals,
  RpcAnswerError,
  stagedUpgrade,
  type Network,
  type Rpc,
  type StagedUpgrade,
  type UpgradeProposal,
} from "../../packages/core/src/index.ts";

/** A live code hash the radar read, and the block it read it at. */
export interface LiveSeen {
  hash: string;
  height: number | null;
}

export type RadarEvent =
  | {
      kind: "proposal";
      target: string;
      dao: string;
      proposal: UpgradeProposal;
      first: boolean;
      /** The target's live code as of the previous pass, before this proposal could have executed:
       *  the code an executed proposal replaced. null if the radar had not read it yet. */
      prev_live: LiveSeen | null;
    }
  | { kind: "staged"; target: string; staged: StagedUpgrade }
  | {
      kind: "deployed";
      target: string;
      old_hash: string;
      new_hash: string;
      /** Latest block at which the radar saw old_hash live (where the replaced code can be read). */
      old_height: number | null;
    }
  | {
      kind: "unreadable";
      /** The watched contract, or the DAO whose proposals could not be listed. */
      target: string;
      dao: string | null;
      error: string;
      /** The chain answered (e.g. the account does not exist); false for an outage or timeout. */
      missing: boolean;
    };

export interface Controller {
  target: string;
  /** Sputnik DAOs that Keyhole resolved as able to change the target (owner or near-plugins role). */
  daos: string[];
  upgradable: boolean;
}

/** Find the DAOs that control `target`, from Keyhole's own inspect (owner fields, ACL roles). */
export async function resolveController(target: string, o: { network: Network; rpc?: Rpc }): Promise<Controller> {
  const r = await inspect(target, { network: o.network, history: false, registry: false, sourceRoles: false, rpc: o.rpc });
  const daos = new Set<string>();
  for (const owner of r.owners) if (owner.actor?.dao) daos.add(owner.account);
  const exports = r.wasm?.exports ?? [];
  return { target, daos: [...daos], upgradable: exports.includes("up_staged_code_hash") };
}

export interface RadarState {
  /** dao#id -> last seen raw status, so status changes (votes, execution) are reported once. */
  proposals: Record<string, string>;
  /** target -> last seen live hash */
  live: Record<string, string>;
  /** target -> last seen staged hash */
  staged: Record<string, string | null>;
  /** target -> latest block at which `live[target]` was read. */
  live_height?: Record<string, number>;
  /** target or DAO -> the read error already reported by an "unreadable" event. */
  unreadable?: Record<string, string>;
}
export const emptyRadarState = (): RadarState => ({ proposals: {}, live: {}, staged: {}, live_height: {}, unreadable: {} });

export interface RadarScan {
  events: RadarEvent[];
  /** Apply the changes that carry no event (settled history at first sight, unchanged reads). */
  commitQuiet(): void;
  /** `ev` was handled: record it, so it is not reported again until something changes. */
  commit(ev: RadarEvent): void;
}

const pairKey = (dao: string, target: string) => `${dao}|${target}`;
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export class Radar {
  readonly controllers = new Map<string, Controller>();
  /** (dao, target) pairs whose proposals were read at least once. On the first read of a pair only
   *  proposals that can still execute are reported; settled ones are history. Per pair, so a target
   *  added while running does not replay its DAO's history as news. */
  private readonly primed = new Set<string>();
  /** What the latest scan read, committed or not (for "does this still hold?"). */
  private readonly observed = { proposals: new Map<string, UpgradeProposal>(), live: new Map<string, string>(), staged: new Map<string, string | null>() };
  constructor(
    readonly rpc: Rpc,
    readonly network: Network,
    readonly state: RadarState = emptyRadarState(),
    readonly opts: { last?: number; nowMs?: () => number; resolve?: (t: string) => Promise<Controller> } = {},
  ) {
    this.state.live_height ??= {};
    this.state.unreadable ??= {};
  }

  async watch(target: string): Promise<Controller> {
    let c = this.controllers.get(target);
    if (!c) {
      c = await (this.opts.resolve ?? ((t) => resolveController(t, { network: this.network, rpc: this.rpc })))(target);
      this.controllers.set(target, c);
    }
    return c;
  }

  /** Report this proposal again on the next pass. */
  forget(dao: string, id: number): void {
    delete this.state.proposals[`${dao}#${id}`];
  }

  /** `ev` as it stands after the latest scan, or null if what it reported no longer holds (the
   *  staged code was replaced or deployed, the live code moved on). */
  current(ev: RadarEvent): RadarEvent | null {
    if (ev.kind === "proposal") {
      const p = this.observed.proposals.get(`${ev.dao}#${ev.proposal.id}`);
      return p ? { ...ev, proposal: p } : ev;
    }
    if (ev.kind === "staged") {
      const s = this.observed.staged.get(ev.target);
      return s === undefined || s === ev.staged.staged_hash ? ev : null;
    }
    if (ev.kind === "deployed") {
      const l = this.observed.live.get(ev.target);
      return l === undefined || l === ev.new_hash ? ev : null;
    }
    return null;
  }

  /** Read every watched target and DAO. Changes no state until commitQuiet / commit. */
  async scan(): Promise<RadarScan> {
    const st = this.state;
    const liveHeight = st.live_height!;
    const unreadable = st.unreadable!;
    const events: RadarEvent[] = [];
    const quiet: (() => void)[] = [];
    const onCommit = new Map<RadarEvent, () => void>();
    const emit = (ev: RadarEvent, apply: () => void) => {
      events.push(ev);
      onCommit.set(ev, apply);
    };
    const nowMs = this.opts.nowMs?.() ?? Date.now();
    const failures: { key: string; dao: string | null; e: unknown }[] = [];

    // 1. Live code (and staged code) of every target, each on its own.
    const reads = new Map<string, { live: LiveSeen; staged: StagedUpgrade | null; upgradable: boolean }>();
    for (const c of this.controllers.values()) {
      try {
        const v = await this.rpc.viewAccount(c.target);
        const staged = c.upgradable ? await stagedUpgrade(this.rpc, c.target) : null;
        reads.set(c.target, { live: { hash: effectiveHash(v), height: Number.isSafeInteger(v.block_height) ? v.block_height : null }, staged, upgradable: c.upgradable });
      } catch (e) {
        failures.push({ key: c.target, dao: null, e });
      }
    }

    // 2. Proposals of every DAO that controls a readable target.
    const daoTargets = new Map<string, Set<string>>();
    for (const c of this.controllers.values()) {
      if (!reads.has(c.target)) continue; // unreadable this pass: its proposals wait for the next one
      for (const d of c.daos) (daoTargets.get(d) ?? daoTargets.set(d, new Set()).get(d)!).add(c.target);
    }
    for (const [dao, targets] of daoTargets) {
      let props: UpgradeProposal[];
      try {
        props = await listUpgradeProposals(this.rpc, dao, { last: this.opts.last ?? 20, nowMs });
      } catch (e) {
        failures.push({ key: dao, dao, e });
        continue;
      }
      if (unreadable[dao] !== undefined) quiet.push(() => delete unreadable[dao]);
      for (const p of props) {
        if (!targets.has(p.target)) continue;
        const key = `${dao}#${p.id}`;
        this.observed.proposals.set(key, p);
        const seen = st.proposals[key];
        const stamp = `${p.status}/${p.state}/${p.votes.approve}`;
        if (seen === stamp) continue;
        const record = () => (st.proposals[key] = stamp);
        // First read of this (dao, target) and the proposal can no longer execute: history, not news.
        if (seen === undefined && !this.primed.has(pairKey(dao, p.target)) && !isLive(p, nowMs)) {
          quiet.push(record);
          continue;
        }
        const prev = st.live[p.target];
        emit({ kind: "proposal", target: p.target, dao, proposal: p, first: seen === undefined, prev_live: prev === undefined ? null : { hash: prev, height: liveHeight[p.target] ?? null } }, record);
      }
      for (const t of targets) quiet.push(() => this.primed.add(pairKey(dao, t)));
    }

    // 3. Code changes and staged code, per readable target.
    for (const [target, r] of reads) {
      const { hash, height } = r.live;
      this.observed.live.set(target, hash);
      const prev = st.live[target];
      const setLive = () => {
        st.live[target] = hash;
        if (height !== null) liveHeight[target] = height;
        else delete liveHeight[target];
      };
      if (prev !== undefined && prev !== hash) emit({ kind: "deployed", target, old_hash: prev, new_hash: hash, old_height: liveHeight[target] ?? null }, setLive);
      else quiet.push(setLive);
      if (r.upgradable) {
        const s = r.staged;
        const sh = s?.pending ? s.staged_hash : null;
        this.observed.staged.set(target, sh);
        const setStaged = () => (st.staged[target] = sh);
        if (s && sh && st.staged[target] !== sh) emit({ kind: "staged", target, staged: s }, setStaged);
        else quiet.push(setStaged);
      }
      if (unreadable[target] !== undefined) quiet.push(() => delete unreadable[target]);
    }

    // 4. What could not be read: one event per target or DAO, until it reads again.
    for (const f of failures) {
      if (unreadable[f.key] !== undefined) continue;
      const error = errText(f.e);
      emit({ kind: "unreadable", target: f.key, dao: f.dao, error, missing: f.e instanceof RpcAnswerError }, () => (unreadable[f.key] = error));
    }

    let quietDone = false;
    return {
      events,
      commitQuiet: () => {
        if (quietDone) return;
        quietDone = true;
        for (const q of quiet) q();
      },
      commit: (ev) => {
        onCommit.get(ev)?.();
        onCommit.delete(ev);
      },
    };
  }

  /** One pass over every watched target, committed at once. Returns only what changed since the last pass. */
  async tick(): Promise<RadarEvent[]> {
    const s = await this.scan();
    s.commitQuiet();
    for (const ev of s.events) s.commit(ev);
    return s.events;
  }
}
