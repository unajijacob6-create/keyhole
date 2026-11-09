// assessPending on a mock chain (offline): after-the-change grading uses the replaced code (#0),
// and FunctionCall proposals that carry the wasm inline are graded from those bytes (#5).
import { describe, expect, it } from "vitest";
import { codeHash, listUpgradeProposals } from "../../packages/core/src/index.ts";
import { assessPending } from "../src/assess.ts";
import { argsCodeProposal, Chain, emptyTxApi, NOW, policy, V1, V2 } from "./chain.ts";

const VAULT = "vault.testnet";
const DAO = "dao.testnet";

async function deployedChain() {
  const c = new Chain();
  c.setCode(VAULT, V1);
  c.advance(5);
  const v1Height = c.height;
  c.setCode(VAULT, V2); // the change already happened
  c.advance(5);
  return { c, v1Height, h1: await codeHash(V1), h2: await codeHash(V2) };
}

describe("assessPending after the change (deployed / executed)", () => {
  it("grades against the code it replaced, read at the block where the radar last saw it: v1 -> v2 is STOP", async () => {
    const { c, v1Height, h1, h2 } = await deployedChain();
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: h2, deployed: true, replaced: { hash: h1, height: v1Height } });
    expect(a.grade.verdict).toBe("STOP");
    expect(a.grade.fire).toBe(true);
    expect(a.grade.flags).toContain("NEW_MONEY_PATH");
    expect(a.grade.flags).not.toContain("NO_CHANGE");
    expect(a.live_hash).toBe(h1);
    expect(a.replaced).toEqual({ hash: h1, height: v1Height, readable: true });
    expect(a.code_source).toEqual({ kind: "deployed" });
    expect(a.summary.join(" ")).toMatch(/sweep/);
  });

  it("never says OK 'already live' when the replaced code is unknown: CAUTION with REPLACED_CODE_UNAVAILABLE", async () => {
    const { c, h2 } = await deployedChain();
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: h2, deployed: true });
    expect(a.grade.verdict).toBe("CAUTION");
    expect(a.grade.flags).toEqual(["UNVERIFIED_PENDING_CODE", "REPLACED_CODE_UNAVAILABLE"]);
    expect(a.grade.fire).toBe(false);
    expect(a.grade.headline).toMatch(/replaced on vault\.testnet could not be read/);
    expect(a.grade.diff).toBeNull();
    expect(a.live_hash).toBe("unknown");
  });

  it("reads the replaced code from the archival RPC when the regular node no longer has that block", async () => {
    const { c, v1Height, h1, h2 } = await deployedChain();
    c.gcBelow = c.height;
    const without = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: h2, deployed: true, replaced: { hash: h1, height: v1Height } });
    expect(without.grade.flags).toContain("REPLACED_CODE_UNAVAILABLE");
    expect(without.replaced).toEqual({ hash: h1, height: v1Height, readable: false });
    const withArchival = await assessPending({ rpc: c.rpc(), archival: c.rpc({ archival: true }), api: emptyTxApi }, { target: VAULT, hash: h2, deployed: true, replaced: { hash: h1, height: v1Height } });
    expect(withArchival.grade.verdict).toBe("STOP");
  });

  it("does not accept bytes that do not hash to the replaced hash", async () => {
    const { c, h1, h2 } = await deployedChain();
    // At this height v2 is live, not v1: the read must be refused.
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: h2, deployed: true, replaced: { hash: h1, height: c.height } });
    expect(a.grade.flags).toContain("REPLACED_CODE_UNAVAILABLE");
    expect(a.grade.verdict).toBe("CAUTION");
  });

  it("an executed proposal whose upgrade receipt has not landed yet compares against the live code", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    const h1 = await codeHash(V1);
    c.daos[DAO] = { policy: policy(), proposals: [argsCodeProposal(0, VAULT, V2, "Approved", 1)] };
    const [p] = await listUpgradeProposals(c.rpc(), DAO, { nowMs: NOW });
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: p.code_hash, dao: DAO, proposal: p, deployed: true, replaced: { hash: h1, height: c.height } });
    expect(a.grade.verdict).toBe("STOP");
    expect(a.live_hash).toBe(h1);
  });
});

describe("assessPending: FunctionCall proposal carrying the wasm in its args (hash_from args-code)", () => {
  it("grades the inline bytes instead of PENDING_CODE_UNAVAILABLE", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    c.daos[DAO] = { policy: policy(), proposals: [argsCodeProposal(0, VAULT, V2, "InProgress", 0)] };
    const [p] = await listUpgradeProposals(c.rpc(), DAO, { nowMs: NOW });
    expect(p).toMatchObject({ hash_from: "args-code", code_hash: await codeHash(V2) });
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: p.code_hash, dao: DAO, proposal: p });
    expect(a.code_source).toEqual({ kind: "proposal_args", dao: DAO, id: 0 });
    expect(a.pending_size).toBe(V2.length);
    expect(a.grade.flags).not.toContain("PENDING_CODE_UNAVAILABLE");
    expect(a.grade.verdict).toBe("STOP");
  });

  it("pending bytes that do not parse as wasm are a CAUTION with PENDING_CODE_INVALID_WASM, not a throw (L1)", async () => {
    const c = new Chain();
    c.setCode(VAULT, V1);
    // The wasm header, then an export section cut short: analyzeWasm throws "unexpected end".
    const junk = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7, 0x10, 3, 9, 9]);
    c.daos[DAO] = { policy: policy(), proposals: [argsCodeProposal(0, VAULT, junk, "InProgress", 0)] };
    const [p] = await listUpgradeProposals(c.rpc(), DAO, { nowMs: NOW });
    expect(p.code_hash).toBe(await codeHash(junk));
    const a = await assessPending({ rpc: c.rpc(), api: emptyTxApi }, { target: VAULT, hash: p.code_hash, dao: DAO, proposal: p });
    expect(a.code_source).toEqual({ kind: "proposal_args", dao: DAO, id: 0 });
    expect(a.pending_size).toBe(junk.length);
    expect(a.grade.verdict).toBe("CAUTION");
    expect(a.grade.fire).toBe(false);
    expect(a.grade.flags).toEqual(["UNVERIFIED_PENDING_CODE", "PENDING_CODE_INVALID_WASM"]);
    expect(a.grade.headline).toMatch(/not a valid wasm module/);
    expect(a.grade.reasons.map((r) => r.text).join(" ")).toMatch(new RegExp(`\\(${junk.length} bytes\\) was read, but it is not a valid wasm module \\(unexpected end\\)`));
    expect(a.grade.diff).toBeNull();
  });
});
