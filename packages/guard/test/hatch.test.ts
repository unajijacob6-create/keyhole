// guardCall's optional auto-hatch: after a successful execute, arm a @keyhole/hatch delegate hatch for
// the same venue. Mocked owner and provider (the shape of packages/hatch/test/hatch.test.ts); no network.
import { describe, expect, it, vi } from "vitest";
import type { Account, Provider } from "near-api-js";
import type { KeyholeReport } from "../../core/src/index.ts";
import { decodeHatch, verifyHatch } from "../../hatch/src/index.ts";
import { guardCall, GuardRefusal } from "../src/index.ts";

const report = (verdict: "OK" | "STOP", account = "vault.testnet"): KeyholeReport =>
  ({ account, network: account.endsWith(".testnet") ? "testnet" : "mainnet", code: { hash: "H1" }, owners: [], wasm: { exports: [] }, grade: { verdict, class: "GOVERNED", flags: [], headline: `headline ${verdict}`, reasons: [{ code: "X", severity: verdict === "STOP" ? "stop" : "ok", text: `reason ${verdict}`, evidence: [] }] } }) as unknown as KeyholeReport;

function mocks(network = "testnet") {
  const owner = { accountId: "alice.testnet", addFullAccessKey: vi.fn(async () => ({})), deleteKey: vi.fn(async () => ({})) };
  const provider = {
    getNetworkId: vi.fn(async () => network),
    viewAccessKey: vi.fn(async () => ({ nonce: 276975001000000n, permission: "FullAccess" })),
    viewBlock: vi.fn(async () => ({ header: { height: 276975010 } })),
  };
  const hatch = { owner: owner as unknown as Account, provider: provider as unknown as Provider, method: "withdraw_all", args: {}, ttlBlocks: 100 };
  return { owner, provider, hatch };
}
const quiet = { log: () => {} };

describe("guardCall auto-hatch", () => {
  it("after the deposit lands, arms a delegate hatch for the same venue and returns it with the result", async () => {
    const { owner, hatch } = mocks();
    const order: string[] = [];
    owner.addFullAccessKey.mockImplementation(async () => (order.push("addKey"), {}));
    const execute = vi.fn(async () => (order.push("execute"), "DEPOSIT_TX"));
    const r = await guardCall("vault.testnet", { methodName: "deposit", deposit: 1n }, { execute, report: report("OK"), hatch, ...quiet });
    expect(order).toEqual(["execute", "addKey"]);
    expect(r.result).toBe("DEPOSIT_TX");
    expect(r.hatchError).toBeNull();
    expect(r.hatch).toMatchObject({ account: "alice.testnet", venue: "vault.testnet", method: "withdraw_all", deposit: "1", trigger: "stop", max_block_height: "276975110", network: "testnet" });
    expect(verifyHatch(r.hatch!).ok).toBe(true);
    expect(decodeHatch(r.hatch!)).toMatchObject({ senderId: "alice.testnet", receiverId: "vault.testnet" });
  });

  it("refuses up front, before deciding or executing, when the provider is not on testnet", async () => {
    const { owner, hatch } = mocks("mainnet");
    const execute = vi.fn();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("OK"), hatch, ...quiet })).rejects.toThrow(/testnet-only.*mainnet/);
    expect(execute).not.toHaveBeenCalled();
    expect(owner.addFullAccessKey).not.toHaveBeenCalled();
  });

  it("refuses a mainnet venue even with a testnet provider", async () => {
    const { hatch } = mocks();
    const execute = vi.fn();
    await expect(guardCall("vault.near", { methodName: "deposit" }, { execute, report: report("OK", "vault.near"), hatch, ...quiet })).rejects.toThrow(/testnet-only/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a non-testnet owner, and an owner whose own connection is not testnet, before anything is sent", async () => {
    for (const tweak of [(o: any) => (o.accountId = "alice.near"), (o: any) => (o.provider = { getNetworkId: async () => "mainnet" })]) {
      const { owner, hatch } = mocks();
      tweak(owner);
      const execute = vi.fn(async () => "TX");
      await expect(guardCall("vault.testnet", { methodName: "deposit", deposit: 1n }, { execute, report: report("OK"), hatch, ...quiet })).rejects.toThrow(/testnet-only/);
      expect(execute).not.toHaveBeenCalled();
      expect(owner.addFullAccessKey).not.toHaveBeenCalled();
    }
  });

  it("a STOP refuses before execute and never adds a key", async () => {
    const { owner, hatch } = mocks();
    const execute = vi.fn();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute, report: report("STOP"), hatch, ...quiet })).rejects.toBeInstanceOf(GuardRefusal);
    expect(execute).not.toHaveBeenCalled();
    expect(owner.addFullAccessKey).not.toHaveBeenCalled();
  });

  it("if arming fails after the deposit went through, returns the result with hatch null and the error (and takes the key off)", async () => {
    const { owner, provider, hatch } = mocks();
    provider.viewBlock.mockRejectedValueOnce(new Error("rpc down"));
    const lines: string[] = [];
    const r = await guardCall("vault.testnet", { methodName: "deposit" }, { execute: async () => "DEPOSIT_TX", report: report("OK"), hatch, log: (l) => lines.push(l) });
    expect(r).toEqual({ result: "DEPOSIT_TX", hatch: null, hatchError: "rpc down" });
    expect(owner.deleteKey).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toMatch(/call succeeded but arming the hatch failed: rpc down/);
  });

  it("an execute that throws arms nothing", async () => {
    const { owner, hatch } = mocks();
    await expect(guardCall("vault.testnet", { methodName: "deposit" }, { execute: async () => { throw new Error("tx failed"); }, report: report("OK"), hatch, ...quiet })).rejects.toThrow(/tx failed/);
    expect(owner.addFullAccessKey).not.toHaveBeenCalled();
  });
});
