import { describe, it, expect, vi, afterEach } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate, type Account, type Provider } from "near-api-js";
import { base64ToBytes } from "../../core/src/hash.ts";
import {
  NEP461_DELEGATE_PREFIX,
  armDelegateHatch,
  armFunctionCallHatch,
  decodeHatch,
  delegateSigningHash,
  fireFunctionCallHatch,
  fireHatch,
  hatchId,
  prepareDelegateHatch,
  verifyHatch,
  type Hatch,
} from "../src/index.ts";
import { HEAD, KEY, KEY_NONCE, OTHER_KEY, TTL, baseOptions, fixedHatch, tamperPayload } from "./helpers.ts";

const failures = (h: Hatch) => verifyHatch(h).checks.filter((c) => c.startsWith("FAIL"));

describe("prepareDelegateHatch (pure, offline)", () => {
  it("produces a complete keyhole.hatch/1 record from a fixed key", async () => {
    const h = await fixedHatch();
    expect(h).toMatchObject({
      schema: "keyhole.hatch/1",
      network: "testnet",
      account: "alice.testnet",
      venue: "wrap.testnet",
      method: "near_withdraw",
      deposit: "1",
      gas: "30000000000000",
      mode: "delegate",
      public_key: KEY.getPublicKey().toString(),
      nonce: (KEY_NONCE + 1n).toString(),
      max_block_height: String(HEAD + TTL),
      created_at: "2026-11-09T12:00:00.000Z",
      created_height: HEAD,
      trigger: "stop",
    });
    expect(h.id).toMatch(/^[0-9a-f]{16}$/);
    expect(h.id).toBe(hatchId(h));
    expect(Object.keys(h).slice(0, 2)).toEqual(["schema", "id"]);
  });

  it("is deterministic (ed25519 signatures are) and contains no secret", async () => {
    const [a, b] = [await fixedHatch(), await fixedHatch()];
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain(KEY.toString().slice("ed25519:".length));
  });

  it("signs exactly what near-api-js signDelegateAction signs (NEP-461 prefix 2^30+366)", async () => {
    const h = await fixedHatch();
    const da = buildDelegateAction({
      senderId: "alice.testnet",
      receiverId: "wrap.testnet",
      actions: [actions.functionCall("near_withdraw", { amount: "100000000000000000000000" }, 30000000000000n, 1n)],
      nonce: KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEAD + TTL),
      publicKey: KEY.getPublicKey(),
    });
    const { signedDelegate, delegateHash } = await new KeyPairSigner(KEY).signDelegateAction(da);
    expect(Buffer.from(base64ToBytes(h.signed_delegate!))).toEqual(Buffer.from(encodeSignedDelegate(signedDelegate)));
    // Our independent hash construction equals the library's.
    const encoded = encodeDelegateAction(da);
    expect([...encoded.slice(0, 4)]).toEqual([0x6e, 0x01, 0x00, 0x40]);
    expect(NEP461_DELEGATE_PREFIX).toBe(1073742190);
    expect(Buffer.from(delegateSigningHash(encoded.slice(4)))).toEqual(Buffer.from(delegateHash));
    expect(Buffer.from(sha256(encoded))).toEqual(Buffer.from(delegateHash));
  });

  it("rejects bad inputs", async () => {
    await expect(prepareDelegateHatch({ ...baseOptions, deposit: "-1" })).rejects.toThrow(/deposit/);
    await expect(prepareDelegateHatch({ ...baseOptions, gas: "1.5" })).rejects.toThrow(/gas/);
    await expect(prepareDelegateHatch({ ...baseOptions, ttlBlocks: 0 })).rejects.toThrow(/ttlBlocks/);
    await expect(prepareDelegateHatch({ ...baseOptions, args: [] as any })).rejects.toThrow(/args/);
  });
});

describe("decodeHatch", () => {
  it("reads the signed bytes, not the record", async () => {
    const h = await fixedHatch();
    const d = decodeHatch({ ...h, method: "lies", venue: "lies.testnet" });
    expect(d).toEqual({
      senderId: "alice.testnet",
      receiverId: "wrap.testnet",
      actions: [{ kind: "functionCall", method: "near_withdraw", args: { amount: "100000000000000000000000" }, deposit: "1", gas: "30000000000000" }],
      nonce: KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEAD + TTL),
      publicKey: KEY.getPublicKey().toString(),
    });
  });
  it("refuses an fc-key record (nothing signed)", async () => {
    const h = await fixedHatch();
    expect(() => decodeHatch({ ...h, mode: "fc-key", signed_delegate: null })).toThrow(/no signed delegate/);
  });
});

describe("verifyHatch", () => {
  it("accepts what signDelegateAction produced", async () => {
    const v = verifyHatch(await fixedHatch());
    expect(v.ok).toBe(true);
    expect(v.checks.every((c) => c.startsWith("ok") || c.startsWith("info"))).toBe(true);
    expect(v.checks.join("\n")).toMatch(/valid over NEP-461 hash [0-9a-f]{64}/);
  });

  // Field edits the record could suffer, and the matching edit inside the signed payload.
  const cases: [string, Partial<Hatch>, (da: any) => void, Partial<Hatch>][] = [
    ["receiver", { venue: "evil.testnet" }, (da) => (da.receiverId = "evil.testnet"), { venue: "evil.testnet" }],
    ["sender", { account: "bob.testnet" }, (da) => (da.senderId = "bob.testnet"), { account: "bob.testnet" }],
    ["method", { method: "ft_transfer" }, (da) => (da.actions[0].functionCall.methodName = "ft_transfer"), { method: "ft_transfer" }],
    ["args", { args: { amount: "1" } }, (da) => (da.actions[0].functionCall.args = [...new TextEncoder().encode('{"amount":"1"}')]), { args: { amount: "1" } }],
    ["deposit", { deposit: "2" }, (da) => (da.actions[0].functionCall.deposit = 2n), { deposit: "2" }],
    ["gas", { gas: "1" }, (da) => (da.actions[0].functionCall.gas = 1n), { gas: "1" }],
    ["nonce", { nonce: "5" }, (da) => (da.nonce = 5n), { nonce: "5" }],
    ["max_block_height", { max_block_height: "999999999999" }, (da) => (da.maxBlockHeight = 999999999999n), { max_block_height: "999999999999" }],
    [
      "public_key",
      { public_key: OTHER_KEY.getPublicKey().toString() },
      (da) => (da.publicKey = { ed25519Key: { data: [...OTHER_KEY.getPublicKey().data] } }),
      { public_key: OTHER_KEY.getPublicKey().toString() },
    ],
  ];

  for (const [field, recordEdit, payloadEdit, recordToMatch] of cases) {
    it(`rejects a record whose ${field} no longer matches the signed bytes`, async () => {
      const h = await fixedHatch();
      const bad = { ...h, ...recordEdit };
      expect(verifyHatch(bad).ok).toBe(false);
      expect(failures(bad).length).toBeGreaterThan(0);
    });
    it(`rejects a payload whose ${field} was altered after signing (signature check)`, async () => {
      const h = await fixedHatch();
      const forged = { ...h, ...recordToMatch, signed_delegate: tamperPayload(h, payloadEdit) };
      forged.id = hatchId(forged); // a careful forger also fixes the id: only the signature can catch it
      const f = failures(forged);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(/signature does not verify/);
    });
  }

  it("rejects an edited id, an extra action, and trailing bytes", async () => {
    const h = await fixedHatch();
    expect(failures({ ...h, id: "0000000000000000" })[0]).toMatch(/id/);
    const two = { ...h, signed_delegate: tamperPayload(h, (da) => da.actions.push({ transfer: { deposit: 5n } })) };
    expect(failures(two).join(" ")).toMatch(/exactly one FunctionCall/);
    const bytes = base64ToBytes(h.signed_delegate!);
    const trailing = { ...h, signed_delegate: Buffer.from([...bytes, 0]).toString("base64") };
    expect(failures(trailing).join(" ")).toMatch(/does not decode|not canonical/);
  });

  it("args compare by meaning, not key order", async () => {
    const h = await prepareDelegateHatch({ ...baseOptions, args: { token_id: "wrap.testnet", amount: "5" } });
    expect(verifyHatch({ ...h, args: { amount: "5", token_id: "wrap.testnet" } }).ok).toBe(true);
  });
});

describe("armDelegateHatch", () => {
  afterEach(() => vi.restoreAllMocks());

  const mocks = (keyNonce = 276975001000000n) => {
    const owner = { accountId: "alice.testnet", addFullAccessKey: vi.fn(async () => ({})), deleteKey: vi.fn(async () => ({})) };
    const provider = {
      getNetworkId: vi.fn(async () => "testnet"),
      viewAccessKey: vi.fn(async () => ({ nonce: keyNonce, permission: "FullAccess" })),
      viewBlock: vi.fn(async () => ({ header: { height: 276975010 } })),
    };
    return { owner, provider };
  };

  it("adds a fresh FULL ACCESS key, signs with nonce+1, and never puts the secret in the record", async () => {
    const spy = vi.spyOn(KeyPair, "fromRandom");
    const { owner, provider } = mocks();
    const h = await armDelegateHatch({ owner: owner as unknown as Account, provider: provider as unknown as Provider, venue: "wrap.testnet", method: "near_withdraw", args: { amount: "7" }, ttlBlocks: 50 });
    const kp = spy.mock.results[0].value as KeyPair;
    expect(owner.addFullAccessKey).toHaveBeenCalledWith(kp.getPublicKey());
    expect(h.public_key).toBe(kp.getPublicKey().toString());
    expect(h.nonce).toBe("276975001000001");
    expect(h.max_block_height).toBe("276975060");
    expect(h.deposit).toBe("1");
    expect(h.trigger).toBe("stop");
    expect(verifyHatch(h).ok).toBe(true);
    const secret = kp.toString().slice("ed25519:".length);
    expect(JSON.stringify(h)).not.toContain(secret);
    expect(owner.deleteKey).not.toHaveBeenCalled();
  });

  it("takes the key off again if signing fails after it was added", async () => {
    const { owner, provider } = mocks();
    provider.viewBlock.mockRejectedValueOnce(new Error("rpc down"));
    await expect(armDelegateHatch({ owner: owner as unknown as Account, provider: provider as unknown as Provider, venue: "wrap.testnet", method: "near_withdraw", args: {} })).rejects.toThrow(/rpc down/);
    expect(owner.deleteKey).toHaveBeenCalledOnce();
  });

  it("also tries to take the key off when adding it reports an error (the add may still have landed, e.g. a timeout)", async () => {
    const { owner, provider } = mocks();
    owner.addFullAccessKey.mockRejectedValueOnce(new Error("timeout waiting for tx"));
    await expect(armDelegateHatch({ owner: owner as unknown as Account, provider: provider as unknown as Provider, venue: "wrap.testnet", method: "near_withdraw", args: {} })).rejects.toThrow(/timeout/);
    expect(owner.deleteKey).toHaveBeenCalledOnce();
    expect(provider.viewAccessKey).not.toHaveBeenCalled();
  });
});

describe("fireHatch", () => {
  const okOutcome = (venue: string) => ({
    status: { SuccessValue: "" },
    transaction_outcome: { id: "TX1", outcome: { status: { SuccessReceiptId: "R1" } } },
    receipts_outcome: [
      { id: "R1", outcome: { executor_id: "alice.testnet", status: { SuccessReceiptId: "R2" } } },
      { id: "R2", outcome: { executor_id: venue, status: { SuccessValue: "" } } },
    ],
  });

  it("relays one SignedDelegate action to the user's account and reports the inner call", async () => {
    const h = await fixedHatch();
    const relayer = { signAndSendTransaction: vi.fn(async (_: any) => okOutcome("wrap.testnet")) };
    const r = await fireHatch(h, relayer as unknown as Account);
    expect(r).toEqual({ tx: "TX1", ok: true });
    const arg = relayer.signAndSendTransaction.mock.calls[0][0];
    expect(arg.receiverId).toBe("alice.testnet");
    expect(arg.actions).toHaveLength(1);
    // What goes on the wire is byte-identical to what the user signed.
    expect(Buffer.from(encodeSignedDelegate(arg.actions[0].signedDelegate))).toEqual(Buffer.from(base64ToBytes(h.signed_delegate!)));
  });

  it("reports failure when the inner call panics even though the transaction succeeded", async () => {
    const h = await fixedHatch();
    const out = okOutcome("wrap.testnet");
    out.receipts_outcome[1].outcome.status = { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: nope" } } } } } as any;
    const relayer = { signAndSendTransaction: vi.fn(async () => out) };
    const r = await fireHatch(h, relayer as unknown as Account);
    expect(r.ok).toBe(false);
    expect(r.tx).toBe("TX1");
    expect(r.error).toMatch(/nope/);
  });

  it("refuses a tampered record without spending the relayer's gas", async () => {
    const h = await fixedHatch();
    const relayer = { signAndSendTransaction: vi.fn() };
    const r = await fireHatch({ ...h, venue: "evil.testnet" }, relayer as unknown as Account);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not verify/);
    expect(relayer.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("returns ok:false with the error when the RPC rejects the transaction", async () => {
    const h = await fixedHatch();
    const relayer = { signAndSendTransaction: vi.fn(async () => Promise.reject(Object.assign(new Error("InvalidTxError"), { context: { transactionHash: "TXE" } }))) };
    expect(await fireHatch(h, relayer as unknown as Account)).toEqual({ tx: "TXE", ok: false, error: "InvalidTxError" });
  });
});

describe("fc-key mode", () => {
  const owner = (calls: any[]) => ({
    accountId: "alice.testnet",
    provider: { getNetworkId: async () => "testnet", viewBlock: async () => ({ header: { height: 5, gas_price: "100000000" } }) },
    addFunctionCallAccessKey: vi.fn(async (a: any) => calls.push(a)),
  });

  it("adds a key limited to the venue and methods, deposit 0, with an allowance", async () => {
    const calls: any[] = [];
    const { hatch, keyPair } = await armFunctionCallHatch({ owner: owner(calls) as unknown as Account, venue: "pool.testnet", methods: ["withdraw_all"], method: "withdraw_all", args: {} });
    expect(calls[0]).toMatchObject({ contractId: "pool.testnet", methodNames: ["withdraw_all"], allowance: 250000000000000000000000n });
    expect(calls[0].publicKey.toString()).toBe(keyPair.getPublicKey().toString());
    expect(hatch).toMatchObject({ mode: "fc-key", deposit: "0", nonce: null, max_block_height: null, signed_delegate: null, created_height: 5, public_key: keyPair.getPublicKey().toString() });
    expect(verifyHatch(hatch).ok).toBe(true);
  });

  it("refuses an allowance too small to send even one call, before adding any key", async () => {
    const calls: any[] = [];
    // 100 Tgas at 1e8 yocto/gas: testnet charged the allowance ~0.1009 NEAR up front (see health.test.ts).
    await expect(
      armFunctionCallHatch({ owner: owner(calls) as unknown as Account, venue: "pool.testnet", methods: ["withdraw_all"], method: "withdraw_all", args: {}, allowance: "50000000000000000000000" }),
    ).rejects.toThrow(/allowance 50000000000000000000000 .*below/);
    expect(calls).toHaveLength(0);
  });

  it("verifyHatch catches an fc-key record edited after arming (args, method, venue: the id no longer matches)", async () => {
    const { hatch } = await armFunctionCallHatch({ owner: owner([]) as unknown as Account, venue: "pool.testnet", methods: ["withdraw_all"], method: "withdraw_all", args: {} });
    for (const edit of [{ args: { amount: "1" } }, { method: "withdraw" }, { venue: "other.testnet" }, { account: "bob.testnet" }]) {
      const v = verifyHatch({ ...hatch, ...edit });
      expect(v.ok).toBe(false);
      expect(v.checks.filter((c) => c.startsWith("FAIL")).join(" ")).toMatch(/id/);
    }
  });

  it("refuses an empty method list (would mean any method) and a method outside the list", async () => {
    await expect(armFunctionCallHatch({ owner: owner([]) as unknown as Account, venue: "v", methods: [], method: "x", args: {} })).rejects.toThrow(/non-empty/);
    await expect(armFunctionCallHatch({ owner: owner([]) as unknown as Account, venue: "v", methods: ["a"], method: "b", args: {} })).rejects.toThrow(/not in methods/);
  });

  it("fireFunctionCallHatch refuses a deposit or a foreign key before sending", async () => {
    const { hatch, keyPair } = await armFunctionCallHatch({ owner: owner([]) as unknown as Account, venue: "pool.testnet", methods: ["withdraw_all"], method: "withdraw_all", args: {} });
    const provider = {} as Provider;
    expect((await fireFunctionCallHatch({ ...hatch, deposit: "1" }, keyPair, provider)).error).toMatch(/cannot attach/);
    expect((await fireFunctionCallHatch(hatch, KEY, provider)).error).toMatch(/hatch key is/);
    expect((await fireHatch(hatch, {} as Account)).error).toMatch(/not a delegate hatch/);
    // An edited record (the key would accept these args too) is refused before anything is signed.
    expect((await fireFunctionCallHatch({ ...hatch, args: { amount: "1" } }, keyPair, provider)).error).toMatch(/does not verify.*id/);
  });
});

describe("recorded Guardian run (2026-11-09)", () => {
  it("its hatch verifies offline with the earlier id form, and edits still fail", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const run = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../data/guardian-run.json"), "utf8"));
    expect(verifyHatch(run.hatch).ok).toBe(true);
    expect(verifyHatch({ ...run.hatch, id: "0000000000000000" }).ok).toBe(false);
    expect(verifyHatch({ ...run.hatch, venue: "evil.testnet" }).ok).toBe(false);
  });
});
