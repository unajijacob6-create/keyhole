// npm run eval — control-class accuracy on the labelled corpus (hand-labelled mainnet contracts +
// testnet fixtures whose class is true by construction). Writes eval/corpus.json and docs/EVAL.md.
//
// A miss is "conservative" when Keyhole reports a weaker assurance than the truth (e.g. UNRESOLVED
// for a GOVERNED contract), and "dangerous" when it reports a stronger one (e.g. GOVERNED for a
// CUSTODIAL contract). The goal is zero dangerous misses.
import fs from "node:fs";
import { inspect } from "../packages/core/src/index.ts";

const mainnet = JSON.parse(fs.readFileSync("eval/mainnet-labels.json", "utf8"));
const testnet = fs.existsSync("eval/testnet-fixtures.json") ? JSON.parse(fs.readFileSync("eval/testnet-fixtures.json", "utf8")) : { fixtures: [] };
const entries = [
  ...mainnet.entries.map((e: any) => ({ ...e, source: "mainnet, hand-labelled" })),
  ...testnet.fixtures.filter((f: any) => f.expected_class).map((f: any) => ({ account: f.account, network: "testnet", expected_class: f.expected_class, evidence: f.construction, source: "testnet fixture, by construction" })),
];
fs.writeFileSync("eval/corpus.json", JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 1));

// Stronger assurance → weaker: a "dangerous" miss reports a class earlier in this list than the truth.
const ORDER = ["IMMUTABLE", "GOVERNED", "UNRESOLVED", "CUSTODIAL"];
const rows: any[] = [];
for (const e of entries) {
  try {
    const r = await inspect(e.account, { network: e.network, history: false, checkRepo: false });
    const got = r.grade.class;
    const ok = got === e.expected_class;
    const dangerous = !ok && ORDER.includes(got) && ORDER.includes(e.expected_class) && got !== "UNRESOLVED" && ORDER.indexOf(got) < ORDER.indexOf(e.expected_class);
    rows.push({ ...e, got, ok, dangerous, verdict: r.grade.verdict });
    console.log(`${ok ? "[ok]  " : dangerous ? "[DANGER]" : "[miss]"} ${e.account.padEnd(36).slice(0, 36)} expected ${e.expected_class.padEnd(10)} got ${got}`);
  } catch (err) {
    rows.push({ ...e, got: "ERROR", ok: false, dangerous: false, error: String((err as Error).message).slice(0, 120) });
    console.log(`[err]  ${e.account}: ${(err as Error).message}`);
  }
}
const correct = rows.filter((r) => r.ok).length;
const dangerous = rows.filter((r) => r.dangerous).length;
const at = new Date().toISOString();
const md = [
  `# Control-class eval (${at.slice(0, 10)})`,
  "",
  `Run with \`npm run eval\` at ${at.slice(0, 16).replace("T", " ")} UTC against live public RPC. The corpus has ${rows.length} accounts:`,
  `- ${mainnet.entries.length} mainnet contracts, hand-labelled only where the controller is established by protocol facts or by source verified to match the deployed code;`,
  `- ${rows.length - mainnet.entries.length} testnet fixtures whose class is true by construction (\`scripts/eval-fixtures.ts\`).`,
  "",
  `**${correct}/${rows.length} correct (${Math.round((100 * correct) / Math.max(1, rows.length))}%); ${dangerous} dangerous miss(es)** (Keyhole reporting a stronger assurance than the truth). Conservative misses (a weaker assurance, usually UNRESOLVED) are listed below.`,
  "",
  "| account | source | expected | Keyhole | result |",
  "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.account.length > 30 ? r.account.slice(0, 12) + "…" + r.account.slice(-8) : r.account} | ${r.source} | ${r.expected_class} | ${r.got} | ${r.ok ? "ok" : r.dangerous ? "**dangerous**" : "conservative miss"} |`),
  "",
  "Ground-truth evidence for every row is in `eval/corpus.json`. Excluded from accuracy because the truth could not be established:",
  ...mainnet.unlabelled.map((u: any) => `- ${u.account}: ${u.why}`),
];
fs.writeFileSync("docs/EVAL.md", md.join("\n") + "\n");
console.log(`\n${correct}/${rows.length} correct, ${dangerous} dangerous`);
process.exit(dangerous ? 1 : 0);
