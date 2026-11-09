// Record mainnet RPC answers (read-only) and one FastNEAR /v0/account page for
// packages/core/test/pending.test.ts, so the tests run offline and deterministically.
//   NODE_USE_ENV_PROXY=1 npx tsx packages/core/test/fixtures/pending/record.ts
// Rewrites mainnet.json.gz and fastnear-account-page.json next to this file.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { Rpc, recordingTransport, listUpgradeProposals, stagedUpgrade, txApi } from "../../../src/index.ts";

const DIR = import.meta.dirname;
const store: Record<string, { result?: unknown; error?: unknown }> = {};
const rpc = new Rpc({ network: "mainnet", transport: recordingTransport(store) });
const nowMs = Date.now();

// Newest upgrade proposals (one get_proposals page each).
const rainbow = await listUpgradeProposals(rpc, "rainbowbridge.sputnik-dao.near", { last: 6, nowMs });
const ref = await listUpgradeProposals(rpc, "ref-finance.sputnik-dao.near", { last: 3, nowMs });
// Raw pages for the decoder tests: sweat UpgradeRemote up_stage_code / up_deploy_code pairs, intents add_release_info.
await rpc.view("sweat-multisig.sputnik-dao.near", "get_policy");
await rpc.view("sweat-multisig.sputnik-dao.near", "get_proposals", { from_index: 35, limit: 11 });
await rpc.view("intents.sputnik-dao.near", "get_policy");
await rpc.view("intents.sputnik-dao.near", "get_proposals", { from_index: 99, limit: 5 });
await rpc.view("rainbowbridge.sputnik-dao.near", "get_proposal", { id: 219 }); // base64 hash in args
await rpc.view("rainbowbridge.sputnik-dao.near", "get_proposal", { id: 179 }); // malformed JSON args
await rpc.viewAccount("intents.near");
// near-plugins staging: base58 (omni, token.sweat) and raw byte-array (btc-client, factory) formats; intents.near has none.
const staged = [];
for (const c of ["omni.bridge.near", "btc-client.bridge.near", "factory.bridge.near", "token.sweat", "intents.near"]) staged.push(await stagedUpgrade(rpc, c));

fs.writeFileSync(path.join(DIR, "mainnet.json.gz"), zlib.gzipSync(JSON.stringify({ nowMs, fixtures: store }), { level: 9 }));
console.log(`mainnet.json.gz: ${Object.keys(store).length} requests, ${(fs.statSync(path.join(DIR, "mainnet.json.gz")).size / 1024).toFixed(0)} KiB`);
console.log("rainbowbridge", rainbow.map((p) => `${p.id}:${p.state}:${p.code_hash?.slice(0, 6)}`).join(" "));
console.log("ref-finance", ref.map((p) => `${p.id}:${p.state}:${p.code_hash?.slice(0, 6)}`).join(" "));
console.log("staged", staged.map((s) => (s ? `${s.contract}:${s.staged_hash?.slice(0, 6)}:${s.pending}` : "null")).join(" "));

// One real /v0/account page of the ref-finance DAO, trimmed to the fields fetchPendingCode reads.
const page = await txApi("mainnet")("/v0/account", { account_id: "ref-finance.sputnik-dao.near", is_real_receiver: true });
const keep = ["transaction_hash", "tx_block_height", "tx_block_timestamp", "is_real_receiver", "is_success"];
const trimmed = {
  recorded_at: new Date(nowMs).toISOString(),
  request: { account_id: "ref-finance.sputnik-dao.near", is_real_receiver: true },
  txs_count: page.txs_count,
  resume_token: page.resume_token,
  account_txs: page.account_txs.slice(0, 40).map((t: any) => Object.fromEntries(keep.map((k) => [k, t[k]]))),
};
fs.writeFileSync(path.join(DIR, "fastnear-account-page.json"), JSON.stringify(trimmed, null, 1) + "\n");
console.log(`fastnear-account-page.json: ${trimmed.account_txs.length} of ${page.account_txs.length} entries kept`);
