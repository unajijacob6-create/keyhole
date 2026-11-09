// The Guardian replay (scripts/lib/replay.ts) against recorded testnet archival RPC answers
// (fixtures/guardian-replay-rpc.json.gz, written by record-replay-fixture.ts): the real recording
// passes, and every altered copy of it fails at the check that should catch it. Offline.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { base58, Rpc, type Transport } from "../../packages/core/src/index.ts";
import type { TxApi } from "../../packages/core/src/index.ts";
import { pickReplayLines, replayGuardianRecording, REQUIRED_CHECKS, REQUIRED_STEPS, signedDelegateFromView } from "../lib/replay.ts";
import { findExecutingVote } from "../lib/vote-timing.ts";
import { clone, fixtureKey, TAMPERS } from "./replay-tampers.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(fs.readFileSync(path.join(HERE, "../../data/guardian-run.json"), "utf8"));
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, "fixtures/guardian-replay-rpc.json.gz"))).toString());

async function replay(recording: any, answers: Record<string, any> = fx.answers) {
  const misses: string[] = [];
  const transport: Transport = async (_url, body) => {
    const f = answers[fixtureKey(body)];
    if (!f) {
      misses.push(fixtureKey(body).slice(0, 160));
      throw new Error(`no fixture for ${fixtureKey(body).slice(0, 160)}`);
    }
    return { status: 200, json: f.error ? { jsonrpc: "2.0", id: "keyhole", error: f.error } : { jsonrpc: "2.0", id: "keyhole", result: f.result } };
  };
  const lines: string[] = [];
  const ok = await replayGuardianRecording(recording, { rpc: new Rpc({ network: "testnet", url: fx.source, transport, retries: 0 }), log: (l) => lines.push(l) });
  const bad = lines.map((l) => l.trim()).filter((l) => l.startsWith("XX")).map((l) => l.slice(4).trim());
  return { ok, lines, bad, misses };
}

describe("guardian replay: the real recording", () => {
  it("passes every check, and every required check ran", async () => {
    const r = await replay(clone(run));
    expect(r.misses).toEqual([]);
    expect(r.bad).toEqual([]);
    expect(r.ok).toBe(true);
    // one line per required check, plus the optional ai_review step this run has
    const expected = REQUIRED_CHECKS.length + 1;
    expect(r.lines.at(-1)).toBe(`\nall ${expected} checks passed: the recording matches the chain`);
    const p = pickReplayLines(r.lines);
    expect(p.missing).toEqual([]);
    expect(p.passed).toBe(true);
  });

  it("derives the order from the receipts: withdraw before the block in which the new code landed", async () => {
    const r = await replay(clone(run));
    const order = r.lines.map((l) => l.trim()).find((l) => l.startsWith("ok  hatch at block"));
    expect(order).toBe("ok  hatch at block 276976501 < deciding vote at block 276976524 (23 blocks earlier); Alice's withdraw ran at 276976503, the new code landed at 276976527");
  });
});

describe("guardian replay: altered recordings fail", () => {
  for (const t of TAMPERS) {
    it(t.name, async () => {
      const rec = clone(run);
      t.apply(rec);
      const r = await replay(rec);
      expect(r.misses).toEqual([]);
      expect(r.ok).toBe(false);
      for (const re of t.expect) expect(r.bad.some((l) => re.test(l)), `${re} in:\n${r.bad.join("\n")}`).toBe(true);
    });
  }

  // Same sender, receiver, nonce and key as the recorded hatch, but the chain ran something else: only
  // a byte-for-byte comparison of the signed delegate catches it.
  for (const [what, change] of [
    ["max_block_height", (d: any) => (d.delegate_action.max_block_height += 1)],
    ["method", (d: any) => (d.delegate_action.actions[0].FunctionCall.method_name = "withdraw")],
    ["args", (d: any) => (d.delegate_action.actions[0].FunctionCall.args = Buffer.from('{"to":"x.testnet"}').toString("base64"))],
    ["deposit", (d: any) => (d.delegate_action.actions[0].FunctionCall.deposit = "2")],
    ["signature", (d: any) => {
      const sig = base58.decode(d.signature.split(":")[1]);
      sig[0] ^= 0x01;
      d.signature = "ed25519:" + base58.encode(sig);
    }],
    ["signature length", (d: any) => (d.signature = "ed25519:" + "2".repeat(64))],
  ] as const) {
    it(`the chain's delegate differs from the recorded hatch (${what})`, async () => {
      const answers = clone(fx.answers);
      const key = `EXPERIMENTAL_tx_status ${JSON.stringify({ tx_hash: run.tx.hatch_fired })}`;
      change(answers[key].result.transaction.actions[0].Delegate);
      const r = await replay(clone(run), answers);
      expect(r.misses).toEqual([]);
      expect(r.ok).toBe(false);
      expect(r.bad.some((l) => /^guardian tx .* byte for byte \(DIFFERENT/.test(l)), r.bad.join("\n")).toBe(true);
    });
  }

  it("every required step is mandatory", async () => {
    for (const key of REQUIRED_STEPS) {
      const rec = clone(run);
      delete rec.tx[key];
      const r = await replay(rec);
      expect(r.ok, key).toBe(false);
      expect(r.bad.some((l) => l.startsWith(`${key}: MISSING from the recording`)), key).toBe(true);
    }
  });
});

describe("signedDelegateFromView", () => {
  const view = fx.answers[`EXPERIMENTAL_tx_status ${JSON.stringify({ tx_hash: run.tx.hatch_fired })}`].result.transaction.actions[0].Delegate;

  it("re-encodes the chain's delegate to exactly the bytes Alice signed", () => {
    expect(signedDelegateFromView(view)).toBe(run.hatch.signed_delegate);
  });

  it("differs when any signed field differs", () => {
    const other = (f: (v: any) => void) => {
      const v = clone(view);
      f(v);
      return signedDelegateFromView(v);
    };
    expect(other((v) => (v.delegate_action.max_block_height += 1))).not.toBe(run.hatch.signed_delegate);
    expect(other((v) => (v.delegate_action.actions[0].FunctionCall.method_name = "sweep"))).not.toBe(run.hatch.signed_delegate);
    expect(other((v) => (v.delegate_action.actions[0].FunctionCall.args = "e30K"))).not.toBe(run.hatch.signed_delegate);
    expect(other((v) => (v.signature = "ed25519:" + "1".repeat(64)))).not.toBe(run.hatch.signed_delegate);
    expect(other((v) => v.delegate_action.actions.push({ Transfer: { deposit: "1" } }))).toBeNull();
  });
});

describe("pickReplayLines (judge check 8)", () => {
  it("names a missing line instead of dropping it", async () => {
    const r = await replay(clone(run));
    const p = pickReplayLines(r.lines.filter((l) => !l.trim().startsWith("ok  diff")));
    expect(p.missing).toEqual(["ok  diff"]);
  });
  it("does not pass a replay with a failed check", () => {
    expect(pickReplayLines(["  XX  something", "", "all 3 checks passed: the recording matches the chain"]).passed).toBe(false);
  });
});

describe("findExecutingVote (judge check 10)", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const tx = (hash: string, method: string, args: unknown, receipts: [string, number][]) => ({
    transaction: { hash, signer_id: `${hash}.near`, receiver_id: "dao.near", actions: [{ FunctionCall: { method_name: method, args: b64(args) } }] },
    receipts: receipts.map(([r, h]) => ({ receipt: { receiver_id: r }, execution_outcome: { block_height: h } })),
  });
  const txs = [
    tx("exec", "act_proposal", { id: 7, action: "VoteApprove" }, [["dao.near", 101], ["target.near", 102], ["target.near", 104]]),
    tx("other", "act_proposal", { id: 8, action: "VoteApprove" }, [["dao.near", 91], ["target.near", 92]]),
    tx("first", "act_proposal", { id: 7, action: "VoteApprove" }, [["dao.near", 81]]),
    tx("blob", "store_blob", {}, [["dao.near", 71]]),
  ];
  const api: TxApi = async (p, body: any) =>
    p === "/v0/account"
      ? { account_txs: txs.map((t, i) => ({ transaction_hash: t.transaction.hash, tx_block_height: 100 - 10 * i, is_success: true })) }
      : { transactions: txs.filter((t) => body.tx_hashes.includes(t.transaction.hash)) };

  it("returns the vote whose receipts reached the target, not an earlier approval or another proposal", async () => {
    expect(await findExecutingVote({ api, dao: "dao.near", id: 7, target: "target.near" })).toEqual({ tx: "exec", signer: "exec.near", txHeight: 100, execHeight: 102 });
  });
  it("returns null when no vote executed the proposal", async () => {
    expect(await findExecutingVote({ api, dao: "dao.near", id: 9, target: "target.near" })).toBeNull();
  });
});
