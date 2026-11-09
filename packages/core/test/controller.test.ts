import { describe, it, expect } from "vitest";
import { analyzeSputnikPolicy, sputnikRequired } from "../src/controller.ts";

describe("Sputnik thresholds (sputnikdao2 policy.rs to_weight)", () => {
  it("ratio: min(total*n/d + 1, total)", () => {
    expect(sputnikRequired([1, 2], "0", 5)).toBe(3);
    expect(sputnikRequired([1, 2], "0", 4)).toBe(3);
    expect(sputnikRequired([1, 2], "0", 1)).toBe(1);
    expect(sputnikRequired([2, 5], "0", 5)).toBe(3);
  });
  it("absolute weight is capped at the group size; quorum is a floor", () => {
    expect(sputnikRequired("3", "0", 5)).toBe(3);
    expect(sputnikRequired("9", "0", 5)).toBe(5);
    expect(sputnikRequired([1, 10], "2", 5)).toBe(2);
  });
});

describe("analyzeSputnikPolicy", () => {
  it("takes the weakest relevant proposal kind across roles", () => {
    const dao = analyzeSputnikPolicy({
      roles: [{ name: "council", kind: { Group: ["a", "b", "c", "d", "e"] }, permissions: ["*:*"], vote_policy: { call: { weight_kind: "RoleWeight", quorum: "0", threshold: "3" }, policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" } } }],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    });
    expect(dao.requiredApprovals).toBe(2);
    expect(dao.proposalKind).toBe("policy");
  });
  it("ignores the Everyone role: Sputnik skips it when counting approvals", () => {
    // Shape of stader-nearx.sputnik-dao.near's policy (2026-11-09): Everyone may VoteApprove, but
    // sputnikdao2 proposal_status() does `RoleKind::Everyone => continue`.
    const dao = analyzeSputnikPolicy({
      roles: [
        { name: "all", kind: "Everyone", permissions: ["call:VoteApprove", "policy:VoteApprove", "*:AddProposal"], vote_policy: {} },
        { name: "council", kind: { Group: ["a", "b", "c", "d", "e"] }, permissions: ["*:VoteApprove"], vote_policy: { call: { weight_kind: "RoleWeight", quorum: "0", threshold: [2, 5] } } },
      ],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    });
    expect(dao.everyoneCanApprove).toBe(true);
    expect(dao.requiredApprovals).toBe(3);
    expect(dao.roleName).toBe("council");
  });
  it("token-weighted roles are flagged, not counted as a head count", () => {
    const dao = analyzeSputnikPolicy({ roles: [{ name: "holders", kind: { Member: "1" }, permissions: ["*:*"], vote_policy: {} }], default_vote_policy: { weight_kind: "TokenWeight", quorum: "0", threshold: [1, 2] } });
    expect(dao.tokenWeighted).toBe(true);
    expect(dao.requiredApprovals).toBeNull();
  });
  it("a role that cannot approve calls or upgrades is not a path", () => {
    const dao = analyzeSputnikPolicy({ roles: [{ name: "x", kind: { Group: ["a"] }, permissions: ["transfer:VoteApprove"], vote_policy: {} }], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] } });
    expect(dao.requiredApprovals).toBeNull();
  });
});

import { deployerRolesFromSource } from "../src/controller.ts";
describe("deployerRolesFromSource", () => {
  it("reads code_deployers from the declared source at the declared rev", async () => {
    const seen: string[] = [];
    const src = `#[upgradable(access_control_roles(\n    code_stagers(Role::StagingManager),\n    code_deployers(Role::UpgradeManager, Role::DAO),\n))]`;
    const r = await deployerRolesFromSource({ owner: "o", repo: "r", rev: "abc1234" }, "contract", async (u) => (seen.push(u), src));
    expect(seen[0]).toBe("https://raw.githubusercontent.com/o/r/abc1234/contract/src/lib.rs");
    expect(r?.roles).toEqual(["UpgradeManager", "DAO"]);
  });
  it("returns null without a pinned rev or without the attribute", async () => {
    expect(await deployerRolesFromSource({ owner: "o", repo: "r", rev: null }, "", async () => "x")).toBeNull();
    expect(await deployerRolesFromSource({ owner: "o", repo: "r", rev: "abc1234" }, "", async () => "fn main() {}")).toBeNull();
  });
});
