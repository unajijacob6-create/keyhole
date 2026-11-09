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
  fetchTransport,
  type Transport,
  type UpgradeProposal,
  type WasmAnalysis,
} from "../packages/core/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --daos a,b: only these DAOs. --out file: write rows there. --merge a.json,b.json: combine partial
// runs (no network) into eval/upgrades.json and the report.
const OUT = path.join(ROOT, "eval/upgrades.json");
const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const ONLY = opt("--daos")?.split(",").filter(Boolean);
const OUT_FILE = opt("--out") ? path.resolve(opt("--out")!) : OUT;
const MERGE = opt("--merge")?.split(",").filter(Boolean).map((f) => path.resolve(f));
// --ids ref-finance#1018,intents#64: re-measure only these proposals (merge them after the full runs;
// for a proposal in several files the last file wins).
const IDS = opt("--ids")?.split(",").filter(Boolean);
const RELEASE_NOTE =
  "add_release_info registers code in a controller for later deployment to the accounts it manages (aurora-controller-factory); the controller's own code does not change, so there is no window to time";
const LAST = Number(argv.includes("--last") ? argv[argv.indexOf("--last") + 1] : 30);
import { DAOS } from "./lib/daos.ts";

interface Row {
  dao: string;
  id: number;
  kind: string;
  target: string;
  method: string | null;
  /** Controller the DAO called to deploy to `target` (see UpgradeProposal.via). */
  via?: string | null;
  registers_release?: boolean;
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

/** At most `perSec` requests per second through this transport (free RPC tiers rate-limit). */
function throttled(perSec: number): Transport {
  let next = 0;
  return async (url, body) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / perSec;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    return fetchTransport(url, body);
  };
}

async function realRows(): Promise<Row[]> {
  const RPS = Number(opt("--rps") ?? 6);
  const rpc = new Rpc({ network: "mainnet", transport: throttled(RPS), retries: 8 });
  const arch = new Rpc({ network: "mainnet", url: ARCHIVAL_RPC.mainnet, transport: throttled(RPS), retries: 8 });
  const api = txApi("mainnet");
  const head = (await rpc.block()).header;
  const headMs = Number(BigInt(head.timestamp) / 1_000_000n);
  const blockTime = async (h: number): Promise<number> => {
    // Heights can be skipped; walk forward a few blocks until one exists.
    for (let i = 0; i < 20; i++) {
      try {
        return Number(BigInt((await arch.block({ block_id: h + i })).header.timestamp) / 1_000_000n);
      } catch (e) {
        if (!/UNKNOWN_BLOCK/.test(String((e as Error).message))) throw e;
      }
    }
    throw new Error(`no block near ${h}`);
  };
  /** Last height whose block time is before `ms` (bisection on archival block headers). */
  const heightBefore = async (ms: number): Promise<number> => {
    let a = head.height - Math.ceil(((headMs - ms) / 1000) * 2.5) - 10_000; // generous lower bound (blocks are never faster than ~0.4 s)
    let b = head.height;
    if (a < 9_820_210) a = 9_820_210;
    while (b - a > 1) {
      const m = Math.floor((a + b) / 2);
      if ((await blockTime(m)) < ms) a = m;
      else b = m;
    }
    return a;
  };
  const codeAt = async (target: string, h: number): Promise<string | null> => {
    try {
      return effectiveHash(await arch.viewAccount(target, h));
    } catch (e) {
      if (/UNKNOWN_BLOCK/.test(String((e as Error).message))) return codeAt(target, h + 1);
      if (/UNKNOWN_ACCOUNT|does not exist/.test(String((e as Error).message))) return null;
      throw e;
    }
  };
  const perDao: Row[][] = [];
  for (const dao of DAOS.filter((d) => !ONLY || ONLY.includes(d))) perDao.push(await (async () => {
      const rows: Row[] = [];
      const props: UpgradeProposal[] = await listUpgradeProposals(rpc, dao, { last: LAST, nowMs: headMs });
      console.log(`${dao}: ${props.length} upgrade-related proposals taken (latest ${LAST})`);
      for (const p of props) {
        if (!p.code_hash) continue;
        if (IDS && !IDS.includes(`${dao.split(".")[0]}#${p.id}`)) continue;
        const row: Row = {
          dao, id: p.id, kind: p.kind, target: p.target, method: p.method, via: p.via, registers_release: p.registers_release, hash: p.code_hash, state: p.state,
          submitted_at: new Date(p.submitted_at_ms).toISOString(), votes: `${p.votes.approve}/${p.required ?? "?"}`,
          bytes: null, blob_tx: null, changed_at_height: null, changed_at: null, window_s: null, prev_hash: null, sourcescan: null,
          live: null, pending: null, verdict: "", flags: [], summary: [],
        };
        if (p.registers_release) {
          row.note = RELEASE_NOTE;
          rows.push(row);
          fs.appendFileSync(`${OUT_FILE}.partial.jsonl`, JSON.stringify(row) + "\n");
          console.log(`  ${dao.split(".")[0]} #${p.id} ${p.method} on ${p.target}: release registration, not timed`);
          continue;
        }
        try {
          let pendingBytes: Uint8Array | null = null;
          // For recent proposals, also show that the bytes were public before execution: find the
          // store_blob transaction in the DAO's history (older ones would need a deep scan).
          if (headMs - p.submitted_at_ms < 45 * 86400_000) {
            const blob = await fetchPendingCode({ api, dao, hash: p.code_hash, maxPages: 6 }).catch(() => null);
            if (blob) {
              pendingBytes = blob.code;
              row.blob_tx = blob.tx;
            }
          }
          if (p.state === "executed") {
            const lo = await heightBefore(p.submitted_at_ms);
            const before = await codeAt(p.target, lo);
            row.prev_hash = before;
            if (before === p.code_hash) row.note = "target already ran this code when the proposal was submitted";
            else {
              // First height after submission where the code differs from what was there.
              let a = lo, b = head.height;
              while (b - a > 1) {
                const m = Math.floor((a + b) / 2);
                if ((await codeAt(p.target, m)) !== before) b = m;
                else a = m;
              }
              const after = await codeAt(p.target, b);
              if (after === p.code_hash) {
                row.changed_at_height = b;
                const t = await blockTime(b);
                row.changed_at = new Date(t).toISOString();
                row.window_s = Math.round((t - p.submitted_at_ms) / 1000);
                if (!pendingBytes) pendingBytes = (await arch.viewCode(p.target, b)).code;
                if (before && before !== "11111111111111111111111111111111") row.live = analyzeWasm((await arch.viewCode(p.target, b - 1)).code);
              } else row.note = `the first code change after submission was to ${after}, not the proposal hash (another upgrade landed first, or this one was never applied)`;
            }
          } else if (p.state === "pending") {
            row.live = analyzeWasm((await rpc.viewCode(p.target)).code);
          }
          if (pendingBytes) {
            if ((await codeHash(pendingBytes)) !== p.code_hash) throw new Error("bytes do not hash to the proposal hash");
            row.bytes = pendingBytes.length;
            row.pending = analyzeWasm(pendingBytes);
          }
          const ss = await sourcescan(rpc, p.target, p.code_hash);
          row.sourcescan = ss.status === "verified" ? true : ss.status === "unknown" ? null : false;
        } catch (e) {
          row.note = `error: ${String((e as Error).message).slice(0, 160)}`;
        }
        rows.push(row);
        fs.appendFileSync(`${OUT_FILE}.partial.jsonl`, JSON.stringify(row) + "\n"); // checkpoint
        console.log(`  ${dao.split(".")[0]} #${p.id} ${p.kind} ${p.target} ${p.state} window=${row.window_s ?? "-"}s bytes=${row.bytes ?? "-"}${row.blob_tx ? " (store_blob found)" : ""} ${row.note ?? ""}`);
      }
      return rows;
    })());
  return perDao.flat();
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

/** Rows from several runs, one per dao#id (the last file wins). Rows measured before release
 *  registrations were recognised get the same treatment as new ones. */
function mergeRows(files: string[]): Row[] {
  const by = new Map<string, Row>();
  for (const f of files) for (const r of JSON.parse(fs.readFileSync(f, "utf8")).real as Row[]) by.set(`${r.dao}#${r.id}`, r);
  return [...by.values()].map((r) =>
    r.method === "add_release_info"
      ? { ...r, registers_release: true, via: r.via ?? null, window_s: null, changed_at_height: null, changed_at: null, live: null, pending: null, note: RELEASE_NOTE }
      : r,
  ).sort((a, b) => (a.dao === b.dao ? b.id - a.id : DAOS.indexOf(a.dao) - DAOS.indexOf(b.dao)));
}
const cached = MERGE
  ? { real: mergeRows(MERGE), seeded: [] }
  : fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
const fromCache = offline || Boolean(MERGE);
const real = fromCache ? (cached?.real ?? []) : await realRows();
const seeded = MERGE ? await seededRows() : fromCache ? (cached?.seeded ?? []) : await seededRows();
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
    release_registrations: R.filter((r: Row) => r.registers_release).length,
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
if (!offline) fs.writeFileSync(MERGE ? OUT : OUT_FILE, JSON.stringify(report));

const md = [
  "# Upgrade eval: real mainnet proposals and seeded attacks",
  "",
  `Generated by \`npm run eval:upgrades\` on ${report.generatedAt.slice(0, 10)} (the latest ${LAST} upgrade proposals of each of ${DAOS.length} DAOs). Re-score offline: \`npm run eval:upgrades -- --offline\`.`,
  "",
  "## How fast real upgrades execute",
  "",
  `${executed.length} executed upgrade proposals had a measurable window (submission → the block where the target's code changed, by archival bisection).`,
  `Shortest ${fmt(windows[0] ?? null)}, median ${fmt(median)}, longest ${fmt(windows.at(-1) ?? null)}; ${report.summary.under_10_min} executed in under 10 minutes.`,
  "Sputnik executes a proposal in the same call as the vote that reaches the threshold, so this window is all the time a depositor has.",
  ...(report.summary.release_registrations ? ["", `${report.summary.release_registrations} proposals register a release in a controller (\`add_release_info\`) instead of changing code; they are listed but not timed.`] : []),
  "",
  "| DAO | proposal | target | window | bytes from | verdict | flags |",
  "|---|---|---|---|---|---|---|",
  ...R.map((r: Row) => `| ${r.dao.replace(".sputnik-dao.near", "")} | #${r.id} ${r.kind}${r.method ? ` \`${r.method}\`` : ""} | ${r.target}${r.via ? ` (via ${r.via})` : ""} | ${fmt(r.window_s)} | ${r.blob_tx ? "store_blob tx (public before the vote)" : r.pending ? "code at the change block" : "-"} | ${r.pending && r.live ? r.verdict : "-"} | ${r.pending && r.live ? r.flags.join(" ") : (r.note ?? "")} |`),
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
// A partial run (--out without --merge) writes only its rows; the report comes from the merge.
if (!(opt("--out") && !MERGE)) fs.writeFileSync(path.join(ROOT, "docs/EVAL_UPGRADES.md"), md);
console.log(`\n${md}`);
