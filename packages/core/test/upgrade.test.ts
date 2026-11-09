// gradeUpgrade(): the deterministic rules of docs/GRADING.md "Upgrade grading", on synthetic
// analyses (one rule at a time) and on real wasm from this repo (contracts/repro, contracts/fixtures).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gradeUpgrade, analyzeWasm, codeHash, type WasmAnalysis, type Capability, type UpgradeGradeInput } from "../src/index.ts";

/** A WasmAnalysis with the given exports and, per capability, the methods with a specific path. */
function mk(exports: string[], caps: Partial<Record<Capability, string[] | null>> = {}, via: Partial<Record<Capability, string[]>> = {}): WasmAnalysis {
  const capabilities: WasmAnalysis["capabilities"] = {};
  for (const [c, from] of Object.entries(caps) as [Capability, string[] | null][]) {
    capabilities[c] = { imports: [`host_${c}`], reachableFrom: from, viaDispatcherOnly: from === null ? null : (via[c] ?? []) };
  }
  const available = Object.values(caps).every((v) => v !== null);
  return {
    size: 1000,
    imports: Object.keys(caps).map((c) => `host_${c}`),
    exports,
    capabilities,
    codeChangeEntrypoints: available ? [] : null,
    codeChangeViaDispatcher: available ? [] : null,
    dispatchers: 0,
    upgradeLikeNames: [],
    reachability: { available, functions: 10, indirectTargets: 0 },
  };
}

const LIVE = mk(["deposit", "withdraw", "get_balance"], { transfer: ["withdraw"], function_call: ["withdraw"] });
const UNVERIFIED = { reproducible: null, sourcescan: false };
const VERIFIED = { reproducible: true, sourcescan: null };
const base = (o: Partial<UpgradeGradeInput>): UpgradeGradeInput => ({ target: "vault.testnet", live_hash: "LiveHash111", pending_hash: "PendingHash22", live: LIVE, pending: LIVE, verified: UNVERIFIED, ...o });

describe("gradeUpgrade rules (synthetic analyses)", () => {
  it("same hash as live → NO_CHANGE, OK, no fire", () => {
    const g = gradeUpgrade(base({ pending_hash: "LiveHash111" }));
    expect(g).toMatchObject({ verdict: "OK", flags: ["NO_CHANGE"], fire: false });
  });

  it("unverified, no new path → CAUTION (logic changes are invisible to the diff)", () => {
    const g = gradeUpgrade(base({}));
    expect(g.verdict).toBe("CAUTION");
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE"]);
    expect(g.fire).toBe(false);
  });

  it("verified (reproducible build or SourceScan), no new path → OK", () => {
    expect(gradeUpgrade(base({ verified: VERIFIED })).verdict).toBe("OK");
    expect(gradeUpgrade(base({ verified: { reproducible: null, sourcescan: true } })).verdict).toBe("OK");
    // A reproducible build that did NOT match is not verification.
    expect(gradeUpgrade(base({ verified: { reproducible: false, sourcescan: false } })).flags).toContain("UNVERIFIED_PENDING_CODE");
  });

  it("added method with a specific path to transfer → NEW_MONEY_PATH; STOP if unverified, CAUTION if verified", () => {
    const pending = mk([...LIVE.exports, "sweep"], { transfer: ["sweep", "withdraw"], function_call: ["withdraw"] });
    const stop = gradeUpgrade(base({ pending }));
    expect(stop).toMatchObject({ verdict: "STOP", fire: true });
    expect(stop.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_MONEY_PATH"]);
    expect(stop.reasons.find((r) => r.severity === "stop")?.text).toContain("`sweep`");
    const caution = gradeUpgrade(base({ pending, verified: VERIFIED }));
    expect(caution).toMatchObject({ verdict: "CAUTION", flags: ["NEW_MONEY_PATH"], fire: false });
  });

  it("existing method newly reaching transfer is a money path too; via-dispatcher-only paths are not", () => {
    const newly = mk(LIVE.exports, { transfer: ["get_balance", "withdraw"], function_call: ["withdraw"] });
    expect(gradeUpgrade(base({ pending: newly })).flags).toContain("NEW_MONEY_PATH");
    const viaOnly = mk([...LIVE.exports, "claim"], { transfer: ["withdraw"], function_call: ["withdraw"] }, { transfer: ["claim"] });
    expect(gradeUpgrade(base({ pending: viaOnly })).flags).toEqual(["UNVERIFIED_PENDING_CODE"]);
  });

  it("added code-change capability (import level) or newly reachable deploy → NEW_CODE_CHANGE_PATH", () => {
    const imported = mk(LIVE.exports, { transfer: ["withdraw"], function_call: ["withdraw"], deploy_contract: [] });
    expect(gradeUpgrade(base({ pending: imported })).flags).toContain("NEW_CODE_CHANGE_PATH");
    const liveDeploy = mk([...LIVE.exports, "upgrade"], { transfer: ["withdraw"], deploy_contract: ["upgrade"] });
    const reach = mk([...LIVE.exports, "upgrade", "migrate"], { transfer: ["withdraw"], deploy_contract: ["migrate", "upgrade"] });
    const g = gradeUpgrade(base({ live: liveDeploy, pending: reach }));
    expect(g.flags).toContain("NEW_CODE_CHANGE_PATH");
    expect(g.verdict).toBe("STOP");
    // Same deploy path as before: not new.
    expect(gradeUpgrade(base({ live: liveDeploy, pending: liveDeploy, pending_hash: "Other" })).flags).not.toContain("NEW_CODE_CHANGE_PATH");
  });

  it("delete_account, use_global_contract and add_full_access_key count as code-change paths", () => {
    for (const cap of ["delete_account", "use_global_contract", "add_full_access_key"] as Capability[]) {
      const pending = mk([...LIVE.exports, "x"], { transfer: ["withdraw"], function_call: ["withdraw"], [cap]: ["x"] });
      expect(gradeUpgrade(base({ pending })).flags).toContain("NEW_CODE_CHANGE_PATH");
    }
  });

  it("add_function_call_key / delete_key → NEW_KEY_PATH", () => {
    for (const cap of ["add_function_call_key", "delete_key"] as Capability[]) {
      const g = gradeUpgrade(base({ pending: mk([...LIVE.exports, "rotate"], { transfer: ["withdraw"], function_call: ["withdraw"], [cap]: ["rotate"] }) }));
      expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_KEY_PATH"]);
      expect(g.verdict).toBe("STOP");
    }
  });

  it("removing a method that reached transfer in the live code → EXIT_METHOD_REMOVED", () => {
    const g = gradeUpgrade(base({ pending: mk(["deposit", "get_balance"], {}) }));
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "EXIT_METHOD_REMOVED"]);
    expect(g.verdict).toBe("STOP");
    // A withdraw that reached transfer only through the shared dispatcher counts as well.
    const viaLive = mk(["deposit", "withdraw"], { transfer: [] }, { transfer: ["withdraw"] });
    expect(gradeUpgrade(base({ live: viaLive, pending: mk(["deposit"], { transfer: [] }), verified: VERIFIED })).flags).toEqual(["EXIT_METHOD_REMOVED"]);
    // Removing a view is not an exit.
    expect(gradeUpgrade(base({ pending: mk(["deposit", "withdraw"], { transfer: ["withdraw"], function_call: ["withdraw"] }) })).flags).toEqual(["UNVERIFIED_PENDING_CODE"]);
  });

  it("pending code unavailable → PENDING_CODE_UNAVAILABLE, CAUTION (never OK, never STOP on its own)", () => {
    const g = gradeUpgrade(base({ pending: null }));
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "PENDING_CODE_UNAVAILABLE"]);
    expect(g.verdict).toBe("CAUTION");
    expect(g.diff).toBeNull();
    expect(gradeUpgrade(base({ pending: null, verified: { reproducible: null, sourcescan: true } })).flags).toEqual(["PENDING_CODE_UNAVAILABLE"]);
    expect(gradeUpgrade(base({ pending: null, pending_hash: null })).verdict).toBe("CAUTION");
  });

  it("AI review high → STOP even for verified code with no new path; medium is shown but sets no flag", () => {
    const high = gradeUpgrade(base({ verified: VERIFIED, review: { risk: "high", summary: "sweeps funds" } }));
    expect(high).toMatchObject({ verdict: "STOP", flags: ["AI_REVIEW_HIGH"], fire: true });
    const fromRegistry = gradeUpgrade(base({ verified: { ...VERIFIED, registry_review: "high: owner can drain" } }));
    expect(fromRegistry.flags).toEqual(["AI_REVIEW_HIGH"]);
    const medium = gradeUpgrade(base({ verified: VERIFIED, review: { risk: "medium", summary: "complex" } }));
    expect(medium.verdict).toBe("OK");
    expect(medium.reasons.some((r) => r.severity === "caution" && r.text.includes("medium"))).toBe(true);
  });

  it("call graph unavailable in the pending code: added methods are assumed to reach what the code imports", () => {
    const pending = mk([...LIVE.exports, "sweep"], { transfer: null, function_call: null });
    const g = gradeUpgrade(base({ pending }));
    expect(g.flags).toContain("NEW_MONEY_PATH");
    expect(g.reasons.some((r) => r.text.includes("assumed"))).toBe(true);
  });

  it("no live analysis (e.g. first deploy): every capability of the pending code is new", () => {
    const g = gradeUpgrade(base({ live: null, live_hash: "11111111111111111111111111111111", pending: mk(["withdraw", "upgrade"], { transfer: ["withdraw"], deploy_contract: ["upgrade"] }) }));
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_CODE_CHANGE_PATH", "NEW_MONEY_PATH"]);
    expect(g.diff).toBeNull();
  });

  it("every reason has text; fire mirrors STOP", () => {
    const g = gradeUpgrade(base({ pending: mk(["sweep"], { transfer: ["sweep"], deploy_contract: ["sweep"] }) }));
    expect(g.fire).toBe(g.verdict === "STOP");
    for (const r of g.reasons) expect(r.text.length).toBeGreaterThan(15);
    expect(g.headline).toMatch(/^STOP: /);
  });
});

describe("gradeUpgrade on real wasm", () => {
  const ROOT = path.join(import.meta.dirname, "../../..");
  const read = (p: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, p)));
  const v1 = read("contracts/repro/demo_vault_v1.wasm");
  const v2 = read("contracts/repro/demo_vault_v2.wasm");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/repro/manifest.json"), "utf8"));
  const input = async (live: Uint8Array, pending: Uint8Array, verified: UpgradeGradeInput["verified"]): Promise<UpgradeGradeInput> => ({
    target: "vault.testnet",
    live_hash: await codeHash(live),
    pending_hash: await codeHash(pending),
    live: analyzeWasm(live),
    pending: analyzeWasm(pending),
    verified,
  });

  it("the repro wasm hashes are the ones in contracts/repro/manifest.json", async () => {
    expect(await codeHash(v1)).toBe(manifest.wasm["demo_vault_v1.wasm"].code_hash);
    expect(await codeHash(v2)).toBe(manifest.wasm["demo_vault_v2.wasm"].code_hash);
  });

  it("demo-vault v1 → v2 (adds `sweep`, which reaches transfer), unverified → STOP and fire", async () => {
    const g = gradeUpgrade(await input(v1, v2, { reproducible: null, sourcescan: false }));
    expect(g.verdict).toBe("STOP");
    expect(g.fire).toBe(true);
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_MONEY_PATH"]);
    expect(g.diff?.addedMethods).toEqual(["sweep"]);
    expect(g.diff?.newlyReachable).toEqual([{ capability: "transfer", methods: ["sweep"] }]);
  });

  it("demo-vault v1 → v2 marked reproducible → CAUTION (the new money path still needs a human)", async () => {
    const g = gradeUpgrade(await input(v1, v2, { reproducible: true, sourcescan: null }));
    expect(g).toMatchObject({ verdict: "CAUTION", flags: ["NEW_MONEY_PATH"], fire: false });
  });

  it("two builds of the same v1 source (local vs CI reproducible): no diff; OK when reproducible, CAUTION when not", async () => {
    const local = read("contracts/out/demo_vault_v1.wasm");
    expect(await codeHash(local)).not.toBe(await codeHash(v1));
    const ok = gradeUpgrade(await input(local, v1, { reproducible: true, sourcescan: null }));
    expect(ok).toMatchObject({ verdict: "OK", flags: [], fire: false });
    expect(gradeUpgrade(await input(local, v1, { reproducible: null, sourcescan: false })).verdict).toBe("CAUTION");
  });

  it("demo-vault v1 → an owner-upgradable contract: new deploy path and withdraw removed → STOP", async () => {
    const up = read("contracts/fixtures/out/fixture_upgradable.wasm");
    const g = gradeUpgrade(await input(v1, up, { reproducible: null, sourcescan: false }));
    expect(g.verdict).toBe("STOP");
    expect(g.flags).toEqual(["UNVERIFIED_PENDING_CODE", "NEW_CODE_CHANGE_PATH", "EXIT_METHOD_REMOVED"]);
    expect(g.reasons.find((r) => r.text.includes("Removes"))?.text).toContain("`withdraw`");
  });
});
