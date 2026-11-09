// npm run radar — snapshot of upgrade activity on NEAR mainnet for the website (data/radar.json).
// Read-only. For each DAO: its upgrade-related proposals (latest first) with state, votes and
// expiry; for pending ones, the exact bytes from store_blob, the diff against the live code and
// the deterministic grade, plus the NEP-330 metadata the pending bytes declare. For each
// near-plugins Upgradable contract: whether code is staged and the enforced staging delay.
// Measured windows for executed proposals come from eval/upgrades.json (npm run eval:upgrades).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSputnikPolicy,
  analyzeWasm,
  codeHash,
  fetchPendingCode,
  gradeUpgrade,
  listUpgradeProposals,
  Rpc,
  RpcAnswerError,
  sourceMetadataFromWasm,
  sourcescan,
  stagedCode,
  stagedUpgrade,
  txApi,
} from "../packages/core/src/index.ts";
import { DAOS } from "./lib/daos.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** near-plugins Upgradable contracts to survey (mainnet). The count reported is what answers. */
export const STAGED_SURVEY = [
  "omni.bridge.near", "token.sweat", "ctl-intents.near", "lst.rhealab.near", "xtoken.rhealab.near", "v2.jars.sweat",
  "zcash-connector.bridge.near", "zcash-client.bridge.near", "btc-connector.bridge.near", "btc-client.bridge.near",
  "factory.bridge.near", "omni-prover.bridge.near", "intents.near",
];

const rpc = new Rpc({ network: "mainnet" });
const api = txApi("mainnet");
const head = (await rpc.block()).header;
const nowMs = Number(BigInt(head.timestamp) / 1_000_000n);
const evalRows: any[] = fs.existsSync(path.join(ROOT, "eval/upgrades.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "eval/upgrades.json"), "utf8")).real : [];
const windowOf = (dao: string, id: number) => evalRows.find((r) => r.dao === dao && r.id === id) ?? null;
/** Grade an eval row (both analyses present) with the current rules. */
const gradeEvalRow = (r: any) => {
  if (!r?.live || !r?.pending) return null;
  const g = gradeUpgrade({ target: r.target, live_hash: r.prev_hash ?? "", pending_hash: r.hash, live: r.live, pending: r.pending, verified: { reproducible: null, sourcescan: r.sourcescan }, review: null });
  return { verdict: g.verdict, flags: g.flags, headline: g.headline };
};

const daos = [];
for (const dao of DAOS) {
  const policy = await rpc.view<any>(dao, "get_policy");
  const info = analyzeSputnikPolicy(policy, ["upgrade_remote"]);
  const props = await listUpgradeProposals(rpc, dao, { last: 60, nowMs });
  const rows = [];
  for (const p of props.slice(0, 12)) {
    const ev = windowOf(dao, p.id);
    const row: any = { ...p, window_s: ev?.window_s ?? null, changed_at_height: ev?.changed_at_height ?? null, bytes: ev?.bytes ?? null, blob_tx: ev?.blob_tx ?? null, grade: gradeEvalRow(ev) };
    if (p.state === "pending" && p.code_hash) {
      try {
        const blob = await fetchPendingCode({ api, dao, hash: p.code_hash, maxPages: 20 });
        const live = (await rpc.viewCode(p.target)).code;
        let bytes = blob?.code ?? null;
        if (!bytes) bytes = await stagedCode(rpc, p.target, p.code_hash);
        const ss = await sourcescan(rpc, p.target, p.code_hash);
        const g = gradeUpgrade({ target: p.target, live_hash: await codeHash(live), pending_hash: p.code_hash, live: analyzeWasm(live), pending: bytes ? analyzeWasm(bytes) : null, verified: { reproducible: null, sourcescan: ss.status === "verified" ? true : ss.status === "unknown" ? null : false }, review: null });
        row.grade = { verdict: g.verdict, flags: g.flags, headline: g.headline, reasons: g.reasons };
        row.bytes = bytes?.length ?? null;
        row.blob_tx = blob?.tx ?? null;
        row.declared_source = bytes ? await sourceMetadataFromWasm(bytes) : null;
        row.diff = g.diff;
      } catch (e) {
        row.error = String((e as Error).message).slice(0, 160);
      }
    }
    rows.push(row);
  }
  daos.push({ dao, council: info.roleSize, required: info.requiredApprovals, proposal_period_h: Number(BigInt(policy.proposal_period) / 3_600_000_000_000n), proposals: rows });
  console.log(`${dao}: ${rows.length} rows (${rows.filter((r: any) => r.state === "pending").length} pending)`);
}

const staged = [];
for (const c of STAGED_SURVEY) {
  try {
    const s = await stagedUpgrade(rpc, c);
    let delay: any = null;
    try {
      delay = await rpc.view<any>(c, "up_get_delay_status");
    } catch (e) {
      if (!(e instanceof RpcAnswerError)) throw e;
    }
    staged.push({ contract: c, upgradable: Boolean(s), staged_hash: s?.staged_hash ?? null, live_hash: s?.live_hash ?? null, pending: s?.pending ?? false, staging_duration_ns: delay?.staging_duration ?? null, staging_timestamp_ns: delay?.staging_timestamp ?? null });
  } catch (e) {
    staged.push({ contract: c, error: String((e as Error).message).slice(0, 120) });
  }
}
const upgradable = staged.filter((s: any) => s.upgradable);
const zeroDelay = upgradable.filter((s: any) => !s.staging_duration_ns || String(s.staging_duration_ns) === "0");
const windows = evalRows.map((r) => r.window_s).filter((w) => typeof w === "number").sort((a, b) => a - b);
const out = {
  schema: "keyhole.radar/1",
  generatedAt: new Date(nowMs).toISOString(),
  atBlock: head.height,
  network: "mainnet",
  daos,
  staged,
  windows: evalRows.filter((r) => typeof r.window_s === "number").map((r) => ({ dao: r.dao, id: r.id, target: r.target, window_s: r.window_s })),
  stats: {
    upgradable_surveyed: upgradable.length,
    upgradable_zero_delay: zeroDelay.length,
    measured_windows: windows.length,
    window_min_s: windows[0] ?? null,
    window_median_s: windows.length ? windows[Math.floor((windows.length - 1) / 2)] : null,
    window_max_s: windows.at(-1) ?? null,
    pending_now: daos.reduce((n, d: any) => n + d.proposals.filter((p: any) => p.state === "pending").length, 0),
  },
};
fs.writeFileSync(path.join(ROOT, "data/radar.json"), JSON.stringify(out, null, 1));
fs.mkdirSync(path.join(ROOT, "web/public/data"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "data/radar.json"), path.join(ROOT, "web/public/data/radar.json"));
console.log(JSON.stringify(out.stats));
