import { describe, it, expect, vi } from "vitest";
import { guardCall, GuardRefusal } from "../src/index.ts";
import type { KeyholeReport } from "../../core/src/index.ts";

const report = (verdict: "OK" | "CAUTION" | "STOP", hash = "H1"): KeyholeReport =>
  ({ account: "vault.testnet", code: { hash }, grade: { verdict, class: "CUSTODIAL", flags: [], headline: `headline ${verdict}`, reasons: [{ code: "X", severity: verdict === "STOP" ? "stop" : "caution", text: `reason ${verdict}`, evidence: [] }] } }) as unknown as KeyholeReport;

describe("guardCall", () => {
  it("STOP: throws GuardRefusal and never executes", async () => {
    const execute = vi.fn();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("STOP"), log: () => {} })).rejects.toBeInstanceOf(GuardRefusal);
    expect(execute).not.toHaveBeenCalled();
  });
  it("CAUTION fails closed by default", async () => {
    const execute = vi.fn();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("CAUTION"), log: () => {} })).rejects.toThrow(/deny on CAUTION/);
    expect(execute).not.toHaveBeenCalled();
  });
  it("CAUTION asks a human when configured", async () => {
    const execute = vi.fn().mockResolvedValue("tx");
    const ask = vi.fn().mockResolvedValue(true);
    expect(await guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("CAUTION"), policy: { ask }, log: () => {} })).toBe("tx");
    expect(ask).toHaveBeenCalledOnce();
  });
  it("OK executes", async () => {
    const execute = vi.fn().mockResolvedValue("tx");
    expect(await guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("OK"), log: () => {} })).toBe("tx");
  });
  it("a pinned code hash refuses any other code, even when the grade is OK", async () => {
    const execute = vi.fn();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("OK", "H2"), policy: { expectCodeHash: "H1" }, log: () => {} })).rejects.toThrow(/pinned/);
    expect(execute).not.toHaveBeenCalled();
  });
});
