import { describe, it, expect } from "vitest";
import { Rpc, fixtureTransport } from "../../core/src/rpc.ts";
import { requestKey } from "../../core/src/rpc.ts";
import { MIN_LANDING_BLOCKS, hatchHealth, hatchId, type Hatch } from "../src/index.ts";
import { HEAD, KEY_NONCE, TTL, blockFixture, fixedHatch, keyFixture, missingKeyAnswer, type Fixtures } from "./helpers.ts";

const rpcWith = (f: Fixtures, network: "testnet" | "mainnet" = "testnet") => new Rpc({ network, transport: fixtureTransport(f), retries: 0 });
const keyAnswer = (nonce: bigint | number, permission: unknown) => ({ result: { nonce: Number(nonce), permission, block_height: HEAD, block_hash: "11111111111111111111111111111111" } });
const FULL = "FullAccess";
const fcPerm = (receiver_id: string, method_names: string[], allowance: string | null = "250000000000000000000000") => ({ FunctionCall: { allowance, receiver_id, method_names } });

async function delegateHealth(answer: { result?: unknown; error?: unknown }, head = HEAD + 10, h?: Hatch) {
  const hatch = h ?? (await fixedHatch());
  return hatchHealth(rpcWith({ ...blockFixture(head), ...keyFixture(hatch.account, hatch.public_key, answer) }), hatch);
}

describe("hatchHealth — delegate mode", () => {
  it("ARMED: key present, full access, nonce unspent, before max_block_height", async () => {
    const r = await delegateHealth(keyAnswer(KEY_NONCE, FULL));
    expect(r).toEqual({ state: "ARMED", reasons: expect.any(Array), key_nonce: KEY_NONCE.toString(), head: HEAD + 10, blocks_left: TTL - 10 });
  });
  // The chain checks max_block_height at the block where the delegate receipt is applied, which is
  // after the final head this reads: the final head trails the tip, the relayer's transaction lands in a
  // later block, and the delegate receipt runs a block after that (live run: tx in 276977260, delegate
  // receipt in 276977261). So "head == max_block_height" can no longer land.
  it(`EXPIRED once fewer than ${MIN_LANDING_BLOCKS} blocks are left: a transaction sent now lands after max_block_height`, async () => {
    for (const head of [HEAD + TTL, HEAD + TTL - MIN_LANDING_BLOCKS + 1]) {
      const r = await delegateHealth(keyAnswer(KEY_NONCE, FULL), head);
      expect(r.state).toBe("EXPIRED");
      expect(r.blocks_left).toBe(HEAD + TTL - head);
    }
  });
  it(`ARMED with exactly ${MIN_LANDING_BLOCKS} blocks left`, async () => {
    const r = await delegateHealth(keyAnswer(KEY_NONCE, FULL), HEAD + TTL - MIN_LANDING_BLOCKS);
    expect(r.state).toBe("ARMED");
    expect(r.blocks_left).toBe(MIN_LANDING_BLOCKS);
  });
  it("USED: key nonce reached the hatch nonce", async () => {
    const r = await delegateHealth(keyAnswer(KEY_NONCE + 1n, FULL));
    expect(r.state).toBe("USED");
    expect(r.blocks_left).toBeNull();
  });
  it("USED wins over EXPIRED (a fired hatch is fired, whatever the height)", async () => {
    expect((await delegateHealth(keyAnswer(KEY_NONCE + 5n, FULL), HEAD + TTL + 1)).state).toBe("USED");
  });
  it("REVOKED: the RPC says the key does not exist (real testnet answer shape)", async () => {
    const h = await fixedHatch();
    const r = await delegateHealth(missingKeyAnswer(h.public_key), HEAD, h);
    expect(r).toMatchObject({ state: "REVOKED", key_nonce: null, blocks_left: null });
  });
  it("REVOKED: structured UNKNOWN_ACCESS_KEY error from newer nodes", async () => {
    const r = await delegateHealth({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} } } });
    expect(r.state).toBe("REVOKED");
  });
  it("EXPIRED: head past max_block_height", async () => {
    const r = await delegateHealth(keyAnswer(KEY_NONCE, FULL), HEAD + TTL + 1);
    expect(r.state).toBe("EXPIRED");
    expect(r.reasons[0]).toMatch(/past max_block_height/);
  });
  it("STALE: the key was downgraded to a function-call key", async () => {
    const r = await delegateHealth(keyAnswer(KEY_NONCE, fcPerm("wrap.testnet", ["near_withdraw"])));
    expect(r.state).toBe("STALE");
    expect(r.reasons[0]).toMatch(/no longer full access/);
  });
  it("STALE: the record no longer matches its signature", async () => {
    const h = await fixedHatch();
    const bad = { ...h, args: { amount: "1" } };
    const r = await delegateHealth(keyAnswer(KEY_NONCE, FULL), HEAD, bad);
    expect(r.state).toBe("STALE");
    expect(r.reasons.join(" ")).toMatch(/args/);
  });
  it("uses opts.headHeight without asking for a block", async () => {
    const h = await fixedHatch();
    const r = await hatchHealth(rpcWith(keyFixture(h.account, h.public_key, keyAnswer(KEY_NONCE, FULL))), h, { headHeight: HEAD + 1 });
    expect(r.blocks_left).toBe(TTL - 1);
  });
  it("refuses an RPC on the wrong network and surfaces outages", async () => {
    const h = await fixedHatch();
    await expect(hatchHealth(rpcWith({}, "mainnet"), h)).rejects.toThrow(/testnet/);
    await expect(hatchHealth(rpcWith(blockFixture(HEAD)), h)).rejects.toThrow(/no fixture/);
  });
});

describe("hatchHealth — fc-key mode", () => {
  const fcHatch = async (over: Partial<Hatch> = {}): Promise<Hatch> => {
    const h = await fixedHatch();
    const fc: Hatch = { ...h, mode: "fc-key", venue: "pool.testnet", method: "withdraw_all", args: {}, deposit: "0", nonce: null, max_block_height: null, signed_delegate: null, ...over };
    return { ...fc, id: hatchId(fc) };
  };
  const gasPrice = (p: string) => ({ [requestKey("gas_price", [null])]: { result: { gas_price: p } } });
  const health = async (perm: unknown, h?: Hatch, price = "100000000") => {
    const hatch = h ?? (await fcHatch());
    return hatchHealth(rpcWith({ ...blockFixture(HEAD), ...gasPrice(price), ...keyFixture(hatch.account, hatch.public_key, keyAnswer(5, perm)) }), hatch);
  };

  it("ARMED: function-call key for the venue that lists the method", async () => {
    const r = await health(fcPerm("pool.testnet", ["withdraw_all", "unstake_all"]));
    expect(r).toMatchObject({ state: "ARMED", blocks_left: null, key_nonce: "5" });
    expect(r.reasons.join(" ")).toMatch(/allowance left: 250000000000000000000000/);
  });
  it("ARMED: an empty method list means any method", async () => {
    expect((await health(fcPerm("pool.testnet", [], null))).state).toBe("ARMED");
  });
  it("STALE: key is for another receiver", async () => {
    expect((await health(fcPerm("other.testnet", ["withdraw_all"]))).reasons[0]).toMatch(/only call other.testnet/);
  });
  it("STALE: method not in the key's list", async () => {
    const r = await health(fcPerm("pool.testnet", ["unstake_all"]));
    expect(r.state).toBe("STALE");
  });
  it("STALE: a full-access key is far more than an fc-key hatch should hold", async () => {
    expect((await health("FullAccess")).state).toBe("STALE");
  });
  it("STALE: the record needs a deposit", async () => {
    expect((await health(fcPerm("pool.testnet", ["withdraw_all"]), await fcHatch({ deposit: "1" }))).state).toBe("STALE");
  });
  // Testnet refused a 100 Tgas call from a key with 0.005 NEAR allowance on 2026-11-09: "allowance:
  // 5000000000000000000000, cost: 100919362755690500000000", i.e. prepaid gas priced at 1e9 yocto/gas
  // while gas_price said 1e8. The fixed hatch's gas is 30 Tgas: it needs about 0.03 NEAR of allowance.
  it("STALE: the allowance left cannot cover the call's prepaid gas (the node would refuse the transaction)", async () => {
    const r = await health(fcPerm("pool.testnet", ["withdraw_all"], "5000000000000000000000"));
    expect(r.state).toBe("STALE");
    expect(r.reasons[0]).toMatch(/allowance 5000000000000000000000 .*below/);
  });
  it("ARMED: an allowance above that estimate", async () => {
    expect((await health(fcPerm("pool.testnet", ["withdraw_all"], "40000000000000000000000"))).state).toBe("ARMED");
  });
  it("an unlimited allowance needs no gas price lookup", async () => {
    const h = await fcHatch();
    const r = await hatchHealth(rpcWith({ ...blockFixture(HEAD), ...keyFixture(h.account, h.public_key, keyAnswer(5, fcPerm("pool.testnet", ["withdraw_all"], null))) }), h);
    expect(r.state).toBe("ARMED");
  });

  it("REVOKED: key deleted", async () => {
    const h = await fcHatch();
    const r = await hatchHealth(rpcWith({ ...blockFixture(HEAD), ...keyFixture(h.account, h.public_key, missingKeyAnswer(h.public_key)) }), h);
    expect(r.state).toBe("REVOKED");
  });
});
