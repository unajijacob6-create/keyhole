import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { Rpc, fixtureTransport, requestKey, bytesToBase64, base64ToBytes } from "../../core/src/index.ts";
import { decodeHatch, hatchHealth, outcomeError, prepareDelegateHatch, probeDeposit, verifyHatch, type Hatch } from "../src/index.ts";

// A fixed test key (never used on any network).
const KP = KeyPair.fromString("ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr" as any);

const make = (o: Partial<Parameters<typeof prepareDelegateHatch>[0]> = {}) =>
  prepareDelegateHatch({ network: "testnet", account: "alice.testnet", venue: "vault.testnet", method: "withdraw_all", args: {}, deposit: "1", keyPair: KP, keyNonce: 100n, headHeight: 1000, ttlBlocks: 500, now: new Date("2026-11-10T00:00:00Z"), ...o });

describe("prepareDelegateHatch / decodeHatch / verifyHatch", () => {
  it("signs exactly one call and decodes back to it", async () => {
    const h = await make();
    const d = decodeHatch(h);
    expect(d).toMatchObject({ senderId: "alice.testnet", receiverId: "vault.testnet", nonce: 101n, maxBlockHeight: 1500n, publicKey: KP.getPublicKey().toString() });
    expect(d.actions).toEqual([{ method: "withdraw_all", args: {}, deposit: "1", gas: "50000000000000" }]);
    expect(h.nonce).toBe("101");
    expect(h.mode).toBe("delegate");
    expect(verifyHatch(h)).toMatchObject({ ok: true });
  });
  it("is deterministic for the same inputs (ed25519 is deterministic)", async () => {
    expect((await make()).signed_delegate).toBe((await make()).signed_delegate);
  });
  it("rejects any change to the record", async () => {
    const h = await make({ args: { amount: "5" } });
    for (const patch of [{ venue: "evil.testnet" }, { method: "sweep" }, { args: { amount: "6" } }, { deposit: "2" }, { nonce: "102" }, { max_block_height: "9999" }, { account: "bob.testnet" }, { gas: "1" }] as Partial<Hatch>[]) {
      expect(verifyHatch({ ...h, ...patch }).ok, JSON.stringify(patch)).toBe(false);
    }
  });
  it("rejects any change to the signed bytes", async () => {
    const h = await make();
    const bytes = base64ToBytes(h.signed_delegate!);
    // Flip one byte inside the receiver id ("vault.testnet"): the signature no longer verifies.
    const at = bytes.findIndex((_, i) => new TextDecoder().decode(bytes.slice(i, i + 5)) === "vault");
    bytes[at] = "f".charCodeAt(0);
    const v = verifyHatch({ ...h, signed_delegate: bytesToBase64(bytes) });
    expect(v.ok).toBe(false);
    expect(v.checks.join(" ")).toMatch(/NOT verify/);
  });
});

const akKey = (h: Hatch) => requestKey("query", { request_type: "view_access_key", account_id: h.account, public_key: h.public_key, finality: "final" });
const rpcWith = (fx: Record<string, any>) => new Rpc({ network: "testnet", transport: fixtureTransport(fx), retries: 0 });

describe("hatchHealth", () => {
  it("ARMED while the key is full-access, unused and unexpired", async () => {
    const h = await make();
    const r = await hatchHealth(rpcWith({ [akKey(h)]: { result: { nonce: 100, permission: "FullAccess" } } }), h, { headHeight: 1200 });
    expect(r).toMatchObject({ state: "ARMED", blocks_left: 300, key_nonce: "100" });
  });
  it("USED once the key nonce reaches the signed nonce", async () => {
    const h = await make();
    expect((await hatchHealth(rpcWith({ [akKey(h)]: { result: { nonce: 101, permission: "FullAccess" } } }), h, { headHeight: 1200 })).state).toBe("USED");
  });
  it("EXPIRED past max_block_height", async () => {
    const h = await make();
    expect((await hatchHealth(rpcWith({ [akKey(h)]: { result: { nonce: 100, permission: "FullAccess" } } }), h, { headHeight: 1501 })).state).toBe("EXPIRED");
  });
  it("REVOKED when the key is gone", async () => {
    const h = await make();
    const fx = { [akKey(h)]: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} } } } };
    expect((await hatchHealth(rpcWith(fx), h, { headHeight: 1200 })).state).toBe("REVOKED");
  });
  it("STALE when the key was downgraded to a function-call key", async () => {
    const h = await make();
    const fx = { [akKey(h)]: { result: { nonce: 100, permission: { FunctionCall: { allowance: null, receiver_id: "vault.testnet", method_names: [] } } } } };
    expect((await hatchHealth(rpcWith(fx), h, { headHeight: 1200 })).state).toBe("STALE");
  });
  it("fc-key hatch: ARMED only for the right receiver and method", async () => {
    const h: Hatch = { ...(await make()), mode: "fc-key", signed_delegate: null, nonce: null, max_block_height: null, method: "unstake_all", deposit: "0" };
    const ok = { [akKey(h)]: { result: { nonce: 5, permission: { FunctionCall: { allowance: "1", receiver_id: "vault.testnet", method_names: ["unstake_all", "withdraw_all"] } } } } };
    expect((await hatchHealth(rpcWith(ok), h, { headHeight: 1 })).state).toBe("ARMED");
    const wrong = { [akKey(h)]: { result: { nonce: 5, permission: { FunctionCall: { allowance: "1", receiver_id: "other.testnet", method_names: ["unstake_all"] } } } } };
    expect((await hatchHealth(rpcWith(wrong), h, { headHeight: 1 })).state).toBe("STALE");
  });
});

describe("outcomeError", () => {
  it("finds a failure in any receipt", () => {
    expect(outcomeError({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] })).toBeNull();
    expect(outcomeError({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "x" } } } } }] })).toMatch(/ActionError/);
    expect(outcomeError({ status: { Failure: { InvalidTxError: "y" } } })).toMatch(/InvalidTxError/);
  });
});

describe("probeDeposit", () => {
  const key = (m: string) => requestKey("query", { request_type: "call_function", account_id: "c.near", method_name: m, args_base64: bytesToBase64(new TextEncoder().encode("{}")), finality: "final" });
  it("classifies the three answers", async () => {
    const rpc = rpcWith({
      [key("near_withdraw")]: { error: { result_error: "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"Requires attached deposit of exactly 1 yoctoNEAR\" })" } },
      [key("unstake_all")]: { error: { result_error: "wasm execution failed with error: HostError(ProhibitedInView { method_name: \"predecessor_account_id\" })" } },
      [key("get_total")]: { result: { result: [...new TextEncoder().encode("\"0\"")] } },
    });
    expect((await probeDeposit(rpc, "c.near", "near_withdraw")).need).toBe("one-yocto");
    expect((await probeDeposit(rpc, "c.near", "unstake_all")).need).toBe("inconclusive");
    expect((await probeDeposit(rpc, "c.near", "get_total")).need).toBe("none-before-state");
  });
});
