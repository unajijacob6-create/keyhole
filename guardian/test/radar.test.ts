import { describe, expect, it } from "vitest";
import { Rpc, type Transport } from "../../packages/core/src/index.ts";
import { Radar } from "../src/radar.ts";

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
