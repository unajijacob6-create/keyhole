// Upgrade radar: for each watched contract, watch every place a code change shows up before it
// lands, plus the change itself as a fallback.
//   1. Sputnik proposals of the DAO that controls it (UpgradeRemote / FunctionCall upgrade-like).
//   2. near-plugins staged code (up_staged_code_hash differs from the live hash).
//   3. The live code hash (post-deploy: too late to beat the change, but not always too late to
//      beat the drain, which usually needs a second transaction).
import {
  effectiveHash,
  inspect,
  listUpgradeProposals,
  stagedUpgrade,
  type Network,
  type Rpc,
  type StagedUpgrade,
  type UpgradeProposal,
} from "../../packages/core/src/index.ts";

export type RadarEvent =
  | { kind: "proposal"; target: string; dao: string; proposal: UpgradeProposal; first: boolean }
  | { kind: "staged"; target: string; staged: StagedUpgrade }
  | { kind: "deployed"; target: string; old_hash: string; new_hash: string };

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
}
export const emptyRadarState = (): RadarState => ({ proposals: {}, live: {}, staged: {} });

export class Radar {
  readonly controllers = new Map<string, Controller>();
  constructor(
    readonly rpc: Rpc,
    readonly network: Network,
    readonly state: RadarState = emptyRadarState(),
    readonly opts: { last?: number; nowMs?: () => number; resolve?: (t: string) => Promise<Controller> } = {},
  ) {}

  async watch(target: string): Promise<Controller> {
    let c = this.controllers.get(target);
    if (!c) {
      c = await (this.opts.resolve ?? ((t) => resolveController(t, { network: this.network, rpc: this.rpc })))(target);
      this.controllers.set(target, c);
    }
    return c;
  }

  /** Report this proposal again on the next tick (e.g. its bytes were not readable yet). */
  forget(dao: string, id: number): void {
    delete this.state.proposals[`${dao}#${id}`];
  }

  /** One pass over every watched target. Returns only what changed since the last pass. */
  async tick(): Promise<RadarEvent[]> {
    const events: RadarEvent[] = [];
    const nowMs = this.opts.nowMs?.() ?? Date.now();
    const daoTargets = new Map<string, Set<string>>();
    for (const c of this.controllers.values()) for (const d of c.daos) (daoTargets.get(d) ?? daoTargets.set(d, new Set()).get(d)!).add(c.target);

    for (const [dao, targets] of daoTargets) {
      const props = await listUpgradeProposals(this.rpc, dao, { last: this.opts.last ?? 20, nowMs });
      for (const p of props) {
        if (!targets.has(p.target)) continue;
        const key = `${dao}#${p.id}`;
        const seen = this.state.proposals[key];
        const stamp = `${p.status}/${p.state}/${p.votes.approve}`;
        if (seen === stamp) continue;
        this.state.proposals[key] = stamp;
        events.push({ kind: "proposal", target: p.target, dao, proposal: p, first: seen === undefined });
      }
    }
    for (const c of this.controllers.values()) {
      const v = await this.rpc.viewAccount(c.target);
      const hash = effectiveHash(v);
      const prev = this.state.live[c.target];
      this.state.live[c.target] = hash;
      if (prev && prev !== hash) events.push({ kind: "deployed", target: c.target, old_hash: prev, new_hash: hash });
      if (c.upgradable) {
        const s = await stagedUpgrade(this.rpc, c.target);
        const sh = s?.pending ? s.staged_hash : null;
        if (s && sh && this.state.staged[c.target] !== sh) events.push({ kind: "staged", target: c.target, staged: s });
        this.state.staged[c.target] = sh;
      }
    }
    return events;
  }
}
