// Records the testnet archival RPC answers the Guardian replay needs (for the real recording and for
// every tamper case in replay-tampers.ts) into scripts/test/fixtures/guardian-replay-rpc.json.gz,
// so scripts/test/replay.test.ts runs offline. Read-only, no keys:
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/test/record-replay-fixture.ts
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ARCHIVAL_RPC, fetchTransport, Rpc, type Transport } from "../../packages/core/src/index.ts";
import { replayGuardianRecording } from "../lib/replay.ts";
import { clone, fixtureKey, TAMPERS } from "./replay-tampers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = JSON.parse(fs.readFileSync(path.join(ROOT, "data/guardian-run.json"), "utf8"));
const store: Record<string, { result?: unknown; error?: unknown }> = {};
const recording: Transport = async (url, body) => {
  // Archival answers pinned to a block or a tx never change: answer a repeat from what was recorded.
  const seen = store[fixtureKey(body)];
  if (seen) return { status: 200, json: seen.error ? { jsonrpc: "2.0", id: "keyhole", error: seen.error } : { jsonrpc: "2.0", id: "keyhole", result: seen.result } };
  const res = await fetchTransport(url, body);
  const j = res.json as any;
  if (j && res.status === 200) store[fixtureKey(body)] = j.error ? { error: j.error } : { result: j.result };
  return res;
};
const rpc = () => new Rpc({ network: "testnet", url: ARCHIVAL_RPC.testnet, transport: recording });

const ok = await replayGuardianRecording(clone(run), { rpc: rpc(), log: () => {} });
console.log(`real recording: ${ok ? "pass" : "FAIL"}`);
for (const t of TAMPERS) {
  const r = clone(run);
  t.apply(r);
  const passed = await replayGuardianRecording(r, { rpc: rpc(), log: () => {} });
  console.log(`${passed ? "PASSED (bad)" : "fails"}: ${t.name}`);
}
const out = path.join(ROOT, "scripts/test/fixtures/guardian-replay-rpc.json.gz");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify({ source: ARCHIVAL_RPC.testnet, recordedAt: new Date().toISOString(), recording: "data/guardian-run.json", answers: store })));
console.log(`${Object.keys(store).length} answers → ${path.relative(ROOT, out)} (${fs.statSync(out).size} bytes)`);
