import { describe, expect, it } from "vitest";
import { codeHash, Rpc, type Transport } from "../../packages/core/src/index.ts";
import { Radar } from "../src/radar.ts";
import { Chain, policy as chainPolicy, upgradeRemote, V1, V2 } from "./chain.ts";

const DAO = "dao.testnet";
const VAULT = "vault.testnet";
const policy = {
  roles: [{ name: "council", kind: { Group: ["a.testnet", "b.testnet"] }, permissions: ["*:*"], vote_policy: {} }],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: "1", proposal_period: "604800000000000", bounty_bond: "1", bounty_forgiveness_period: "1",
};
const NOW = Date.parse("2026-11-10T00:00:00Z");
const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const H1 = "GHmAPqMjCHbj9PQcmp9Wjjh4WMRcBxq5vF9pFaYbFWsm";
const proposal = (id: number, status: string, approvals: number, ageMs = 60_000) => ({
  id, proposer: "a.testnet", description: "", status, submission_time: ns(NOW - ageMs),
  kind: { UpgradeRemote: { receiver_id: VAULT, method_name: "upgrade", hash: H1 } },
  vote_counts: approvals ? { council: [approvals, 0, 0] } : {}, votes: {},
});

/** A chain whose state the test mutates between ticks. */
function chain(state: { proposals: any[]; code: string }): Rpc {
  const transport: Transport = async (_url, body) => {
    const { params } = JSON.parse(body);
    const ok = (result: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: "k", result } });
    const view = (v: unknown) => ok({ result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [] });
    if (params.request_type === "view_account") return ok({ amount: "1", locked: "0", code_hash: state.code, storage_usage: 1, block_height: 1, block_hash: "x" });
    if (params.method_name === "get_last_proposal_id") return view(state.proposals.length);
    if (params.method_name === "get_policy") return view(policy);
    if (params.method_name === "get_proposals") {
      const a = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
      return view(state.proposals.slice(a.from_index, a.from_index + a.limit));
    }
    throw new Error(`unexpected ${body}`);
  };
  return new Rpc({ network: "testnet", transport, cache: false, retries: 0 });
}

describe("Radar", () => {
  it("treats settled history as background, reports open proposals, votes and the deploy", async () => {
    const st = { proposals: [proposal(0, "Approved", 2, 9 * 86400_000)], code: "OLD" };
    const radar = new Radar(chain(st), "testnet", undefined, { nowMs: () => NOW, resolve: async (t) => ({ target: t, daos: [DAO], upgradable: false }) });
    await radar.watch(VAULT);
    expect(await radar.tick()).toEqual([]); // executed long ago: not news

    st.proposals.push(proposal(1, "InProgress", 0));
    let ev = await radar.tick();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "proposal", first: true, proposal: { id: 1, state: "pending", required: 2, code_hash: H1 } });

    expect(await radar.tick()).toEqual([]); // nothing changed

    st.proposals[1] = proposal(1, "InProgress", 1);
    ev = await radar.tick();
    expect(ev[0]).toMatchObject({ kind: "proposal", first: false, proposal: { votes: { approve: 1 } } });

    st.proposals[1] = proposal(1, "Approved", 2);
    st.code = H1;
    ev = await radar.tick();
    expect(ev.map((e) => e.kind)).toEqual(["proposal", "deployed"]);
    expect(ev[1]).toMatchObject({ old_hash: "OLD", new_hash: H1 });
  });

  it("reports a proposal that is already open when the radar starts", async () => {
    const st = { proposals: [proposal(0, "InProgress", 1)], code: "OLD" };
    const radar = new Radar(chain(st), "testnet", undefined, { nowMs: () => NOW, resolve: async (t) => ({ target: t, daos: [DAO], upgradable: false }) });
    await radar.watch(VAULT);
    const ev = await radar.tick();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "proposal", proposal: { id: 0, state: "pending" } });
  });

  it("forget() re-reports a proposal on the next tick", async () => {
    const st = { proposals: [proposal(0, "InProgress", 0)], code: "OLD" };
    const radar = new Radar(chain(st), "testnet", undefined, { nowMs: () => NOW, resolve: async (t) => ({ target: t, daos: [DAO], upgradable: false }) });
    await radar.watch(VAULT);
    expect(await radar.tick()).toHaveLength(1);
    expect(await radar.tick()).toHaveLength(0);
    radar.forget(DAO, 0);
    expect(await radar.tick()).toHaveLength(1);
  });
});

describe("Radar on a mock chain: priming per (dao, target), isolation, commit after handling", () => {
  const VAULT2 = "vault2.testnet";
  const resolve = (daos: Record<string, string[]>) => async (t: string) => ({ target: t, daos: daos[t] ?? [], upgradable: false });

  it("a target added while running does not replay its DAO's settled history as news (#1)", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    c.setCode(VAULT2, V2);
    c.daos[DAO] = { policy: chainPolicy(), proposals: [upgradeRemote(0, VAULT, H1, "Approved", 2, 9 * 86400_000), upgradeRemote(1, VAULT2, H1, "Approved", 2, 9 * 86400_000)] };
    const radar = new Radar(c.rpc(), "testnet", undefined, { nowMs: () => NOW, resolve: resolve({ [VAULT]: [DAO], [VAULT2]: [DAO] }) });
    await radar.watch(VAULT);
    expect(await radar.tick()).toEqual([]);
    await radar.watch(VAULT2); // e.g. a hatch armed on a second contract of the same DAO
    expect(await radar.tick()).toEqual([]); // 9-day-old executed proposal for vault2: history
    // Something that happens after vault2 is watched is news, even if it settles between two passes.
    c.daos[DAO].proposals.push(upgradeRemote(2, VAULT2, H1, "Approved", 2));
    const ev = await radar.tick();
    expect(ev).toEqual([expect.objectContaining({ kind: "proposal", target: VAULT2, first: true, proposal: expect.objectContaining({ id: 2, state: "executed" }), prev_live: expect.objectContaining({ hash: await codeHash(V2) }) })]);
  });

  it("one DAO failing (HTTP 503) does not drop another DAO's news; the failure is reported once (#2, #3)", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    c.setCode(VAULT2, V1);
    c.daos["dao1.testnet"] = { policy: chainPolicy(), proposals: [] };
    c.daos["dao2.testnet"] = { policy: chainPolicy(), proposals: [] };
    const radar = new Radar(c.rpc(), "testnet", undefined, { nowMs: () => NOW, resolve: resolve({ [VAULT]: ["dao1.testnet"], [VAULT2]: ["dao2.testnet"] }) });
    await radar.watch(VAULT);
    await radar.watch(VAULT2);
    expect(await radar.tick()).toEqual([]);
    c.daos["dao1.testnet"].proposals.push(upgradeRemote(0, VAULT, H1, "InProgress", 0));
    c.fail = (p) => (p.account_id === "dao2.testnet" ? 503 : null);
    const ev = await radar.tick();
    expect(ev.map((e) => e.kind)).toEqual(["proposal", "unreadable"]);
    expect(ev[1]).toMatchObject({ kind: "unreadable", target: "dao2.testnet", dao: "dao2.testnet", missing: false });
    expect(await radar.tick()).toEqual([]); // reported once, not every pass
    c.fail = () => null;
    expect(await radar.tick()).toEqual([]); // recovered quietly
  });

  it("a missing venue account yields one alert and the other venues keep working (#3)", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    c.daos[DAO] = { policy: chainPolicy(), proposals: [] };
    const radar = new Radar(c.rpc(), "testnet", undefined, { nowMs: () => NOW, resolve: resolve({ [VAULT]: [DAO], "typo.testnet": [DAO] }) });
    await radar.watch(VAULT);
    await radar.watch("typo.testnet");
    const first = await radar.tick();
    expect(first).toEqual([expect.objectContaining({ kind: "unreadable", target: "typo.testnet", missing: true })]);
    c.daos[DAO].proposals.push(upgradeRemote(0, VAULT, H1, "InProgress", 0));
    expect(await radar.tick()).toEqual([expect.objectContaining({ kind: "proposal", target: VAULT, proposal: expect.objectContaining({ id: 0 }) })]);
    expect(await radar.tick()).toEqual([]);
  });

  it("scan() changes nothing until each event is committed: an unhandled event is reported again (#2)", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    c.daos[DAO] = { policy: chainPolicy(), proposals: [] };
    const radar = new Radar(c.rpc(), "testnet", undefined, { nowMs: () => NOW, resolve: resolve({ [VAULT]: [DAO] }) });
    await radar.watch(VAULT);
    await radar.tick();
    const v1Height = c.height;
    c.daos[DAO].proposals.push(upgradeRemote(0, VAULT, H1, "InProgress", 0));
    c.setCode(VAULT, V2);
    const s1 = await radar.scan();
    s1.commitQuiet();
    expect(s1.events.map((e) => e.kind)).toEqual(["proposal", "deployed"]);
    expect(s1.events[1]).toMatchObject({ old_hash: await codeHash(V1), new_hash: await codeHash(V2), old_height: v1Height });
    s1.commit(s1.events[0]); // the deployed event was not handled (e.g. the assessor threw)
    const s2 = await radar.scan();
    expect(s2.events.map((e) => e.kind)).toEqual(["deployed"]);
    s2.commitQuiet();
    s2.commit(s2.events[0]);
    expect(await radar.tick()).toEqual([]);
  });
});
