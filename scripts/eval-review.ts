// npm run eval:review — run the seeded AI-review eval in a NEAR AI Cloud TEE and write
// docs/EVAL_REVIEW.md + data/eval-review.json. Each call carries a verified receipt.
import fs from "node:fs";
import { CASES, V1 } from "../reviewer/eval/cases.ts";
import { review, verifyReceiptOffline } from "../reviewer/src/review.ts";

const rows: any[] = [];
for (const c of CASES) {
  const rec = await review({ label: `eval-${c.id}`, files: { "lib.rs": c.source }, base: { "lib.rs": V1 } });
  const v = verifyReceiptOffline(rec);
  const flagged = rec.result.risk === "high" || rec.result.risk === "medium";
  const categoryHit = !c.expect || rec.result.findings.some((f) => c.expect!.includes(f.category) && (f.severity === "high" || f.severity === "medium"));
  const correct = c.malicious ? flagged && categoryHit : !flagged;
  rows.push({ id: c.id, malicious: c.malicious, description: c.description, risk: rec.result.risk, categories: rec.result.findings.map((f) => `${f.severity}:${f.category}`), summary: rec.result.summary, correct, receipt_verified: v.ok, chat_id: rec.receipt.chat_id, model: rec.model, signer: rec.receipt.recovered_signer });
  console.log(`${correct ? "[ok]  " : "[MISS]"} ${c.id.padEnd(24)} risk=${rec.result.risk.padEnd(6)} ${rec.result.findings.map((f) => `${f.severity}:${f.category}`).join(",") || "-"}  receipt=${v.ok ? "verified" : "NOT verified"}`);
}
const mal = rows.filter((r) => r.malicious);
const ben = rows.filter((r) => !r.malicious);
const caught = mal.filter((r) => r.correct).length;
const fp = ben.filter((r) => !r.correct).length;
const at = new Date().toISOString();
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/eval-review.json", JSON.stringify({ at, model: rows[0]?.model, rows }, null, 1));
const md = [
  `# AI review eval (${at.slice(0, 10)})`,
  "",
  `Run with \`npm run eval:review\` at ${at.slice(0, 16).replace("T", " ")} UTC, model \`${rows[0]?.model}\` in a NEAR AI Cloud TEE. Each case edits the honest demo vault (comments and tests stripped) and asks for a review of the diff. A malicious case counts as caught when the review reports medium or high risk *and* a finding in the expected category. A benign case is a false alarm if it is flagged medium or high.`,
  "",
  `**Caught ${caught} of ${mal.length} seeded malicious diffs; ${fp} false alarm(s) on ${ben.length} benign diffs.** Every call's receipt verified: ${rows.every((r) => r.receipt_verified) ? "yes" : "no"}. This is evidence about one model on seven small diffs, not proof of review quality; an AI review changes a grade only by the fixed rules in [GRADING.md](GRADING.md).`,
  "",
  "| case | seeded change | expected | model risk | findings | result |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.description} | ${r.malicious ? CASES.find((c) => c.id === r.id)!.expect!.join(" or ") : "no flag"} | ${r.risk} | ${r.categories.join(", ") || "-"} | ${r.correct ? "ok" : "miss"} |`),
  "",
  "Receipts (chat id → TEE signer) are in `data/eval-review.json`.",
];
fs.writeFileSync("docs/EVAL_REVIEW.md", md.join("\n") + "\n");
console.log(`\ncaught ${caught}/${mal.length}, false alarms ${fp}/${ben.length}`);
