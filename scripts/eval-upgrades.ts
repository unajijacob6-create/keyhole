// npm run eval:upgrades — replay real mainnet upgrade proposals and seeded attacks through the
// pending-upgrade grader, and measure how long each real proposal took to execute.
//
// Real set (read-only, mainnet): the last N proposals of DAOs that govern large NEAR contracts.
// For every executed upgrade we fetch the exact bytes the DAO stored (store_blob args), the code it
// replaced (archival view_code just before the change), find the block where the code changed
// (archival bisection), and grade the change as Keyhole would have graded it before the vote.
// No known incident is attached to any of these upgrades, so every STOP on them is counted as a
// false alarm for the auto-fire policy (an assumption, stated in the report).
//
// Seeded set: the guarded vault's honest build against each variant in contracts/out
// (benign-v2, evil-sweep, evil-addkey, evil-owner, evil-fee) and demo-vault v1 -> v2.
//
// Output: eval/upgrades.json (full rows) and docs/EVAL_UPGRADES.md (tables). --offline re-grades the
// cached rows in eval/upgrades.json without network (CI), so rule changes are re-scored instantly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeWasm,
  ARCHIVAL_RPC,
  codeHash,
  effectiveHash,
  fetchPendingCode,
  gradeUpgrade,
  listUpgradeProposals,
  Rpc,
  sourcescan,
  txApi,
  type UpgradeProposal,
  type WasmAnalysis,
} from "../packages/core/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "eval/upgrades.json");
const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const LAST = Number(argv.includes("--last") ? argv[argv.indexOf("--last") + 1] : 200);
import { DAOS } from "./lib/daos.ts";

interface Row {
  dao: string;
  id: number;
  kind: string;
  target: string;
  method: string | null;
  hash: string;
  state: string;
  submitted_at: string;
  votes: string;
  bytes: number | null;
  blob_tx: string | null;
  changed_at_height: number | null;
  changed_at: string | null;
  window_s: number | null;
  prev_hash: string | null;
  sourcescan: boolean | null;
  /** Compact analyses, so --offline can re-grade without the wasm. */
  live: WasmAnalysis | null;
  pending: WasmAnalysis | null;
  verdict: string;
  flags: string[];
  summary: string[];
  note?: string;
}

function compact(a: WasmAnalysis): WasmAnalysis {
  return { ...a, imports: a.imports, exports: a.exports }; // analyses are already small (names only)
}
const summarize = (g: ReturnType<typeof gradeUpgrade>) => {
  const d = g.diff;
  if (!d) return [];
  return [
    ...(d.addedMethods.length ? [`+ ${d.addedMethods.join(", ")}`] : []),
    ...(d.removedMethods.length ? [`- ${d.removedMethods.join(", ")}`] : []),
    ...d.newlyReachable.map((n) => `${n.capability} ← ${n.methods.join(", ")}`),
    ...(d.addedCapabilities.length ? [`new capabilities: ${d.addedCapabilities.join(", ")}`] : []),
  ];
};

async function realRows(): Promise<Row[]> {
  const rpc = new Rpc({ network: "mainnet" });
  const arch = new Rpc({ network: "mainnet", url: ARCHIVAL_RPC.mainnet });
  const api = txApi("mainnet");
  const head = (await rpc.block()).header;
  const rows: Row[] = [];
  const blockTime = async (h: number) => Number(BigInt((await arch.block({ block_id: h })).header.timestamp) / 1_000_000n);
  for (const dao of DAOS) {
    const props: UpgradeProposal[] = await listUpgradeProposals(rpc, dao, { last: LAST, nowMs: Number(BigInt(head.timestamp) / 1_000_000n) });
    console.log(`${dao}: ${props.length} upgrade-related proposals in the last ${LAST}`);
    for (const p of props) {
      if (!p.code_hash) continue;
      const row: Row = {
        dao, id: p.id, kind: p.kind, target: p.target, method: p.method, hash: p.code_hash, state: p.state,
        submitted_at: new Date(p.submitted_at_ms).toISOString(), votes: `${p.votes.approve}/${p.required ?? "?"}`,
        bytes: null, blob_tx: null, changed_at_height: null, changed_at: null, window_s: null, prev_hash: null, sourcescan: null,
        live: null, pending: null, verdict: "", flags: [], summary: [],
      };
      try {
        const blob = await fetchPendingCode({ api, dao, hash: p.code_hash, maxPages: 40 });
        let pendingBytes = blob?.code ?? null;
        if (blob) {
          row.bytes = blob.code.length;
          row.blob_tx = blob.tx;
        }
        // Where did the code change? Bisect from the blob's block (or the submission) to head on
        // "code differs from what was there at lo". Verified afterwards against the proposal hash.
        if (p.state === "executed") {
          let lo = blob?.height ?? null;
          if (lo === null) {
            // find a height at/after submission by timestamp bisection
            let a = 9820210, b = head.height;
            while (b - a > 1) {
              const m = Math.floor((a + b) / 2);
              if ((await blockTime(m)) < p.submitted_at_ms) a = m;
              else b = m;
            }
            lo = a;
          }
          const before = effectiveHash(await arch.viewAccount(p.target, lo));
          row.prev_hash = before;
          if (before !== p.code_hash) {
            let a = lo, b = head.height;
            while (b - a > 1) {
              const m = Math.floor((a + b) / 2);
              let h: string;
              try {
                h = effectiveHash(await arch.viewAccount(p.target, m));
              } catch {
                a = m;
                continue;
              }
              if (h !== before) b = m;
              else a = m;
            }
            const after = effectiveHash(await arch.viewAccount(p.target, b));
            if (after === p.code_hash) {
              row.changed_at_height = b;
              const t = await blockTime(b);
              row.changed_at = new Date(t).toISOString();
              row.window_s = Math.round((t - p.submitted_at_ms) / 1000);
              if (!pendingBytes) pendingBytes = (await arch.viewCode(p.target, b)).code;
              row.live = compact(analyzeWasm((await arch.viewCode(p.target, b - 1)).code));
            } else row.note = `code after first change is ${after}, not the proposal hash`;
          } else row.note = "target already had this code when the blob was stored";
        } else {
          row.live = compact(analyzeWasm((await rpc.viewCode(p.target)).code));
        }
        if (pendingBytes) {
          if ((await codeHash(pendingBytes)) !== p.code_hash) throw new Error("pending bytes do not hash to the proposal hash");
          row.pending = compact(analyzeWasm(pendingBytes));
        }
        const ss = await sourcescan(rpc, p.target, p.code_hash);
        row.sourcescan = ss.status === "verified" ? true : ss.status === "unknown" ? null : false;
      } catch (e) {
        row.note = `error: ${String((e as Error).message).slice(0, 160)}`;
      }
      rows.push(row);
      console.log(`  #${p.id} ${p.kind} ${p.target} ${p.state} window=${row.window_s ?? "-"}s bytes=${row.bytes ?? "-"} ${row.note ?? ""}`);
    }
  }
  return rows;
}

async function seededRows(): Promise<(Row & { expect: "STOP" | "not-STOP"; label: string })[]> {
  const out: (Row & { expect: "STOP" | "not-STOP"; label: string })[] = [];
  const read = (f: string) => (fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null);
  const pairs: [string, string, string, "STOP" | "not-STOP"][] = [
    ["guarded vault → benign v1.1 (adds a view)", "contracts/out/guarded_vault.wasm", "contracts/out/guarded_vault_benign_v2.wasm", "not-STOP"],
    ["guarded vault → sweep backdoor", "contracts/out/guarded_vault.wasm", "contracts/out/guarded_vault_evil_sweep.wasm", "STOP"],
    ["guarded vault → unchecked add_owner_key", "contracts/out/guarded_vault.wasm", "contracts/out/guarded_vault_evil_addkey.wasm", "STOP"],
    ["guarded vault → unchecked set_owner", "contracts/out/guarded_vault.wasm", "contracts/out/guarded_vault_evil_owner.wasm", "STOP"],
    ["guarded vault → withdraw keeps half (logic only)", "contracts/out/guarded_vault.wasm", "contracts/out/guarded_vault_evil_fee.wasm", "STOP"],
    ["demo vault v1 → v2 (adds sweep)", "contracts/repro/demo_vault_v1.wasm", "contracts/repro/demo_vault_v2.wasm", "STOP"],
  ];
  for (const [label, a, b, expect] of pairs) {
    const A = read(path.join(ROOT, a));
    const B = read(path.join(ROOT, b));
    if (!A || !B) {
      console.log(`seeded: skip "${label}" (build contracts first: bash contracts/test.sh)`);
      continue;
    }
    out.push({
      label, expect, dao: "(seeded)", id: 0, kind: "seeded", target: path.basename(a), method: null, hash: await codeHash(B), state: "pending",
      submitted_at: "", votes: "", bytes: B.length, blob_tx: null, changed_at_height: null, changed_at: null, window_s: null, prev_hash: await codeHash(A),
      sourcescan: false, live: analyzeWasm(A), pending: analyzeWasm(B), verdict: "", flags: [], summary: [],
    });
  }
  return out;
}

function grade<R extends Row>(r: R): R {
  const g = gradeUpgrade({ target: r.target, live_hash: r.prev_hash ?? "", pending_hash: r.hash, live: r.live, pending: r.pending, verified: { reproducible: null, sourcescan: r.sourcescan }, review: null });
  return { ...r, verdict: g.verdict, flags: g.flags, summary: summarize(g) };
}

const cached = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
const real = offline ? (cached?.real ?? []) : await realRows();
const seeded = offline ? (cached?.seeded ?? []) : await seededRows();
const R = real.map(grade);
const S = seeded.map(grade);

const executed = R.filter((r: Row) => r.window_s !== null);
const windows = executed.map((r: Row) => r.window_s!).sort((a: number, b: number) => a - b);
const median = windows.length ? windows[Math.floor((windows.length - 1) / 2)] : null;
const fmt = (s: number | null) => (s === null ? "-" : s < 120 ? `${s} s` : s < 7200 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);
const gradedReal = R.filter((r: Row) => r.pending && r.live);
const stops = gradedReal.filter((r: Row) => r.verdict === "STOP");
const seededOk = S.filter((r: any) => (r.expect === "STOP") === (r.verdict === "STOP"));

const report = {
  schema: "keyhole.eval-upgrades/1",
  generatedAt: new Date().toISOString(),
  daos: DAOS,
  last: LAST,
  summary: {
    upgrade_proposals_with_hash: R.length,
    executed_with_measured_window: executed.length,
    window_min_s: windows[0] ?? null,
    window_median_s: median,
    window_max_s: windows.at(-1) ?? null,
    under_10_min: windows.filter((w: number) => w < 600).length,
    real_graded: gradedReal.length,
    real_stop: stops.length,
    seeded: S.length,
    seeded_correct: seededOk.length,
  },
  real: R,
  seeded: S,
};
if (!offline) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

const md = [
  "# Upgrade eval: real mainnet proposals and seeded attacks",
  "",
  `Generated by \`npm run eval:upgrades\` on ${report.generatedAt.slice(0, 10)} (last ${LAST} proposals of ${DAOS.length} DAOs). Re-score offline: \`npm run eval:upgrades -- --offline\`.`,
  "",
  "## How fast real upgrades execute",
  "",
  `${executed.length} executed upgrade proposals had a measurable window (submission → the block where the target's code changed, by archival bisection).`,
  `Shortest ${fmt(windows[0] ?? null)}, median ${fmt(median)}, longest ${fmt(windows.at(-1) ?? null)}; ${report.summary.under_10_min} executed in under 10 minutes.`,
  "Sputnik executes a proposal in the same call as the vote that reaches the threshold, so this window is all the time a depositor has.",
  "",
  "| DAO | proposal | target | window | bytes from | verdict | flags |",
  "|---|---|---|---|---|---|---|",
  ...R.map((r: Row) => `| ${r.dao.replace(".sputnik-dao.near", "")} | #${r.id} ${r.kind} | ${r.target} | ${fmt(r.window_s)} | ${r.blob_tx ? "store_blob" : r.pending ? "deployed code" : "-"} | ${r.verdict} | ${r.flags.join(" ")} |`),
  "",
  "## The grader on real upgrades (false alarms)",
  "",
  `${gradedReal.length} real upgrades could be graded (both the old and the new bytes were retrievable). ${stops.length} would have been STOP, i.e. would have fired a hatch with trigger \`stop\`.`,
  "No known incident is attached to these upgrades, so each STOP here is counted as a false alarm. That is an assumption, not a proof that the upgrades were safe.",
  "",
  "## Seeded attacks (recall)",
  "",
  "| case | expected | verdict | flags |",
  "|---|---|---|---|",
  ...S.map((r: any) => `| ${r.label} | ${r.expect} | ${r.verdict} | ${r.flags.join(" ")} |`),
  "",
  `${seededOk.length} of ${S.length} seeded cases graded as expected.`,
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "docs/EVAL_UPGRADES.md"), md);
console.log(`\n${md}`);
