// Reproducible-build verifier. Runs in GitHub Actions (public runner, NOT a TEE):
//
//   tsx verifier/src/rebuild.ts <account> [--network mainnet|testnet] [--out dir]
//
// 1. Read NEP-330 contract_source_metadata.build_info from the deployed contract.
// 2. Clone source_code_snapshot (git+<url>?rev=<rev>) at exactly that rev.
// 3. Run `cargo near build reproducible-wasm` in contract_path, which uses the pinned image from
//    the project's Cargo.toml (checked against build_info.build_environment).
// 4. Compare base58(sha256(output wasm)) with the on-chain code hash. Write a JSON result.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Rpc, codeHash, sha256Hex, effectiveHash, type Network } from "../../packages/core/src/index.ts";

const argv = process.argv.slice(2);
const account = argv.find((a) => !a.startsWith("--"))!;
const network = (argv.includes("--network") ? argv[argv.indexOf("--network") + 1] : account.endsWith(".testnet") ? "testnet" : "mainnet") as Network;
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "verifications";
const work = fs.mkdtempSync("/tmp/kh-verify-");
const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

const rpc = new Rpc({ network });
const acct = await rpc.viewAccount(account);
const onchain = effectiveHash(acct);
const meta: any = await rpc.view(account, "contract_source_metadata");
const bi = meta?.build_info;
const result: Record<string, unknown> = { schema: "keyhole.verification/1", account, network, onchain_code_hash: onchain, at_block: acct.block_height, checked_at: new Date().toISOString(), run: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null, build_info: bi ?? null };

function finish(matches: boolean | null, extra: Record<string, unknown> = {}) {
  Object.assign(result, extra, { matches });
  const file = path.join(outDir, network, account, `${onchain}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (!bi?.source_code_snapshot) finish(null, { reason: "no NEP-330 build_info / source_code_snapshot; nothing to rebuild" });
const m = String(bi.source_code_snapshot).match(/^git\+(.+?)\?rev=([0-9a-f]{7,40})$/);
if (!m) finish(null, { reason: `unsupported source_code_snapshot ${bi.source_code_snapshot}` });
const [, repoUrl, rev] = m!;
result.repo = repoUrl;
result.rev = rev;
result.image = bi.build_environment;

try {
  sh("git", ["clone", "--quiet", repoUrl, path.join(work, "src")]);
  sh("git", ["checkout", "--quiet", rev], path.join(work, "src"));
  const contractDir = path.join(work, "src", bi.contract_path ?? "");
  // The image pinned in Cargo.toml at this rev must be the one build_info declares.
  const cargoToml = fs.readFileSync(path.join(contractDir, "Cargo.toml"), "utf8");
  const digest = String(bi.build_environment).split("@")[1];
  if (digest && !cargoToml.includes(digest)) finish(false, { reason: "Cargo.toml at this rev pins a different image than build_info.build_environment" });
  const t0 = Date.now();
  sh("cargo", ["near", "build", "reproducible-wasm"], contractDir);
  result.build_seconds = Math.round((Date.now() - t0) / 1000);
  const outRel = String(bi.output_wasm_path ?? "").replace(/^\/home\/near\/code\//, "");
  const targetDirs = [path.join(work, "src", "target", "near"), path.join(contractDir, "target", "near")].filter((d) => fs.existsSync(d));
  const candidates = [outRel && path.join(work, "src", outRel), ...targetDirs.flatMap((d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, String(f))))].filter((f) => f && String(f).endsWith(".wasm") && fs.existsSync(f));
  const results = [];
  for (const f of new Set(candidates)) {
    const bytes = new Uint8Array(fs.readFileSync(f as string));
    results.push({ file: path.relative(work, f as string), code_hash: await codeHash(bytes), sha256: await sha256Hex(bytes), size: bytes.length });
  }
  const hit = results.find((r) => r.code_hash === onchain);
  finish(Boolean(hit), { rebuilt: results, rebuilt_code_hash: hit?.code_hash ?? results[0]?.code_hash ?? null });
} catch (e) {
  finish(null, { reason: `rebuild failed: ${String((e as Error).message).slice(0, 300)}` });
}
