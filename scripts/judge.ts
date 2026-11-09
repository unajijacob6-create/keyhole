// npm run judge — zero-key, read-only checks of Keyhole's live deployment and offline proofs.
// Needs outbound HTTPS to NEAR public RPC (testnet + mainnet). Exits non-zero if any check fails.
// See docs/JUDGE.md for what each check proves and how to re-run it by hand.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { Rpc, inspect, fixtureTransport, analyzeWasm, exportDiff, codeHash, normaliseRecord, KEYHOLE_REGISTRY, effectiveHash, ARCHIVAL_RPC } from "../packages/core/src/index.ts";
import { verifyReceiptOffline } from "../reviewer/src/review.ts";
import { listUpgradeProposals, fetchPendingCode, txApi } from "../packages/core/src/index.ts";
import { decodeHatch, verifyHatch } from "../packages/hatch/src/index.ts";
import { pickReplayLines, replayGuardianRun } from "./lib/replay.ts";
import { findExecutingVote } from "./lib/vote-timing.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.KH_REGISTRY ?? KEYHOLE_REGISTRY.account;
const VAULT = process.env.KH_VAULT ?? "vault.keyhole.testnet";
const testnet = new Rpc({ network: "testnet" });
const mainnet = new Rpc({ network: "mainnet" });
const archival = new Rpc({ network: "testnet", url: ARCHIVAL_RPC.testnet });
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/repro/manifest.json"), "utf8"));
const V1 = manifest.wasm["demo_vault_v1.wasm"].code_hash as string;
const V2 = manifest.wasm["demo_vault_v2.wasm"].code_hash as string;

let n = 0;
const results: boolean[] = [];
async function check(title: string, fn: () => Promise<string[]>) {
  n++;
  try {
    const lines = await fn();
    console.log(`${String(n).padStart(2)}. [ok] ${title}`);
    for (const l of lines) console.log(`       ${l}`);
    results.push(true);
  } catch (e) {
    console.log(`${String(n).padStart(2)}. [FAIL] ${title}`);
    console.log(`       ${String((e as Error).message).split("\n").join("\n       ")}`);
    results.push(false);
  }
}
const must = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const records = async (method: string, args: object) => ((await testnet.view<any[]>(REGISTRY, method, { from_index: 0, limit: 100, ...args })) ?? []).map(normaliseRecord);

console.log(`keyhole judge · ${new Date().toISOString()} · registry ${REGISTRY} (testnet) · vault ${VAULT}\n`);

await check("the testnet registry answers, and Keyhole grades the registry itself", async () => {
  const stats = await testnet.view<any>(REGISTRY, "get_stats");
  const attesters = await testnet.view<string[]>(REGISTRY, "get_attesters");
  const owner = await testnet.view<string>(REGISTRY, "get_owner");
  must(stats.attestations > 0, "registry has no attestations");
  const r = await inspect(REGISTRY, { network: "testnet", history: false, checkRepo: false });
  must(r.wasm && !r.wasm.capabilities.deploy_contract && !r.wasm.capabilities.use_global_contract, "registry code imports a code-change host function");
  return [
    `${stats.attestations} attestations about ${stats.accounts} account(s); owner ${owner}; attesters ${attesters.join(", ")}`,
    `registry code ${r.code?.hash}: no deploy / global-contract host functions; verdict ${r.grade.verdict} ${r.grade.class}${r.keys.fullAccess.length ? ` (${r.keys.fullAccess.length} full-access key kept while the hackathon runs)` : ""}`,
  ];
});

await check("the demo vault's v1 → v2 silent upgrade is on record at a block anyone can re-query", async () => {
  const hist = await records("get_history", { account_id: VAULT });
  const change = [...hist].reverse().find((r) => r.attestation.kind === "ChangeObserved" && (r.attestation as any).old_hash === V1 && (r.attestation as any).new_hash === V2);
  must(change, `no ChangeObserved ${V1.slice(0, 8)}… → ${V2.slice(0, 8)}… for ${VAULT} (run npm run demo:attack)`);
  const h = (change!.attestation as any).block_height as number;
  const before = effectiveHash(await archival.viewAccount(VAULT, h - 1));
  const after = effectiveHash(await archival.viewAccount(VAULT, h));
  must(before === V1 && after === V2, `archival view_account says ${before.slice(0, 8)}… at ${h - 1} and ${after.slice(0, 8)}… at ${h}`);
  const d = exportDiff(analyzeWasm(new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro/demo_vault_v1.wasm")))), analyzeWasm(new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro/demo_vault_v2.wasm")))));
  must(d.addedMethods.includes("sweep"), "export diff does not show + sweep");
  return [`registry record #${change!.id} by ${change!.attester}: block ${h.toLocaleString("en-US")}`, `archival view_account: ${before.slice(0, 10)}… at ${h - 1}, ${after.slice(0, 10)}… at ${h} (re-checked independently)`, `export diff v1 → v2: ${d.addedMethods.map((m) => "+ " + m).join(" ")}`];
});

await check("v1's wasm proves no method can redeploy it; the reproducible builds hash to the manifest", async () => {
  const lines: string[] = [];
  for (const [f, w] of Object.entries<any>(manifest.wasm)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro", f)));
    must((await codeHash(bytes)) === w.code_hash, `${f} does not hash to the manifest`);
    lines.push(`${f}: ${w.code_hash} (built in ${manifest.run})`);
  }
  const a = analyzeWasm(new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro/demo_vault_v1.wasm"))));
  must(!a.capabilities.deploy_contract && !a.capabilities.add_full_access_key && a.codeChangeEntrypoints?.length === 0, "v1 imports a code-change host function");
  lines.push("demo_vault_v1: imports no deploy / add-full-access-key / global-contract host function");
  return lines;
});

await check("inspect() grades the recorded mainnet fixture corpus as recorded (offline, deterministic)", async () => {
  const dir = path.join(ROOT, "packages/core/test/fixtures");
  const out: string[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz"))) {
    const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
    const t = fixtureTransport(fx.fixtures);
    const r = await inspect(fx.account, { transport: t, history: fx.history, registry: { rpc: new Rpc({ network: "testnet", transport: t, retries: 0 }) }, checkRepo: false, sourceRoles: false, nowMs: fx.nowMs });
    must(r.grade.class === fx.expected.class && r.grade.verdict === fx.expected.verdict, `${fx.account}: got ${r.grade.verdict} ${r.grade.class}, recorded ${fx.expected.verdict} ${fx.expected.class}`);
    out.push(`${fx.account.length > 30 ? fx.account.slice(0, 12) + "…" : fx.account}: ${r.grade.verdict} ${r.grade.class}`);
  }
  return [out.join(" · ")];
});

await check("labelled eval corpus: Keyhole's control class vs ground truth (live)", async () => {
  const file = path.join(ROOT, "eval/corpus.json");
  must(fs.existsSync(file), "eval/corpus.json missing (npm run eval)");
  const corpus = JSON.parse(fs.readFileSync(file, "utf8"));
  let correct = 0;
  let dangerous = 0;
  const misses: string[] = [];
  for (const c of corpus.entries) {
    const r = await inspect(c.account, { network: c.network, history: false, checkRepo: false });
    const got = r.grade.class;
    if (got === c.expected_class) correct++;
    else {
      // "dangerous" = Keyhole says safer than the truth (e.g. GOVERNED when truth is CUSTODIAL).
      const order = ["IMMUTABLE", "GOVERNED", "UNRESOLVED", "CUSTODIAL"];
      if (order.indexOf(got) >= 0 && order.indexOf(got) < order.indexOf(c.expected_class) && !(got === "UNRESOLVED")) dangerous++;
      misses.push(`${c.account}: expected ${c.expected_class}, got ${got}`);
    }
  }
  must(dangerous === 0, `dangerous misclassifications: ${misses.join("; ")}`);
  return [`${correct}/${corpus.entries.length} correct, 0 graded safer than ground truth`, ...misses.map((m) => `conservative miss: ${m}`)];
});

await check("the TEE review receipt for the v1 → v2 diff re-verifies offline and matches the registry", async () => {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "data/reviews/vault-v1-to-v2.json"), "utf8"));
  const v = verifyReceiptOffline(rec);
  must(v.ok, v.checks.join("; "));
  const content = JSON.parse(rec.response_body).choices[0].message.content as string;
  must(/"risk"\s*:\s*"high"/.test(content), "published response does not report high risk");
  const onchain = (await records("get_attestations", { code_hash: V2 })).filter((r) => r.attestation.kind === "AiReview");
  must(onchain.some((r) => (r.attestation as any).response_sha256 === rec.receipt.response_hash), "no AiReview in the registry with this response hash");
  return [...v.checks, `registry AiReview for ${V2.slice(0, 8)}… carries the same response_sha256 (${rec.receipt.response_hash.slice(0, 12)}…)`];
});

await check("a SourceScan-verified mainnet contract re-checks, and a CI rebuild matches intents.near", async () => {
  const sweat = await mainnet.viewAccount("token.sweat");
  const byHash = await mainnet.view<any[]>("v2-verifier.sourcescan.near", "get_contracts_by_code_hash", { code_hash: sweat.code_hash });
  must(byHash.length > 0, `SourceScan has no entry for token.sweat's current hash ${sweat.code_hash}`);
  const intents = await mainnet.viewAccount("intents.near");
  const att = (await records("get_attestations", { code_hash: intents.code_hash })).find((r) => r.attestation.kind === "ReproducibleBuild" && (r.attestation as any).matches === true);
  must(att, `no matching ReproducibleBuild attestation for intents.near's current hash ${intents.code_hash}`);
  const ss = await mainnet.view<any>("v2-verifier.sourcescan.near", "get_contract", { account_id: "intents.near" });
  return [
    `token.sweat ${sweat.code_hash.slice(0, 10)}…: SourceScan-verified (${byHash.map((x) => x[0]).join(", ")})`,
    `intents.near ${intents.code_hash.slice(0, 10)}…: rebuilt from ${(att!.attestation as any).repo}@${String((att!.attestation as any).rev).slice(0, 10)} → match (registry #${att!.id}); SourceScan entry is for ${ss?.code_hash?.slice(0, 10) ?? "none"}…`,
  ];
});

// ── Keyhole Guardian ──
await check("Guardian: the recorded testnet run re-derives from archival RPC (bytes, signature, order, outcome)", async () => {
  const lines: string[] = [];
  const ok = await replayGuardianRun(path.join(ROOT, "data/guardian-run.json"), { log: (l) => lines.push(l.trim()) });
  must(ok, lines.filter((l) => l.startsWith("XX")).join("\n") || "replay failed");
  // The lines this check's title stands for must each be there (a replay that skipped one is a FAIL).
  const { shown, missing, summary, passed } = pickReplayLines(lines);
  must(missing.length === 0, `replay output lacks: ${missing.join(" | ")}`);
  must(passed, `unexpected replay summary: ${summary}`);
  return [...shown, summary];
});

await check("Guardian: the hatch's signed bytes decode to exactly one withdraw-to-self, and tampering is rejected (offline)", async () => {
  const run = JSON.parse(fs.readFileSync(path.join(ROOT, "data/guardian-run.json"), "utf8"));
  const h = run.hatch;
  const v = verifyHatch(h);
  must(v.ok, v.checks.join("; "));
  const d = decodeHatch(h);
  must(d.senderId === h.account && d.actions.length === 1 && d.actions[0].deposit === "1", "unexpected delegate contents");
  const tampered = ["venue", "method", "deposit", "nonce"].map((k) => verifyHatch({ ...h, [k]: k === "venue" ? "evil.testnet" : k === "method" ? "sweep" : "2" }).ok);
  must(tampered.every((x) => !x), "a tampered record verified");
  return [`${d.senderId} → ${d.receiverId}.${d.actions[0].method}(${JSON.stringify(d.actions[0].args)}) · ${d.actions[0].deposit} yocto · nonce ${d.nonce} · valid to ${d.maxBlockHeight}`, "changing receiver, method, deposit or nonce fails verification"];
});

await check("Guardian: a real mainnet upgrade's bytes were public before it executed (Ref proposal 1018)", async () => {
  const p = (await listUpgradeProposals(mainnet, "ref-finance.sputnik-dao.near", { last: 40 })).find((x) => x.id === 1018);
  must(p && p.code_hash === "GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi" && p.target === "v2.ref-finance.near", `proposal 1018 not decoded as expected: ${JSON.stringify(p)?.slice(0, 160)}`);
  const blob = await fetchPendingCode({ api: txApi("mainnet"), dao: p!.dao, hash: p!.code_hash!, maxPages: 8 });
  must(blob, "store_blob transaction not found in the tx index");
  must((await codeHash(blob!.code)) === p!.code_hash, "bytes do not hash to the proposal hash");
  const vote = await findExecutingVote({ api: txApi("mainnet"), dao: p!.dao, id: p!.id, target: p!.target, maxPages: 8 });
  must(vote, "the vote that executed proposal 1018 was not found in the tx index");
  // Block timestamps from archival RPC (nanoseconds), not from the tx index.
  const archivalMainnet = new Rpc({ network: "mainnet", url: ARCHIVAL_RPC.mainnet });
  const tsOf = async (h: number) => Number(BigInt((await archivalMainnet.block({ block_id: h })).header.timestamp) / 1_000_000n);
  const blobMs = await tsOf(blob!.height);
  const execMs = await tsOf(vote!.execHeight);
  must(blob!.height < vote!.txHeight && blob!.height < vote!.execHeight && blobMs < execMs, `store_blob at block ${blob!.height} is not before the executing vote (tx block ${vote!.txHeight}, executed at ${vote!.execHeight})`);
  const iso = (ms: number) => new Date(ms).toISOString();
  return [
    `UpgradeRemote(v2.ref-finance.near.upgrade, ${p!.code_hash!.slice(0, 10)}…) submitted ${iso(p!.submitted_at_ms)}, ${p!.votes.approve}/${p!.required} approvals`,
    `store_blob ${blob!.tx} by ${blob!.signer}: block ${blob!.height} (${iso(blobMs)}), ${blob!.code.length} bytes, sha256 = proposal hash`,
    `executing vote ${vote!.tx} by ${vote!.signer}: tx block ${vote!.txHeight}, reached ${p!.target} at block ${vote!.execHeight} (${iso(execMs)})`,
    `bytes on chain ${vote!.execHeight - blob!.height} blocks (${Math.round((execMs - blobMs) / 1000)} s) before the upgrade ran`,
  ];
});

const failed = results.filter((x) => !x).length;
console.log(`\n${failed ? `${failed} check(s) FAILED` : "all checks ok"} (${results.length} checks)`);
process.exit(failed ? 1 : 0);
