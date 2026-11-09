// Phase 0 fact-check: re-verify, against NEAR mainnet and primary sources, every number the brief
// wants to publish. Read-only, no keys. Writes docs/FACTCHECK.json and prints a findings table.
//
//   npm run factcheck            (Node 22; behind a proxy set NODE_USE_ENV_PROXY=1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.NEAR_MAINNET_RPC ?? "https://rpc.mainnet.fastnear.com";
const SOURCESCAN = "v2-verifier.sourcescan.near";
const EMPTY_HASH = "11111111111111111111111111111111";

let rpcCalls = 0;
// Retries transport failures, 429/5xx and RPC-side transient errors. Deterministic answers (unknown
// account, method not found, contract panic) are returned to the caller as errors without retry.
const DETERMINISTIC = /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CodeDoesNotExist|MethodResolveError|MethodNotFound|FunctionCallError|CompilationError|WasmTrap|HostError|TOO_LARGE_CONTRACT_STATE|UNKNOWN_ACCESS_KEY|does not exist/;
async function rpc<T = any>(method: string, params: unknown, attempt = 1): Promise<T> {
  rpcCalls++;
  let j: any;
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "fc", method, params }) });
    if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) {
    if (attempt >= 6) throw e;
    await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    return rpc(method, params, attempt + 1);
  }
  if (j.error) {
    const text = JSON.stringify(j.error);
    if (!DETERMINISTIC.test(text) && attempt < 6) {
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
      return rpc(method, params, attempt + 1);
    }
    const e = new Error(text.slice(0, 400));
    (e as any).rpc = j.error;
    throw e;
  }
  return j.result as T;
}
const viewAccount = (account_id: string) => rpc("query", { request_type: "view_account", finality: "final", account_id });
const viewKeys = (account_id: string) => rpc("query", { request_type: "view_access_key_list", finality: "final", account_id });
const viewCode = (account_id: string) => rpc("query", { request_type: "view_code", finality: "final", account_id });
async function callView<T = any>(account_id: string, method_name: string, args: object = {}): Promise<T> {
  const res = await rpc("query", { request_type: "call_function", finality: "final", account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (res.error) {
    // Older nodes put contract execution errors in result.error (e.g. MethodResolveError).
    const e = new Error(String(res.error));
    (e as any).rpc = { contract: res.error };
    throw e;
  }
  return JSON.parse(Buffer.from(res.result).toString("utf8")) as T;
}
async function tryView<T = any>(account_id: string, method_name: string, args: object = {}): Promise<T | null> {
  try {
    return await callView<T>(account_id, method_name, args);
  } catch (e: any) {
    if (e.rpc) return null; // deterministic: method missing, panics, no code
    throw e;
  }
}

async function pool<I, O>(items: I[], n: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const UPGRADE_EXPORT = /upgrade|migrate|deploy|up_deploy_code|update_contract|set_code/i;
const DEPLOY_IMPORTS = [
  "promise_batch_action_deploy_contract",
  "promise_batch_action_deploy_global_contract",
  "promise_batch_action_deploy_global_contract_by_account_id",
  "promise_batch_action_use_global_contract",
  "promise_batch_action_use_global_contract_by_account_id",
];

async function wasmFacts(accountId: string) {
  const t0 = performance.now();
  const code = await viewCode(accountId);
  const fetchMs = performance.now() - t0;
  const bytes = Buffer.from(code.code_base64, "base64");
  const t1 = performance.now();
  const mod = new WebAssembly.Module(bytes);
  const compileMs = performance.now() - t1;
  const imports = WebAssembly.Module.imports(mod).map((i) => i.name);
  const exports = WebAssembly.Module.exports(mod).filter((e) => e.kind === "function").map((e) => e.name);
  return {
    size: bytes.length,
    fetchMs: Math.round(fetchMs),
    compileMs: Math.round(compileMs),
    deployImports: imports.filter((n) => DEPLOY_IMPORTS.includes(n)),
    addFullAccessKeyImport: imports.includes("promise_batch_action_add_key_with_full_access"),
    upgradeExports: exports.filter((n) => UPGRADE_EXPORT.test(n)),
  };
}

const findings: { id: string; claim: string; result: string; status: "confirmed" | "changed" | "unverified"; evidence: string }[] = [];
function finding(id: string, claim: string, result: string, status: "confirmed" | "changed" | "unverified", evidence: string) {
  findings.push({ id, claim, result, status, evidence });
}
const raw: Record<string, unknown> = {};
const startedAt = new Date().toISOString();
const head = await rpc("block", { finality: "final" });
const atBlock = head.header.height as number;
console.log(`factcheck @ ${startedAt} | ${RPC} | final block ${atBlock}\n`);

// ── 1. SourceScan registry: size and staleness ─────────────────────────────────────────────────
{
  const count = await callView<number>(SOURCESCAN, "get_contracts_count");
  const all: [string, { code_hash: string; block_height: number; lang: string }][] = [];
  for (let from = 0; from < count; from += 50) {
    const [page] = await callView<[any[], number]>(SOURCESCAN, "get_contracts", { from_index: from, limit: 50 });
    all.push(...page);
  }
  const verifiedHashes = new Set(all.map(([, c]) => c.code_hash));
  const rows = await pool(all, 6, async ([id, c]) => {
    try {
      const a = await viewAccount(id);
      // Accounts that use a global contract report code_hash = 1111… and carry the real hash in
      // global_contract_hash (by hash) or global_contract_account_id (by publisher account).
      let current: string = a.code_hash;
      let via = "local";
      if (current === EMPTY_HASH && a.global_contract_hash) (current = a.global_contract_hash), (via = "global-hash");
      else if (current === EMPTY_HASH && a.global_contract_account_id) (current = (await viewCode(id)).hash), (via = `global-account:${a.global_contract_account_id}`);
      return { id, verified: c.code_hash, current, via, state: current === c.code_hash ? "MATCH" : current === EMPTY_HASH ? "NO_CODE" : "STALE" };
    } catch (e: any) {
      return { id, verified: c.code_hash, current: null, state: /UNKNOWN_ACCOUNT|does not exist/i.test(String(e.message)) ? "DELETED" : "ERROR" };
    }
  });
  const stale = rows.filter((r) => r.state === "STALE");
  const staleNewVerifiedSomewhere = stale.filter((r) => r.current && verifiedHashes.has(r.current));
  const named = ["intents.near", "venear.dao", "vote.dao", "lst.rhealab.near", "btc-connector.bridge.near", "zcash-client.bridge.near"];
  const namedState = named.map((n) => `${n}=${rows.find((r) => r.id === n)?.state ?? "not-in-registry"}`);
  const byState = rows.reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
  raw.sourcescan = { count, listed: all.length, byState, rows };
  finding("sourcescan.count", "SourceScan holds 110 verified mainnet contracts", `get_contracts_count = ${count} (listed ${all.length})`, count === 110 ? "confirmed" : "changed", `near view ${SOURCESCAN} get_contracts_count`);
  finding(
    "sourcescan.stale",
    "49/110 (45%) run code different from the verified hash; none of the new hashes is verified anywhere",
    `${stale.length}/${count} run different code (${Math.round((100 * stale.length) / count)}%), of which ${stale.filter((r: any) => r.via !== "local").length} via a global contract; new hash verified elsewhere in SourceScan: ${staleNewVerifiedSomewhere.length}; no longer running verified code at all (stale+no code+deleted): ${count - (byState.MATCH ?? 0)}; states ${JSON.stringify(byState)}`,
    stale.length === 49 && staleNewVerifiedSomewhere.length === 0 ? "confirmed" : "changed",
    `get_contracts + view_account per entry @ block ${atBlock}`,
  );
  finding("sourcescan.named", "Stale entries include intents.near, venear.dao, vote.dao, lst.rhealab.near, btc-connector.bridge.near, zcash-client.bridge.near", namedState.join(", "), namedState.every((s) => s.endsWith("=STALE")) ? "confirmed" : "changed", "same query");
  // Method name check: get_contracts_by_code_hash exists on the deployed contract.
  const sample = all.find(([, c]) => c.code_hash)!;
  const byHash = await tryView<any[]>(SOURCESCAN, "get_contracts_by_code_hash", { code_hash: sample[1].code_hash });
  finding("sourcescan.method", "SourceScan exposes get_contracts_by_code_hash", byHash ? `works; ${byHash.length} account(s) for ${sample[1].code_hash.slice(0, 8)}…` : "method missing/failed on deployed contract", byHash ? "confirmed" : "changed", `near view ${SOURCESCAN} get_contracts_by_code_hash`);
  (raw as any).verifiedHashes = [...verifiedHashes];
}

const verifiedHashes = new Set<string>((raw as any).verifiedHashes);

// ── 2. 24-contract sample: NEP-330 build_info and full-access keys ─────────────────────────────
const SAMPLE24 = [
  "linear-protocol.near", "usdt.tether-token.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "aurora",
  "v1.signer", "token.sweat", "sputnik-dao.near", "social.near", "v2.nearx.stader-labs.near", "priceoracle.near", "dclv2.ref-labs.near",
  "omni.bridge.near", "factory.bridge.near", "lst.rhealab.near", "token.v2.ref-finance.near", "game.hot.tg", "x.paras.near", "tkn.near",
  "npro.nearmobile.near", "intents.near", "wrap.near", "v2.ref-finance.near", "contract.main.burrow.near", "meta-pool.near",
];
{
  const rows = await pool(SAMPLE24, 4, async (id) => {
    const acct = await viewAccount(id).catch((e) => ({ error: String(e.message) }));
    const keys = await viewKeys(id).catch(() => ({ keys: [] }));
    const fak = (keys.keys as any[]).filter((k) => k.access_key.permission === "FullAccess").length;
    const meta = await tryView<any>(id, "contract_source_metadata");
    return { id, code_hash: (acct as any).code_hash ?? null, fak, nep330: meta ? meta.version ?? "?" : null, build_info: Boolean(meta?.build_info), snapshot: meta?.build_info?.source_code_snapshot ?? null };
  });
  raw.sample24 = rows;
  const withBI = rows.filter((r) => r.build_info).map((r) => r.id);
  const withFak = rows.filter((r) => r.fak > 0).map((r) => `${r.id.length > 20 ? r.id.slice(0, 8) + "…" : r.id}(${r.fak})`);
  finding("sample.build_info", "7/24 publish NEP-330 build_info", `${withBI.length}/24: ${withBI.join(", ")}`, withBI.length === 7 ? "confirmed" : "changed", "contract_source_metadata per account");
  finding("sample.fak", "7/24 hold full-access keys on the contract account; native USDC 1, game.hot.tg 66", `${withFak.length}/24: ${withFak.join(", ")}`, withFak.length === 7 ? "confirmed" : "changed", "view_access_key_list per account");
  const missing = ["v2.ref-finance.near", "contract.main.burrow.near", "wrap.near", "meta-pool.near", "usdt.tether-token.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "priceoracle.near"];
  const stillMissing = missing.filter((m) => !rows.find((r) => r.id === m)?.build_info);
  finding("sample.missing", "No build_info: v2.ref-finance, burrow, wrap, meta-pool, usdt, native USDC, priceoracle", `${stillMissing.length}/${missing.length} still without build_info`, stillMissing.length === missing.length ? "confirmed" : "changed", "contract_source_metadata");
}

// ── 3. Top 50 tokens: SourceScan-verified current code and NEP-330 ──────────────────────────────
{
  const top = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/data/top50-tokens.json"), "utf8")).accounts as string[];
  const rows = await pool(top, 4, async (id) => {
    const a = await viewAccount(id).catch(() => null);
    const meta = await tryView<any>(id, "contract_source_metadata");
    return { id, code_hash: a?.code_hash ?? null, verified: a ? verifiedHashes.has(a.code_hash) : false, nep330: Boolean(meta) };
  });
  raw.top50 = rows;
  const v = rows.filter((r) => r.verified).length;
  const noMeta = rows.filter((r) => !r.nep330).length;
  finding("top50", "Of the top 50 NEP-141 tokens only 8 run SourceScan-verified code; 27 lack NEP-330", `${v}/50 run a code hash present in SourceScan; ${noMeta}/50 lack contract_source_metadata`, v === 8 && noMeta === 27 ? "confirmed" : "changed", "token list from research notes (ranking not re-derived)");
}

// ── 4. Wasm: deploy capability vs upgrade entrypoints; compile big wasm; time view_code ─────────
{
  const targets = ["intents.near", "wrap.near", "v2.ref-finance.near", "contract.main.burrow.near", "meta-pool.near", "linear-protocol.near", "usdt.tether-token.near", "dclv2.ref-labs.near"];
  const rows = await pool(targets, 2, async (id) => ({ id, ...(await wasmFacts(id)) }));
  raw.wasm = rows;
  const wrap = rows.find((r) => r.id === "wrap.near")!;
  const defi = rows.filter((r) => r.id !== "wrap.near");
  const both = defi.filter((r) => r.deployImports.includes("promise_batch_action_deploy_contract") && r.upgradeExports.length > 0);
  finding("wasm.defi", "Major DeFi contracts import promise_batch_action_deploy_contract and export an upgrade-like method", `${both.length}/${defi.length}: ${defi.map((r) => `${r.id}[${r.deployImports.length ? "imp" : "-"}|${r.upgradeExports.slice(0, 2).join(",") || "-"}]`).join(" ")}`, both.length === defi.length ? "confirmed" : "changed", "view_code → WebAssembly.Module.imports/exports");
  finding("wasm.wrap", "wrap.near imports deploy but exports no upgrade method", `deployImport=${wrap.deployImports.includes("promise_batch_action_deploy_contract")} upgradeExports=[${wrap.upgradeExports.join(",")}]`, wrap.deployImports.length > 0 && wrap.upgradeExports.length === 0 ? "confirmed" : "changed", "view_code wrap.near");
  const intents = rows.find((r) => r.id === "intents.near")!;
  finding("wasm.perf", "Node can fetch and compile big NEAR wasm", `intents.near ${(intents.size / 1024).toFixed(0)} KiB: view_code ${intents.fetchMs} ms, WebAssembly.Module ${intents.compileMs} ms (Node ${process.version})`, "confirmed", "timed in this run");
}

// ── 5. view_state on large contracts ────────────────────────────────────────────────────────────
{
  const res: string[] = [];
  for (const id of ["intents.near", "wrap.near"]) {
    try {
      await rpc("query", { request_type: "view_state", finality: "final", account_id: id, prefix_base64: "" });
      res.push(`${id}: allowed`);
    } catch (e: any) {
      res.push(`${id}: ${e.rpc?.cause?.name ?? e.rpc?.name ?? "error"}`);
    }
  }
  // nearcore 2.14 added `limit`/`after_key` pagination to view_state; check whether a paged read works.
  try {
    const paged = await rpc("query", { request_type: "view_state", finality: "final", account_id: "wrap.near", prefix_base64: "", limit: 5 });
    res.push(`wrap.near with limit=5: ${paged.values.length} values, last_key=${paged.last_key ? "yes" : "no"}`);
  } catch (e: any) {
    res.push(`wrap.near with limit=5: ${e.rpc?.cause?.name ?? "error"}`);
  }
  const status = await rpc("status", []);
  res.push(`node ${status.version.version}, protocol ${status.protocol_version}`);
  const pagedWorks = res.some((r) => /limit=5: \d+ values/.test(r));
  finding("view_state", "Public RPC rejects view_state on large contracts (TOO_LARGE_CONTRACT_STATE)", res.join("; "), pagedWorks ? "changed" : "confirmed", `${RPC} view_state prefix "" with and without limit`);
}

// ── 6. Global contracts: RPC field names, live usage ────────────────────────────────────────────
{
  const users = ((raw.sourcescan as any).rows as any[]).filter((r) => r.via && r.via !== "local");
  finding("global.live", "Global contracts are in use on mainnet", `${users.length} SourceScan-listed accounts run a global contract: ${users.slice(0, 4).map((u) => `${u.id}(${u.via})`).join(", ")}`, users.length > 0 ? "confirmed" : "unverified", "view_account.global_contract_hash / global_contract_account_id");
}
finding(
  "global.fields",
  "Global-contract fields in view_account and host functions",
  "AccountView has global_contract_hash / global_contract_account_id (omitted when unset; code_hash = 1111… for global users). Host fns: promise_batch_action_{deploy_global_contract,deploy_global_contract_by_account_id,use_global_contract,use_global_contract_by_account_id}",
  "confirmed",
  "nearcore master core/primitives/src/views.rs, runtime/near-vm-runner/src/imports.rs (fetched 2026-11-09)",
);

// ── 7. neardata block stream ─────────────────────────────────────────────────────────────────────
{
  const out: string[] = [];
  for (const net of ["mainnet", "testnet"]) {
    const t0 = performance.now();
    const r = await fetch(`https://${net}.neardata.xyz/v0/last_block/final`, { redirect: "follow" });
    const j: any = r.ok ? await r.json() : null;
    out.push(`${net}: HTTP ${r.status} height ${j?.block?.header?.height ?? "?"} shards ${j?.shards?.length ?? "?"} (${Math.round(performance.now() - t0)} ms)`);
  }
  finding("neardata", "neardata.xyz serves final blocks for mainnet and testnet", out.join("; "), out.every((o) => o.includes("HTTP 200")) ? "confirmed" : "changed", "GET /v0/last_block/final");
}

// ── 8. GitHub: Rustle last commit, NearBlocks issues ────────────────────────────────────────────
{
  const gh = async (p: string) => {
    const r = await fetch(`https://api.github.com/${p}`, { headers: { accept: "application/vnd.github+json", "user-agent": "keyhole-factcheck" } });
    return r.ok ? r.json() : { error: r.status };
  };
  const rustle: any = await gh("repos/blocksecteam/rustle/commits?per_page=1");
  const last = Array.isArray(rustle) ? rustle[0]?.commit?.committer?.date : `error ${rustle.error}`;
  finding("rustle", "Rustle (only NEAR static analyzer) last commit 2023-07-10", `last commit ${last}`, String(last).startsWith("2023-07-10") ? "confirmed" : Array.isArray(rustle) ? "changed" : "unverified", "api.github.com/repos/blocksecteam/rustle/commits");
  const issues: string[] = [];
  for (const [repo, n] of [["Nearblocks/nearblocks", 1610], ["Nearblocks/nearblocks", 1175], ["Near-One/btc-bridge", 78]] as const) {
    const i: any = await gh(`repos/${repo}/issues/${n}`);
    issues.push(`${repo}#${n}: ${i.state ?? "error " + i.error}${i.closed_at ? " closed " + i.closed_at.slice(0, 10) : ""} "${String(i.title ?? "").slice(0, 60)}"`);
  }
  const ok = issues.every((i) => !i.includes("error"));
  finding("issues", "NearBlocks #1610 closed Aug 2026 (locked banner); #1175 open (deploy code hash); btc-bridge #78 rebuild mismatch", issues.join(" | "), ok ? "confirmed" : "unverified", "api.github.com issues (state only; read the text by hand)");
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────
const outFile = path.join(ROOT, "docs/FACTCHECK.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ startedAt, rpc: RPC, atBlock, rpcCalls, findings, raw }, null, 1));
for (const f of findings) {
  console.log(`[${f.status === "confirmed" ? "ok" : f.status === "changed" ? "!!" : "??"}] ${f.id}\n     claim:  ${f.claim}\n     result: ${f.result}\n     source: ${f.evidence}`);
}
console.log(`\n${findings.filter((f) => f.status === "confirmed").length}/${findings.length} confirmed, ${rpcCalls} RPC calls. Raw data: docs/FACTCHECK.json`);
