// Record RPC answers for the core unit tests, so they run offline and deterministically.
//   npm run fixtures:record   (needs network; rewrites packages/core/test/fixtures/*.json)
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, recordingTransport, Rpc } from "../packages/core/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "packages/core/test/fixtures");
fs.mkdirSync(DIR, { recursive: true });
const cases: { account: string; history: boolean }[] = [
  { account: "usdt.tether-token.near", history: true },
  { account: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", history: false },
  { account: "v2-verifier.sourcescan.near", history: false },
  { account: "v2-nearx.stader-labs.near", history: false },
  { account: "token.sweat", history: false },
  { account: "wrap.near", history: false },
];
for (const c of process.argv[2] ? cases.filter((x) => x.account === process.argv[2]) : cases) {
  const store: Record<string, { result?: unknown; error?: unknown }> = {};
  const transport = recordingTransport(store);
  const nowMs = Date.now();
  const r = await inspect(c.account, { transport, history: c.history, registry: { rpc: new Rpc({ network: "testnet", transport }) }, checkRepo: false, sourceRoles: false, nowMs });
  const file = path.join(DIR, `${c.account.length > 40 ? c.account.slice(0, 16) : c.account}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ account: c.account, history: c.history, nowMs, expected: { class: r.grade.class, verdict: r.grade.verdict, flags: r.grade.flags }, fixtures: store }), { level: 9 }));
  console.log(`${c.account}: ${r.grade.verdict} ${r.grade.class} ${r.grade.flags.join(",")} — ${Object.keys(store).length} requests, ${(fs.statSync(file).size / 1024).toFixed(0)} KiB`);
}
