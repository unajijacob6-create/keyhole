// The extractor on real testnet blocks recorded from neardata (the demo's deploys).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { extractEvents, summarizeTransactions } from "../src/extract.ts";

const load = (h: number) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(import.meta.dirname, "fixtures", `testnet-${h}.json.gz`))).toString());

describe("extractEvents", () => {
  it("v1 deploy (block 276951469): a direct DeployContract transaction with the new code hash", () => {
    const ev = extractEvents(load(276951469)).filter((e) => e.account === "vault.keyhole.testnet");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "DeployContract", origin: "transaction", newHash: "EQSLPGJe4YESdC38nTVT2DQvgWSLkDHjQuw2sxp5oPKt", height: 276951469 });
  });
  it("v2 silent redeploy (block 276953895): new hash is the reproducible v2 build", () => {
    const ev = extractEvents(load(276953895)).filter((e) => e.account === "vault.keyhole.testnet");
    expect(ev.map((e) => e.kind)).toEqual(["DeployContract"]);
    expect(ev[0].newHash).toBe("BJU8rR1MjywGrqRxGnDeu8EenKyUfQEeAXjGPKmJTrKA");
  });
  it("classifies a self-upgrade through a contract method as a contract receipt", () => {
    const block = {
      block: { header: { height: 10, timestamp_nanosec: "1000000000" } },
      shards: [
        {
          chunk: { transactions: [{ transaction: { hash: "T1", signer_id: "owner.near", receiver_id: "c.near", actions: [{ FunctionCall: { method_name: "upgrade", args: "", gas: 1, deposit: "0" } }] } }] },
          receipt_execution_outcomes: [
            { tx_hash: "T1", receipt: { receipt_id: "R2", predecessor_id: "c.near", receiver_id: "c.near", receipt: { Action: { signer_id: "owner.near", actions: [{ DeployContract: { code: "xyjvIv0T3WEpnLG7VeIfaznSmzOeqmET54lgSJIPju8=" } }] } } }, execution_outcome: { outcome: { status: { SuccessValue: "" } } } },
          ],
        },
      ],
    };
    const [e] = extractEvents(block);
    expect(e).toMatchObject({ kind: "DeployContract", origin: "contract-receipt", account: "c.near", newHash: "EQSLPGJe4YESdC38nTVT2DQvgWSLkDHjQuw2sxp5oPKt" });
  });
  it("meta-transactions (Delegate) and failed receipts", () => {
    const delegateTx = { transaction: { hash: "T2", signer_id: "relayer.near", receiver_id: "alice.near", actions: [{ Delegate: { delegate_action: { sender_id: "alice.near", receiver_id: "alice.near", actions: [{ AddKey: {} }] }, signature: "s" } }] } };
    const outcome = (status: object) => ({ tx_hash: "T2", receipt: { receipt_id: "R3", predecessor_id: "alice.near", receiver_id: "alice.near", receipt: { Action: { signer_id: "alice.near", actions: [{ AddKey: { public_key: "ed25519:k", access_key: { nonce: 0, permission: "FullAccess" } } }] } } }, execution_outcome: { outcome: { status } } });
    const mk = (status: object) => ({ block: { header: { height: 11, timestamp_nanosec: "1" } }, shards: [{ chunk: { transactions: [delegateTx] }, receipt_execution_outcomes: [outcome(status)] }] });
    expect(extractEvents(mk({ SuccessValue: "" }))[0]).toMatchObject({ kind: "AddFullAccessKey", origin: "meta-transaction", publicKey: "ed25519:k" });
    expect(extractEvents(mk({ Failure: {} }))).toEqual([]);
    expect(summarizeTransactions(mk({ SuccessValue: "" })).get("T2")?.delegate?.sender).toBe("alice.near");
  });
  it("global contract usage by account id", () => {
    const block = { block: { header: { height: 12, timestamp_nanosec: "1" } }, shards: [{ chunk: { transactions: [] }, receipt_execution_outcomes: [{ tx_hash: null, receipt: { receipt_id: "R", predecessor_id: "u.near", receiver_id: "u.near", receipt: { Action: { signer_id: "u.near", actions: [{ UseGlobalContractByAccountId: { account_id: "pub.near" } }] } } }, execution_outcome: { outcome: { status: { SuccessValue: "" } } } }] }] };
    expect(extractEvents(block)[0]).toMatchObject({ kind: "UseGlobalContract", global: { by: "account", ref: "pub.near" } });
  });
});
