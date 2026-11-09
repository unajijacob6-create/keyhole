// npm run review -- <label> --files a.rs[,b.rs] [--base old.rs[,…]] [--code-hash H]
//                   [--binding reproducible-build|owner-claimed] [--publish-response] [--attest]
// Comments and #[cfg(test)] modules are stripped before review. Writes data/reviews/<label>.json
// (hashes, receipt, summary; the source and, unless --publish-response, the review text stay in memory).
import fs from "node:fs";
import path from "node:path";
import { review, stripRust, verifyReceiptOffline } from "./review.ts";

const argv = process.argv.slice(2);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const label = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"))!;
const read = (list?: string) => (list ? Object.fromEntries(list.split(",").map((f) => [path.basename(f), stripRust(fs.readFileSync(f, "utf8"))])) : undefined);
const files = read(arg("--files"))!;
const base = read(arg("--base"));
const rec = await review({ label, files, base, codeHash: arg("--code-hash"), binding: arg("--binding") as any, publishResponse: argv.includes("--publish-response") });
const v = verifyReceiptOffline(rec);
fs.mkdirSync("data/reviews", { recursive: true });
fs.writeFileSync(`data/reviews/${label}.json`, JSON.stringify(rec, null, 1));
console.log(`model ${rec.model} · risk ${rec.result.risk} · ${rec.result.summary}`);
for (const f of rec.result.findings) console.log(`  [${f.severity}] ${f.category}: ${f.title} (${f.location ?? "?"})`);
console.log(`receipt: chat ${rec.receipt.chat_id} · signer ${rec.receipt.recovered_signer} · verified=${rec.receipt.verified}`);
for (const c of [...rec.receipt.checks, ...v.checks]) console.log(`  - ${c}`);
if (argv.includes("--attest")) {
  if (!rec.code_hash) throw new Error("--attest needs --code-hash");
  const { registryPoster } = await import("../../watcher/src/poster.ts");
  const p = await (await registryPoster({ registry: arg("--registry") })).attest!(rec.code_hash, {
    kind: "AiReview",
    model: rec.model,
    request_sha256: rec.receipt.request_hash,
    response_sha256: rec.receipt.response_hash,
    signer: rec.receipt.recovered_signer,
    chat_id: rec.receipt.chat_id.slice(0, 200),
    verdict_summary: rec.verdict_summary,
  });
  console.log(`registry AiReview #${p.id} (tx ${p.tx})`);
}
