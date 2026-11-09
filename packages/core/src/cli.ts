// keyhole CLI: `keyhole inspect <account> [--json] [--evidence] [--network mainnet|testnet] [--no-history]`
//              `keyhole diff <account|file.wasm> <account|file.wasm> [--network ...]`
//              `keyhole pending <dao-or-contract> [--network ...] [--json] [--last N] [--fetch-code] [--dao <account>]`
import { inspect, type KeyholeReport } from "./inspect.ts";
import { recheckCommand } from "./evidence.ts";
import { Rpc, ARCHIVAL_RPC, type Network } from "./rpc.ts";
import { analyzeWasm, exportDiff } from "./wasm.ts";
import { codeHash, EMPTY_CODE_HASH } from "./hash.ts";
import { listUpgradeProposals, stagedUpgrade, stagedCode, fetchPendingCode, txApi, type UpgradeProposal, type StagedUpgrade, type TxApi } from "./pending.ts";
import { gradeUpgrade, type UpgradeGrade } from "./upgrade.ts";
import { discoverOwners, analyzeSputnikPolicy } from "./controller.ts";
import { sourcescan } from "./sources.ts";
import { registryLookup, registryRpc } from "./registry.ts";
import { lastCodeChange, effectiveHash } from "./history.ts";

const GLYPH = { OK: "[OK]", CAUTION: "[!!]", STOP: "[XX]" } as const;
const SEV = { stop: "XX", caution: "!!", info: "--", ok: "ok" } as const;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

export function formatReport(r: KeyholeReport, opts: { evidence?: boolean } = {}): string {
  const L: string[] = [];
  const g = r.grade;
  L.push(`${r.account}  (${r.network}, final block ${r.at.height.toLocaleString("en-US")}, ${r.at.time.slice(0, 16).replace("T", " ")} UTC)`);
  L.push(`${GLYPH[g.verdict]} ${g.verdict}  ·  ${g.class}${g.flags.length ? "  ·  " + g.flags.join(" ") : ""}`);
  L.push(g.headline);
  L.push("");
  L.push("Who can change it?");
  if (!r.paths.length) L.push(r.code ? "  - nobody: no full-access keys, no deploy capability in the code, no global-by-account reference" : "  - (no code)");
  for (const p of r.paths) L.push(`  - [${p.control}] ${p.text}`);
  if (r.code) {
    L.push("Is it the reviewed code?");
    L.push(`  - code hash ${r.code.hash} (${r.code.source}${r.code.globalAccount ? " " + r.code.globalAccount : ""}, ${(r.code.size / 1024).toFixed(0)} KiB${r.code.hashMatchesBytes ? ", sha256 of fetched bytes matches" : ", WARNING: bytes do not hash to the served hash"})`);
    const ss = r.sourcescan;
    if (ss) L.push(`  - SourceScan: ${ss.status}${ss.status === "stale" && ss.accountEntry ? ` (verified hash ${ss.accountEntry.code_hash.slice(0, 8)}… at block ${ss.accountEntry.block_height})` : ""}${ss.sameCodeAccounts.length ? ` (same code verified on ${ss.sameCodeAccounts.slice(0, 3).join(", ")})` : ""}`);
    const n = r.nep330;
    if (n) {
      L.push(
        n.present
          ? `  - NEP-330: version ${n.metadata?.version ?? "?"}, build_info ${n.hasBuildInfo ? "yes" : "no"}${n.github ? `, repo github.com/${n.github.owner}/${n.github.repo}${n.github.rev ? "@" + n.github.rev.slice(0, 10) : ""} (${n.repoStatus})` : n.metadata?.link ? `, link ${n.metadata.link}` : ""}`
          : "  - NEP-330: no contract_source_metadata",
      );
    }
    const reg = r.registry;
    if (reg) L.push(reg.available ? `  - Keyhole registry: ${reg.forHash.length} attestation(s) for this hash${reg.forHash.length ? " (" + [...new Set(reg.forHash.map((a) => a.attestation.kind))].join(", ") + ")" : ""}` : `  - Keyhole registry: unavailable (${reg.error})`);
    if (r.wasm) {
      const w = r.wasm;
      const caps = Object.keys(w.capabilities).join(", ") || "none";
      L.push(`  - wasm: ${w.exports.length} exported methods; action host functions: ${caps}`);
      if (w.codeChangeEntrypoints?.length) L.push(`  - specific call path to a code-change host function from: ${w.codeChangeEntrypoints.join(", ")}`);
    }
    L.push("What changed?");
    const lc = r.lastChange;
    if (!lc) L.push("  - last code change: not checked");
    else if (lc.status === "found") L.push(`  - last code change: block ${lc.height?.toLocaleString("en-US")} (${lc.timestamp?.slice(0, 10) ?? "?"}), previous hash ${lc.previousHash} [${lc.calls} archival calls]`);
    else if (lc.status === "unchanged-since") L.push(`  - code unchanged since at least block ${lc.sinceHeight?.toLocaleString("en-US")} (${lc.sinceTimestamp?.slice(0, 10) ?? "?"})`);
    else L.push(`  - last code change: unknown (${lc.note})`);
  }
  L.push("");
  L.push("Reasons");
  for (const reason of g.reasons) {
    L.push(`  [${SEV[reason.severity]}] ${reason.text}`);
    if (opts.evidence) for (const e of reason.evidence) L.push(`        re-check: ${recheckCommand(e)}`);
  }
  if (r.owners.length) {
    L.push("Owner (inferred)");
    for (const o of r.owners) L.push(`  - ${o.account} via ${o.source}${o.actor ? ": " + o.actor.summary : o.note ? ": " + o.note : ""}`);
  }
  L.push("");
  L.push(`${r.rpcCalls} RPC calls. ${r.disclaimer}${opts.evidence ? "" : " Add --evidence for re-check commands."}`);
  return L.join("\n");
}

async function loadCode(ref: string, network: Network): Promise<{ label: string; bytes: Uint8Array }> {
  if (ref.endsWith(".wasm")) {
    const fs = await import("node:fs");
    return { label: ref, bytes: new Uint8Array(fs.readFileSync(ref)) };
  }
  const [account, block] = ref.split("@");
  const rpc = new Rpc({ network });
  const { code } = await rpc.viewCode(account, block ? Number(block) : undefined);
  return { label: ref, bytes: code };
}

// ── keyhole pending ─────────────────────────────────────────────────────────────────────────────

const age = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 48 * 3600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const shortHash = (h: string | null) => (h ? `${h.slice(0, 8)}…` : "-");
const pad = (s: string, n: number) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));

export function formatProposals(ps: UpgradeProposal[], nowMs: number): string[] {
  const L: string[] = [];
  const cols: [string, number][] = [["id", 6], ["state", 9], ["kind", 14], ["target", 30], ["method", 17], ["hash", 10], ["votes", 6], ["age", 5], ["expires", 0]];
  L.push("  " + cols.map(([c, n]) => pad(c, n)).join("").trimEnd());
  for (const p of ps) {
    const exp = p.state === "pending" ? `in ${age(p.expires_at_ms - nowMs)}` : p.state === "expired" && p.status === "InProgress" ? `${age(nowMs - p.expires_at_ms)} ago` : "-";
    const row = [String(p.id), p.state, p.kind, p.target, p.method ?? "-", shortHash(p.code_hash), `${p.votes.approve}/${p.required ?? "?"}`, age(nowMs - p.submitted_at_ms), exp];
    L.push("  " + row.map((v, k) => pad(v, cols[k][1])).join("").trimEnd());
  }
  if (!ps.length) L.push("  (no upgrade proposals found)");
  return L;
}

interface FetchResult {
  target: string;
  hash: string;
  subject: string;
  bytes: null | { size: number; source: string; tx?: string; signer?: string; height?: number };
  retrospective: null | { previous_hash: string; since_height: number };
  verified: { reproducible: boolean | null; sourcescan: boolean | null; registry_review: string | null };
  grade: UpgradeGrade;
}

/** Fetch the code a proposal or a staged upgrade would deploy, diff it against the live code, grade it. */
async function fetchAndGrade(rpc: Rpc, api: TxApi, c: { target: string; hash: string; dao: string | null; subject: string; staged: StagedUpgrade | null }): Promise<FetchResult> {
  const acct = await rpc.viewAccount(c.target);
  let liveHash = effectiveHash(acct);
  const liveCode = liveHash !== EMPTY_CODE_HASH ? (await rpc.viewCode(c.target)).code : null;
  let live = liveCode ? analyzeWasm(liveCode) : null;
  let pendingCode: Uint8Array | null = null;
  let bytes: FetchResult["bytes"] = null;
  let retrospective: FetchResult["retrospective"] = null;
  if (c.hash === liveHash && liveCode) {
    // Already deployed: grade the upgrade as it landed, against the code it replaced (archival).
    pendingCode = liveCode;
    bytes = { size: liveCode.length, source: "live code (already deployed)" };
    const head = await rpc.block({ finality: "final" });
    const lc = await lastCodeChange(rpc, c.target, c.hash, head.header.height);
    if (lc.status === "found" && lc.height && lc.previousHash && lc.previousHash !== EMPTY_CODE_HASH && !lc.previousHash.startsWith("(")) {
      const arch = new Rpc({ network: rpc.network, url: ARCHIVAL_RPC[rpc.network], retries: 7 });
      for (let h = lc.height - 1; h > lc.height - 6; h--) {
        try {
          const prev = await arch.viewCode(c.target, h);
          if (prev.hash !== lc.previousHash) continue;
          live = analyzeWasm(prev.code);
          liveHash = prev.hash;
          retrospective = { previous_hash: prev.hash, since_height: lc.height };
          break;
        } catch {
          /* skipped height: try the one below */
        }
      }
    }
  } else {
    if (c.staged?.staged_hash === c.hash) {
      const code = await stagedCode(rpc, c.target, c.hash);
      if (code) (pendingCode = code), (bytes = { size: code.length, source: `up_staged_code on ${c.target}` });
    }
    for (const acc of [c.dao, c.target].filter((x, k, arr): x is string => Boolean(x) && arr.indexOf(x) === k)) {
      if (pendingCode) break;
      const f = await fetchPendingCode({ api, dao: acc, hash: c.hash });
      if (f) (pendingCode = f.code), (bytes = { size: f.code.length, source: `tx args to ${acc}`, tx: f.tx, signer: f.signer, height: f.height });
    }
  }
  if (pendingCode && (await codeHash(pendingCode)) !== c.hash) throw new Error("internal: fetched code does not hash to the proposed hash");
  const ss = await sourcescan(rpc, c.target, c.hash);
  const reg = await registryLookup(registryRpc(), c.target, c.hash);
  const builds = reg.forHash.filter((r) => r.attestation.kind === "ReproducibleBuild");
  const reviews = reg.forHash.filter((r) => r.attestation.kind === "AiReview").map((r) => String((r.attestation as any).verdict_summary ?? ""));
  const order = ["high", "medium", "low", "none"];
  reviews.sort((x, y) => order.indexOf(x.split(":")[0]) - order.indexOf(y.split(":")[0]));
  const verified = {
    reproducible: builds.length ? builds.some((r) => (r.attestation as any).matches === true) : null,
    sourcescan: ss.status === "verified" ? true : ss.status === "unknown" ? null : false,
    registry_review: reviews[0] ?? null,
  };
  const grade = gradeUpgrade({ target: c.target, live_hash: liveHash, pending_hash: c.hash, live, pending: pendingCode ? analyzeWasm(pendingCode) : null, verified });
  return { target: c.target, hash: c.hash, subject: c.subject, bytes, retrospective, verified, grade };
}

function formatFetch(f: FetchResult): string[] {
  const L: string[] = [];
  L.push(`Code for ${f.subject}`);
  L.push(`  hash ${f.hash}`);
  if (!f.bytes) L.push("  bytes: not found (no store_blob / stage call with matching sha256 in the pages scanned, and not staged)");
  else L.push(`  bytes: ${f.bytes.source}${f.bytes.tx ? `, tx ${f.bytes.tx} by ${f.bytes.signer} at block ${f.bytes.height?.toLocaleString("en-US")}` : ""}, ${f.bytes.size.toLocaleString("en-US")} bytes, sha256 matches the hash`);
  if (f.retrospective) L.push(`  already live since block ${f.retrospective.since_height.toLocaleString("en-US")}: graded against the code it replaced (${f.retrospective.previous_hash})`);
  L.push(`  verified: SourceScan ${f.verified.sourcescan === null ? "unknown" : f.verified.sourcescan ? "yes" : "no"}, reproducible build ${f.verified.reproducible === null ? "no attestation" : f.verified.reproducible ? "matches" : "does not match"}${f.verified.registry_review ? `, AI review "${f.verified.registry_review.slice(0, 80)}"` : ""}`);
  const g = f.grade;
  L.push(`${GLYPH[g.verdict]} ${g.verdict}${g.flags.length ? "  ·  " + g.flags.join(" ") : ""}${g.fire ? "  ·  a strict hatch would fire" : ""}`);
  L.push(g.headline);
  for (const r of g.reasons) L.push(`  [${SEV[r.severity]}] ${r.text}`);
  const d = g.diff;
  if (d) {
    for (const m of d.addedMethods) L.push(`  + method ${m}`);
    for (const m of d.removedMethods) L.push(`  - method ${m}`);
    for (const c of d.addedCapabilities) L.push(`  + capability ${c}`);
    for (const n of d.newlyReachable) L.push(`  + ${n.capability} now reachable from ${n.methods.join(", ")}`);
  }
  return L;
}

/** Pick what --fetch-code grades: newest pending proposal with a hash, else the newest with a hash. */
function pick(ps: UpgradeProposal[]): UpgradeProposal | undefined {
  return ps.find((p) => p.state === "pending" && p.code_hash) ?? ps.find((p) => p.code_hash);
}

export async function pendingCommand(account: string, o: { network?: Network; json?: boolean; last?: number; fetchCode?: boolean; dao?: string; api?: TxApi; rpc?: Rpc; nowMs?: number }): Promise<{ text: string; json: unknown; verdict: UpgradeGrade["verdict"] | null }> {
  const network = o.network ?? (account.endsWith(".testnet") ? "testnet" : "mainnet");
  const rpc = o.rpc ?? new Rpc({ network });
  const api = o.api ?? txApi(network);
  const nowMs = o.nowMs ?? Date.now();
  const last = o.last;
  const L: string[] = [];
  const policy = await rpc.tryView<any>(account, "get_policy");
  const isDao = Boolean(policy && Array.isArray(policy.roles));
  let fetch: FetchResult | null = null;
  if (isDao) {
    const ps = await listUpgradeProposals(rpc, account, { last, nowMs });
    const req = (k: string) => analyzeSputnikPolicy(policy, [k]).requiredApprovals ?? "?";
    L.push(`${account}  (${network}, Sputnik DAO; proposals expire after ${age(Number(BigInt(policy.proposal_period ?? 0) / 1_000_000n))}; approvals needed: upgrade_remote ${req("upgrade_remote")}, upgrade_self ${req("upgrade_self")}, call ${req("call")})`);
    L.push(`Upgrade proposals, newest first${last ? ` (last ${last})` : ""}:`);
    L.push(...formatProposals(ps, nowMs));
    const p = o.fetchCode ? pick(ps) : undefined;
    if (o.fetchCode && !p) L.push("", "--fetch-code: no upgrade proposal with a determinable code hash.");
    if (p) {
      const staged = p.kind === "FunctionCall" && p.target !== account ? await stagedUpgrade(rpc, p.target) : null;
      fetch = await fetchAndGrade(rpc, api, { target: p.target, hash: p.code_hash!, dao: account, subject: `#${p.id} (${p.state}, ${p.kind} ${p.target}${p.method ? " " + p.method : ""})`, staged });
      L.push("", ...formatFetch(fetch));
    }
    return { text: L.join("\n"), json: { schema: "keyhole.pending/1", network, account, kind: "dao", proposals: ps, fetch }, verdict: fetch?.grade.verdict ?? null };
  }

  // A contract: near-plugins staging, plus upgrade proposals of any Sputnik DAO that owns it.
  const staged = await stagedUpgrade(rpc, account);
  L.push(`${account}  (${network}, contract)`);
  if (!staged) L.push("near-plugins staging: not an Upgradable contract (no up_staged_code_hash)");
  else {
    L.push(`near-plugins staging: ${staged.pending ? "PENDING" : "nothing pending"}; staged ${staged.staged_hash ?? "none"}, live ${staged.live_hash}${staged.staged_hash && !staged.pending ? " (staged == live)" : ""}`);
    if (staged.staging_timestamp_ms) L.push(`  staged at ${new Date(staged.staging_timestamp_ms).toISOString().slice(0, 16).replace("T", " ")} UTC (${age(nowMs - staged.staging_timestamp_ms)} ago); staging delay ${staged.staging_duration_ms ? age(staged.staging_duration_ms) : "none: the deployer role can deploy it at once"}`);
  }
  const daos: { account: string; source: string }[] = [];
  if (o.dao) daos.push({ account: o.dao, source: "--dao" });
  else {
    const acct = await rpc.viewAccount(account);
    if (effectiveHash(acct) !== EMPTY_CODE_HASH) {
      const owners = await discoverOwners(rpc, account, analyzeWasm((await rpc.viewCode(account)).code).exports);
      for (const c of owners) {
        if (c.account === account || daos.some((d) => d.account === c.account)) continue;
        const pol = await rpc.tryView<any>(c.account, "get_policy");
        if (pol && Array.isArray(pol.roles)) daos.push({ account: c.account, source: c.source });
      }
    }
  }
  const byDao: Record<string, UpgradeProposal[]> = {};
  for (const d of daos) {
    const ps = await listUpgradeProposals(rpc, d.account, { last, nowMs, target: account });
    byDao[d.account] = ps;
    L.push("", `Owner (inferred) ${d.account} via ${d.source}: upgrade proposals targeting ${account}, newest first${last ? ` (last ${last})` : ""}:`);
    L.push(...formatProposals(ps, nowMs));
  }
  if (!daos.length) L.push("", "No Sputnik DAO owner found (use --dao <account> to name one).");
  if (o.fetchCode) {
    const all = Object.values(byDao).flat().sort((x, y) => y.submitted_at_ms - x.submitted_at_ms);
    const p = pick(all);
    const c = staged?.pending
      ? { target: account, hash: staged.staged_hash!, dao: daos[0]?.account ?? null, subject: `staged code on ${account}`, staged }
      : p
        ? { target: account, hash: p.code_hash!, dao: p.dao, subject: `#${p.id} of ${p.dao} (${p.state}, ${p.kind}${p.method ? " " + p.method : ""})`, staged }
        : null;
    if (c) {
      fetch = await fetchAndGrade(rpc, api, c);
      L.push("", ...formatFetch(fetch));
    } else L.push("", "--fetch-code: nothing staged and no upgrade proposal with a determinable code hash.");
  }
  return { text: L.join("\n"), json: { schema: "keyhole.pending/1", network, account, kind: "contract", staged, daos, proposals: byDao, fetch }, verdict: fetch?.grade.verdict ?? null };
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, a, b] = argv.filter((x, i, arr) => !x.startsWith("--") && !(i > 0 && ["--network", "--registry", "--last", "--dao"].includes(arr[i - 1])));
  if (cmd === "pending" && a) {
    const lastArg = arg("--last");
    const r = await pendingCommand(a, { network: arg("--network") as Network | undefined, last: lastArg ? Number(lastArg) : undefined, fetchCode: has("--fetch-code"), dao: arg("--dao") });
    console.log(has("--json") ? JSON.stringify(r.json, null, 2) : r.text);
    return r.verdict === "STOP" ? 2 : 0;
  }
  const network = arg("--network") as Network | undefined;
  if (cmd === "inspect" && a) {
    const reg = arg("--registry");
    const r = await inspect(a, { network, history: !has("--no-history"), ...(reg ? { registry: { account: reg } } : {}) });
    console.log(has("--json") ? JSON.stringify(r, null, 2) : formatReport(r, { evidence: has("--evidence") }));
    return r.grade.verdict === "STOP" ? 2 : 0;
  }
  if (cmd === "diff" && a && b) {
    const net = network ?? (a.includes(".testnet") ? "testnet" : "mainnet");
    const [x, y] = await Promise.all([loadCode(a, net), loadCode(b, net)]);
    const d = exportDiff(analyzeWasm(x.bytes), analyzeWasm(y.bytes));
    if (has("--json")) console.log(JSON.stringify({ before: { ref: a, hash: await codeHash(x.bytes) }, after: { ref: b, hash: await codeHash(y.bytes) }, diff: d }, null, 2));
    else {
      console.log(`${a} (${await codeHash(x.bytes)})  →  ${b} (${await codeHash(y.bytes)})`);
      for (const m of d.addedMethods) console.log(`  + method ${m}`);
      for (const m of d.removedMethods) console.log(`  - method ${m}`);
      for (const m of d.addedHostImports) console.log(`  + host import ${m}`);
      for (const m of d.removedHostImports) console.log(`  - host import ${m}`);
      for (const c of d.addedCapabilities) console.log(`  + capability ${c}`);
      for (const n of d.newlyReachable) console.log(`  + ${n.capability} now reachable from ${n.methods.join(", ")}`);
      if (!Object.values(d).some((v) => (v as unknown[]).length)) console.log("  (no change in methods, host imports or capabilities)");
    }
    return 0;
  }
  console.log("usage:\n  keyhole inspect <account> [--json] [--evidence] [--network mainnet|testnet] [--no-history] [--registry <account>]\n  keyhole diff <account[@block]|file.wasm> <account[@block]|file.wasm> [--json]\n  keyhole pending <dao-or-contract> [--network mainnet|testnet] [--json] [--last N] [--fetch-code] [--dao <account>]");
  return 1;
}
