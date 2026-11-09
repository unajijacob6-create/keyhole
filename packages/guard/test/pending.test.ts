// guardCall's pending-upgrade check on an offline fake chain: a vault owned by a 2-of-2 Sputnik DAO
// whose proposals and store_blob bytes the test controls.
import { describe, expect, it, vi } from "vitest";
import { codeHash, type KeyholeReport } from "../../core/src/index.ts";
import { checkPendingUpgrades, decide, guardCall, GuardRefusal, type PendingDeps } from "../src/index.ts";
import { DAO, NOW, VAULT, borshSome, daoViews, fakeChain, fakeTxApi, proposal, wasm, type ChainState } from "./fake-chain.ts";

const LIVE = wasm("guarded_vault.wasm");
const SWEEP = wasm("guarded_vault_evil_sweep.wasm"); // adds sweep() reaching transfer: STOP when unverified
const BENIGN = wasm("guarded_vault_benign_v2.wasm"); // adds a view: CAUTION when unverified
const MISSING = "GHmAPqMjCHbj9PQcmp9Wjjh4WMRcBxq5vF9pFaYbFWsm"; // a hash nobody stored

/** What inspect reports for the vault, reduced to what the guard reads: OK on the live code,
 *  owner = the DAO. Isolates the pending check from the base grade. */
const report = (o: { exports?: string[] } = {}): KeyholeReport =>
  ({
    schema: "keyhole.report/1",
    account: VAULT,
    network: "testnet",
    code: { hash: "LIVE" },
    owners: [{ account: DAO, source: "get_owner()", actor: { account: DAO, dao: { kind: "sputnik", requiredApprovals: 2 } } }],
    wasm: { exports: o.exports ?? ["deposit", "withdraw_all", "get_owner", "upgrade"] },
    grade: { verdict: "OK", class: "GOVERNED", flags: [], headline: "OK: governed by a 2-of-2 DAO", reasons: [{ code: "X", severity: "ok", text: "governed", evidence: [] }] },
  }) as unknown as KeyholeReport;

function setup(proposals: any[], blobs: Uint8Array[], extra: Partial<ChainState> = {}) {
  const state: ChainState = { accounts: { [VAULT]: { code: LIVE }, [DAO]: { code: new Uint8Array([0, 0x61, 0x73, 0x6d]) } }, views: { [DAO]: daoViews(proposals) }, ...extra };
  const chain = fakeChain(state);
  const api = fakeTxApi(DAO, blobs);
  const pending: PendingDeps = { rpc: chain.rpc, api, registry: null, nowMs: NOW };
  return { chain, api, pending, state };
}
const quiet = { log: () => {} };

describe("guardCall pending-upgrade check", () => {
  it("a live proposal graded STOP refuses, never executes, and names the DAO, proposal, hash and headline", async () => {
    const h = await codeHash(SWEEP);
    const { pending } = setup([proposal(0, "InProgress", h, { approvals: 1 })], [SWEEP]);
    const execute = vi.fn();
    const err: any = await guardCall(VAULT, { methodName: "deposit", deposit: 1n }, { execute, report: report(), pending, policy: { onCaution: "allow" }, ...quiet }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(execute).not.toHaveBeenCalled();
    expect(err.verdict).toBe("STOP");
    expect(err.message).toContain(DAO);
    expect(err.message).toContain("proposal #0");
    expect(err.message).toContain(h);
    expect(err.message).toMatch(/STOP: unverified code for vault\.testnet adds a new path to move funds/);
    expect(err.pending).toMatchObject({ source: "proposal", dao: DAO, proposal_id: 0, pending_hash: h, verdict: "STOP", state: "pending", votes: { approve: 1, required: 2 }, code_source: { kind: "store_blob", tx: "TX0" } });
    expect(err.pending.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_MONEY_PATH"]);
    expect(err.pending.headline).toBe(err.pending.assessment.grade.headline);
    expect(err.pendingCheck.verdict).toBe("STOP");
  });

  it("a live proposal graded CAUTION goes to the CAUTION policy: deny by default, ask when configured", async () => {
    const h = await codeHash(BENIGN);
    const { pending } = setup([proposal(0, "InProgress", h)], [BENIGN]);
    const execute = vi.fn().mockResolvedValue("tx");
    await expect(guardCall(VAULT, { methodName: "deposit" }, { execute, report: report(), pending, ...quiet })).rejects.toThrow(/pending upgrade CAUTION.*deny on CAUTION/);
    expect(execute).not.toHaveBeenCalled();

    const ask = vi.fn().mockResolvedValue(true);
    expect(await guardCall(VAULT, { methodName: "deposit" }, { execute, report: report(), pending, policy: { ask }, ...quiet })).toBe("tx");
    expect(ask).toHaveBeenCalledOnce();
    const passed = ask.mock.calls[0][2];
    expect(passed.upgrades[0]).toMatchObject({ verdict: "CAUTION", proposal_id: 0, pending_hash: h, flags: ["UNVERIFIED_PENDING_CODE"] });
  });

  it("nothing pending: executes; executed, expired, rejected and out-of-period failed proposals are ignored even when their code would be STOP", async () => {
    const h = await codeHash(SWEEP);
    const old = 8 * 86400_000; // older than the 7-day proposal period
    const props = [
      proposal(0, "Approved", h, { ageMs: old, approvals: 2 }),
      proposal(1, "InProgress", h, { ageMs: old }), // InProgress past its period: expired
      proposal(2, "Rejected", h),
      proposal(3, "Failed", h, { ageMs: old }),
      proposal(4, "Approved", h, { approvals: 2 }), // executed yesterday
    ];
    const { pending, api } = setup(props, [SWEEP]);
    const execute = vi.fn().mockResolvedValue("tx");
    expect(await guardCall(VAULT, { methodName: "deposit" }, { execute, report: report(), pending, ...quiet })).toBe("tx");
    const d = await decide(VAULT, { methodName: "deposit" }, {}, { report: report(), pending });
    expect(d.verdict).toBe("OK");
    expect(d.pending?.upgrades).toEqual([]);
    expect(d.pending?.ignored.map((x) => x.state)).toEqual(["executed", "failed", "rejected", "expired", "executed"]);
    expect(api.calls).toEqual([]); // nothing live, no bytes fetched
  });

  it("a Failed proposal inside its period is still live (sputnikdao2 v3 can re-execute it)", async () => {
    const h = await codeHash(SWEEP);
    const { pending } = setup([proposal(0, "Failed", h)], [SWEEP]);
    const d = await decide(VAULT, { methodName: "deposit" }, {}, { report: report(), pending });
    expect(d.verdict).toBe("STOP");
    expect(d.pendingStop).toMatchObject({ proposal_id: 0, state: "failed" });
  });

  it("RPC failure in the check is CAUTION, never OK", async () => {
    const { pending } = setup([], [], { outage: (p) => p.method_name === "get_last_proposal_id" });
    const d = await decide(VAULT, { methodName: "deposit" }, {}, { report: report(), pending });
    expect(d.verdict).toBe("CAUTION");
    expect(d.allowed).toBe(false);
    expect(d.pending?.errors[0]).toMatch(/could not read the upgrade proposals of dao\.testnet: RPC HTTP 500/);
    const execute = vi.fn();
    await expect(guardCall(VAULT, { methodName: "deposit" }, { execute, report: report(), pending, ...quiet })).rejects.toThrow(/could not be ruled out/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("an outage while grading one proposal is CAUTION for that proposal", async () => {
    const h = await codeHash(SWEEP);
    const { pending } = setup([proposal(0, "InProgress", h)], [SWEEP], { outage: (p) => p.request_type === "view_code" });
    const c = await checkPendingUpgrades(report(), pending);
    expect(c.verdict).toBe("CAUTION");
    expect(c.upgrades[0]).toMatchObject({ verdict: "CAUTION", proposal_id: 0, code_source: null });
    expect(c.upgrades[0].error).toMatch(/RPC HTTP 500/);
  });

  it("bytes that cannot be obtained give CAUTION with that reason, never OK", async () => {
    const { pending } = setup([proposal(0, "InProgress", MISSING)], []);
    const c = await checkPendingUpgrades(report(), pending);
    expect(c.verdict).toBe("CAUTION");
    expect(c.upgrades[0]).toMatchObject({ pending_hash: MISSING, code_source: null });
    expect(c.upgrades[0].flags).toContain("PENDING_CODE_UNAVAILABLE");
    expect(c.upgrades[0].headline).toMatch(/could not be read/);
  });

  it("a proposal whose code hash is unknown is CAUTION", async () => {
    const p = { ...proposal(0, "InProgress", MISSING), kind: { FunctionCall: { receiver_id: VAULT, actions: [{ method_name: "upgrade", args: "", deposit: "0", gas: "1" }] } } };
    const { pending } = setup([p], []);
    const c = await checkPendingUpgrades(report(), pending);
    expect(c.verdict).toBe("CAUTION");
    expect(c.upgrades[0]).toMatchObject({ pending_hash: null, proposal_kind: "FunctionCall" });
  });

  it("staging views exported but unanswerable (e.g. the view panics): CAUTION, not 'nothing staged'", async () => {
    const { pending } = setup([], [], { views: { [DAO]: daoViews([]) } });
    const c = await checkPendingUpgrades(report({ exports: ["deposit", "get_owner", "up_staged_code_hash", "up_deploy_code"] }), pending);
    expect(c.verdict).toBe("CAUTION");
    expect(c.errors.join(" ")).toMatch(/staged code of .* could not be read/);
  });

  it("near-plugins staged code that differs from live is graded too", async () => {
    const h = await codeHash(SWEEP);
    const { pending } = setup([], [], { views: { [DAO]: daoViews([]), [VAULT]: { up_staged_code_hash: h } }, raw: { [VAULT]: { up_staged_code: borshSome(SWEEP) } } });
    const c = await checkPendingUpgrades(report({ exports: ["deposit", "get_owner", "up_staged_code_hash", "up_deploy_code"] }), pending);
    expect(c.staged_checked).toBe(true);
    expect(c.verdict).toBe("STOP");
    expect(c.upgrades[0]).toMatchObject({ source: "staged", pending_hash: h, code_source: { kind: "up_staged_code" } });
  });

  it("more recent upgrade proposals than it reads: says older live ones were not ruled out (CAUTION)", async () => {
    const h = await codeHash(BENIGN);
    const props = [0, 1, 2].map((i) => proposal(i, "Approved", h, { approvals: 2 }));
    const { pending } = setup(props, [BENIGN]);
    const c = await checkPendingUpgrades(report(), { ...pending, last: 2 });
    expect(c.verdict).toBe("CAUTION");
    expect(c.errors[0]).toMatch(/newest 2 upgrade proposals.*not ruled out/);
  });

  it("policy checkPending:false skips the check (no RPC) and decides on the live code alone", async () => {
    const h = await codeHash(SWEEP);
    const { pending, chain } = setup([proposal(0, "InProgress", h)], [SWEEP]);
    const execute = vi.fn().mockResolvedValue("tx");
    expect(await guardCall(VAULT, { methodName: "deposit" }, { execute, report: report(), pending, policy: { checkPending: false }, ...quiet })).toBe("tx");
    expect(chain.log).toEqual([]);
  });

  it("no controlling DAO and no staging: nothing to read, OK", async () => {
    const r = { ...report(), owners: [] } as unknown as KeyholeReport;
    const c = await checkPendingUpgrades(r, { registry: null, rpc: undefined, transport: async () => { throw new Error("must not be called"); } });
    expect(c).toMatchObject({ verdict: "OK", daos: [], staged_checked: false, upgrades: [], errors: [] });
  });
});
