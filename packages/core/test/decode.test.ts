import { describe, it, expect } from "vitest";
import { decodeTransactions, formatNear } from "../src/decode.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

describe("decodeTransactions", () => {
  it("wallet-selector ft_transfer_call: trusts the token and the receiver, decodes msg", () => {
    const [tx] = decodeTransactions({
      signerId: "alice.near",
      receiverId: "usdt.tether-token.near",
      actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { receiver_id: "intents.near", amount: "1000000", msg: '{"receiver_id":"alice.near"}' }, gas: "100000000000000", deposit: "1" } }],
    });
    expect(tx.inspect).toEqual(["usdt.tether-token.near", "intents.near"]);
    expect(tx.actions[0].details?.msg).toEqual({ receiver_id: "alice.near" });
    expect(tx.actions[0].text).toContain("intents.near");
  });
  it("RPC ActionView shapes, base64 args, DeployContract and full-access AddKey are high risk", () => {
    const [tx] = decodeTransactions({
      signer_id: "bob.near",
      receiver_id: "bob.near",
      actions: [{ DeployContract: { code: "AAAA" } }, { AddKey: { public_key: "ed25519:abc", access_key: { nonce: 0, permission: "FullAccess" } } }, { FunctionCall: { method_name: "upgrade", args: b64({}), gas: 1, deposit: "0" } }],
    });
    expect(tx.actions.map((a) => a.risk)).toEqual(["high", "high", "high"]);
    expect(tx.actions[1].text).toMatch(/FULL-ACCESS/);
  });
  it("function-call key: shows receiver, methods and allowance", () => {
    const [tx] = decodeTransactions({ receiverId: "a.near", actions: [{ type: "AddKey", params: { publicKey: "ed25519:k", accessKey: { permission: { receiverId: "vault.near", methodNames: ["deposit"], allowance: "250000000000000000000000" } } } }] });
    expect(tx.actions[0].text).toContain("vault.near");
    expect(tx.actions[0].text).toContain("0.25 NEAR");
  });
  it("Delegate (meta-transaction) decodes inner actions against the inner receiver", () => {
    const [tx] = decodeTransactions({ receiver_id: "relayer.near", actions: [{ Delegate: { delegate_action: { sender_id: "carol.near", receiver_id: "game.near", actions: [{ FunctionCall: { method_name: "play", args: b64({}), gas: 1, deposit: "0" } }] }, signature: "x" } }] });
    expect(tx.actions[0].kind).toBe("Delegate");
    expect(tx.actions[1].text).toContain("game.near.play");
    expect(tx.inspect).toEqual(["game.near"]);
  });
  it("UseGlobalContractByAccountId names the publisher", () => {
    const [tx] = decodeTransactions({ receiver_id: "me.near", actions: [{ UseGlobalContractByAccountId: { account_id: "pub.near" } }] });
    expect(tx.inspect).toEqual(["pub.near"]);
  });
  it("formats yocto amounts", () => {
    expect(formatNear("1000000000000000000000000")).toBe("1 NEAR");
    expect(formatNear("1")).toBe("1 yoctoNEAR");
    expect(formatNear("250000000000000000000000")).toBe("0.25 NEAR");
    expect(formatNear("0")).toBe("0 NEAR");
  });
});
