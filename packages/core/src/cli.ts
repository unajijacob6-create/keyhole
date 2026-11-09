// keyhole CLI: `keyhole inspect <account> [--json] [--evidence] [--network mainnet|testnet] [--no-history]`
//              `keyhole diff <account|file.wasm> <account|file.wasm> [--network ...]`
import { inspect, type KeyholeReport } from "./inspect.ts";
import { recheckCommand } from "./evidence.ts";
import { Rpc, type Network } from "./rpc.ts";
import { analyzeWasm, exportDiff } from "./wasm.ts";
import { codeHash } from "./hash.ts";

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

export async function main(argv = process.argv.slice(2)) {
  const [cmd, a, b] = argv.filter((x, i, arr) => !x.startsWith("--") && !(i > 0 && ["--network", "--registry"].includes(arr[i - 1])));
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
  console.log("usage:\n  keyhole inspect <account> [--json] [--evidence] [--network mainnet|testnet] [--no-history] [--registry <account>]\n  keyhole diff <account[@block]|file.wasm> <account[@block]|file.wasm> [--json]");
  return 1;
}
