import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc, fixtureTransport, type Network } from "../../core/src/rpc.ts";
import { probeDeposit } from "../src/index.ts";

// Real RPC answers recorded by test/record-fixtures.ts (mainnet + testnet view calls, nothing signed).
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const rpc = (network: Network) =>
  new Rpc({ network, transport: fixtureTransport(JSON.parse(fs.readFileSync(path.join(dir, `probe-${network}.json`), "utf8")).fixtures), retries: 0 });

describe("probeDeposit (recorded mainnet answers)", () => {
  const main = rpc("mainnet");
  it("wrap.near near_withdraw needs exactly 1 yoctoNEAR", async () => {
    const r = await probeDeposit(main, "wrap.near", "near_withdraw", { amount: "1" });
    expect(r.need).toBe("one-yocto");
    expect(r.detail).toMatch(/Requires attached deposit of exactly 1 yoctoNEAR/);
  });
  it("NEP-141 ft_transfer on wrap.near needs exactly 1 yoctoNEAR", async () => {
    expect((await probeDeposit(main, "wrap.near", "ft_transfer", { receiver_id: "wrap.near", amount: "1" })).need).toBe("one-yocto");
  });
  it("v2.ref-finance.near withdraw needs exactly 1 yoctoNEAR", async () => {
    expect((await probeDeposit(main, "v2.ref-finance.near", "withdraw", { token_id: "wrap.near", amount: "1" })).need).toBe("one-yocto");
  });
  it("intents.near ft_withdraw needs exactly 1 yoctoNEAR", async () => {
    expect((await probeDeposit(main, "intents.near", "ft_withdraw", { token: "wrap.near", receiver_id: "wrap.near", amount: "1" })).need).toBe("one-yocto");
  });
  it("linear-protocol.near unstake_all is not one-yocto: it reads predecessor first, so the view is inconclusive", async () => {
    const r = await probeDeposit(main, "linear-protocol.near", "unstake_all", {});
    expect(r.need).not.toBe("one-yocto");
    expect(r).toEqual({ need: "inconclusive", detail: expect.stringMatching(/predecessor_account_id \(ProhibitedInView\)/) });
  });
  it("bad args panic before the deposit check: none-before-state (a limit of the probe, not a verdict)", async () => {
    const r = await probeDeposit(main, "wrap.near", "near_withdraw", { amount: "not-a-number" });
    expect(r.need).toBe("none-before-state");
    expect(r.detail).toMatch(/Failed to deserialize/);
  });
  it("a missing method is inconclusive", async () => {
    expect((await probeDeposit(main, "wrap.near", "no_such_method", {})).need).toBe("inconclusive");
  });
  // near-contract-standards assert_at_least_one_yocto: "at least", not "exactly". 1 yocto satisfies it,
  // so for a hatch it is the same answer; calling it none-before-state would send the guardian to fc-key mode.
  it("NFT nft_approve (assert_at_least_one_yocto, two builds) is one-yocto too", async () => {
    for (const c of ["asac.near", "near-punks.near"]) {
      const r = await probeDeposit(main, c, "nft_approve", { token_id: "1", account_id: "wrap.near" });
      expect(r.need).toBe("one-yocto");
      expect(r.detail).toMatch(/at least 1 yoctoNEAR/);
    }
  });
  it("a panic that demands some other attached deposit is inconclusive, not none-before-state", async () => {
    const r = await probeDeposit(main, "wrap.near", "near_deposit", {});
    expect(r.need).toBe("inconclusive");
    expect(r.detail).toMatch(/Requires positive attached deposit/);
  });
});

describe("probeDeposit (recorded testnet answer)", () => {
  it("wrap.testnet near_withdraw needs exactly 1 yoctoNEAR (the live check's venue)", async () => {
    expect((await probeDeposit(rpc("testnet"), "wrap.testnet", "near_withdraw", { amount: "1" })).need).toBe("one-yocto");
  });
});

describe("probeDeposit (classification)", () => {
  const one = (answer: { result?: unknown; error?: unknown }) => {
    const key = `query ${JSON.stringify({ request_type: "call_function", account_id: "c.testnet", method_name: "m", args_base64: "e30=", finality: "final" })}`;
    return probeDeposit(new Rpc({ network: "testnet", transport: fixtureTransport({ [key]: answer }), retries: 0 }), "c.testnet", "m", {});
  };
  it("a normal return is none-before-state", async () => {
    expect((await one({ result: { result: [...new TextEncoder().encode("1")], logs: [] } })).need).toBe("none-before-state");
  });
  it("a structured FunctionCallError with the near-sdk message is one-yocto", async () => {
    const r = await one({ error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "FunctionCallError(HostError(GuestPanic { panic_msg: \"Requires attached deposit of exactly 1 yoctoNEAR\" }))" } } } });
    expect(r.need).toBe("one-yocto");
  });
  it("transport failures are thrown, not classified", async () => {
    await expect(probeDeposit(new Rpc({ network: "testnet", transport: async () => ({ status: 503, json: null }), retries: 0 }), "c.testnet", "m")).rejects.toThrow(/503/);
  });
});
