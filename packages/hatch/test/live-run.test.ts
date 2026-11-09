// Replays the recorded live testnet run (scripts/hatch-live.ts → fixtures/live-run.json): the real hatch
// records verify offline, and judgeOutcome reads the real on-chain outcomes the way fireHatch did.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "../../core/src/hash.ts";
import { Rpc, fixtureTransport } from "../../core/src/rpc.ts";
import { decodeHatch, judgeOutcome, verifyHatch, type Hatch } from "../src/index.ts";

const run = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/live-run.json"), "utf8"));
const rpc = new Rpc({ network: "testnet", transport: fixtureTransport(run.outcomes), retries: 0 });
const outcome = (name: string, sender: string) => rpc.call("tx", { tx_hash: run.txs[name], sender_account_id: sender, wait_until: "FINAL" });

describe("live testnet run", () => {
  const hatch = run.hatch as Hatch;

  it("the delegate hatch that was fired on testnet verifies offline", () => {
    const v = verifyHatch(hatch);
    expect(v.ok).toBe(true);
    const d = decodeHatch(hatch);
    expect(d).toMatchObject({ senderId: run.user, receiverId: "wrap.testnet", publicKey: hatch.public_key });
    expect(d.actions).toEqual([{ kind: "functionCall", method: "near_withdraw", args: hatch.args, deposit: "1", gas: hatch.gas }]);
  });

  it("and would not verify with the receiver swapped", () => {
    expect(verifyHatch({ ...hatch, venue: "evil.testnet" }).ok).toBe(false);
  });

  it("fire: the relayed delegate's inner near_withdraw succeeded", async () => {
    const r = await outcome("fire_delegate", run.relayer);
    expect(judgeOutcome(r, "wrap.testnet")).toEqual({ ok: true });
    // The outer receipt runs on the user, the inner call on the venue, which pays the user amount + 1.
    const execs = r.receipts_outcome.map((o: any) => o.outcome.executor_id);
    expect(execs.slice(0, 3)).toEqual([run.user, "wrap.testnet", run.user]);
  });

  it("replay: the chain rejected the spent nonce, and judgeOutcome says so", async () => {
    const j = judgeOutcome(await outcome("replay_delegate", run.relayer), "wrap.testnet");
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/DelegateActionInvalidNonce/);
  });

  it("fc-key to a 1-yocto method: the transaction landed but the venue panicked", async () => {
    const j = judgeOutcome(await outcome("fc_wrap_fire", run.user), "wrap.testnet");
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/Requires attached deposit of exactly 1 yoctoNEAR/);
  });

  it("fc-key to the staking pool's withdraw_all succeeded", async () => {
    expect(judgeOutcome(await outcome("fc_pool_fire", run.user), run.pool)).toEqual({ ok: true });
  });

  it("states recorded during the run", () => {
    expect(run.health_armed.state).toBe("ARMED");
    expect(run.health_used.state).toBe("USED");
    expect(run.fc_health_armed.state).toBe("ARMED");
    expect(run.fc_deposit_rejected).toMatch(/Deposit is not allowed with function call/);
  });

  it("contains no private key material", () => {
    expect(JSON.stringify(run)).not.toMatch(/private_key|secret/i);
  });

  // A near-api-js ed25519 secret key is base58(seed ‖ public key), 64 bytes: the same length as a
  // signature, so a name check alone would miss one stored under an innocent key. Every 64-byte value
  // must instead be a signature, and none may end in a public key that appears in the run.
  it("every 64-byte base58 value is an on-chain signature, not a secret key of a key in the run", () => {
    const text = JSON.stringify(run);
    const pubs = new Set([...text.matchAll(/ed25519:([1-9A-HJ-NP-Za-km-z]{43,44})(?![1-9A-HJ-NP-Za-km-z])/g)].map((m) => Buffer.from(base58.decode(m[1])).toString("hex")));
    expect(pubs.size).toBeGreaterThanOrEqual(3); // the delegate key and the two fc keys at least
    const long: { path: string; bytes: Uint8Array }[] = [];
    const walk = (v: unknown, p: string) => {
      if (typeof v === "string") {
        for (const m of v.matchAll(/(?:ed25519:)?([1-9A-HJ-NP-Za-km-z]{80,90})(?![1-9A-HJ-NP-Za-km-z])/g)) {
          const b = base58.decode(m[1]);
          if (b.length === 64) long.push({ path: p, bytes: b });
        }
      } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    };
    walk(run, "run");
    expect(long.length).toBeGreaterThan(0);
    for (const { path: p, bytes } of long) {
      expect(p).toMatch(/\.signature$|\.signatures\.\d+$/);
      expect(pubs.has(Buffer.from(bytes.slice(32)).toString("hex"))).toBe(false);
    }
    // The signed delegate itself carries a signature but no secret: it is borsh, decoded by verifyHatch above.
  });
});
