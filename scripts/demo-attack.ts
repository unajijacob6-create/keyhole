// npm run demo:attack — the silent-upgrade attack, end to end on testnet, in one command.
//
//  1. vault.keyhole.testnet runs demo-vault-v1 (honest). Its owner kept one full-access key.
//  2. Keyhole inspects it → CAUTION (one key can replace the code). The agent's guarded deposit
//     goes through with a warning.
//  3. The owner key silently redeploys demo-vault-v2, which adds `sweep`.
//  4. The watcher sees the DeployContract in the block stream, posts ChangeObserved to the Keyhole
//     registry, and the export diff shows `+ sweep`.
//  5. Keyhole now says STOP (code changed minutes ago, new hash unverified and unreviewed).
//  6. The agent's next deposit is refused in code.
//
// Idempotent: if the vault already runs v2 from an earlier run, it is first reset to v1.
// Needs keys for keyhole.testnet (master), vault.keyhole.testnet (owner) and watcher.keyhole.testnet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { inspect, analyzeWasm, exportDiff, codeHash, type KeyholeReport } from "../packages/core/src/index.ts";
import { guardCall, GuardRefusal } from "../packages/guard/src/index.ts";
import { follow, lastFinal } from "../watcher/src/follow.ts";
import { registryPoster } from "../watcher/src/poster.ts";
import { account, accountExists, cfg, NEAR, saveKey, TGAS, txLink, view, yoctoToNear, provider } from "./lib/near.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const say = (s: string) => console.log(`${ts()}  ${s}`);
const step = (n: number, s: string) => console.log(`\n${ts()}  ── ${n}. ${s}`);

function wasmPath(name: string) {
  // Prefer the reproducible CI build (with NEP-330 build_info) when it has been fetched.
  const repro = path.join(ROOT, "contracts/repro", name);
  return fs.existsSync(repro) ? repro : path.join(ROOT, "contracts/out", name);
}
const V1 = new Uint8Array(fs.readFileSync(wasmPath("demo_vault_v1.wasm")));
const V2 = new Uint8Array(fs.readFileSync(wasmPath("demo_vault_v2.wasm")));
const [V1_HASH, V2_HASH] = [await codeHash(V1), await codeHash(V2)];

function verdictLine(r: KeyholeReport) {
  const g = r.grade;
  const glyph = g.verdict === "OK" ? "[OK]" : g.verdict === "CAUTION" ? "[!!]" : "[XX]";
  return `${glyph} ${g.verdict} · ${g.class}${g.flags.length ? " · " + g.flags.join(" ") : ""}\n           ${g.headline}`;
}
function topReasons(r: KeyholeReport, n = 3) {
  for (const reason of r.grade.reasons.slice(0, n)) say(`   [${{ stop: "XX", caution: "!!", info: "--", ok: "ok" }[reason.severity]}] ${reason.text}`);
}

console.log(`Keyhole silent-upgrade demo (testnet) — vault ${cfg.vault}`);
console.log(`v1 ${V1_HASH}\nv2 ${V2_HASH}`);

// ── 0. setup / reset (idempotent) ──
step(0, "setup");
const master = account(cfg.master);
for (const [id, near] of [[cfg.vault, 3], [cfg.agent, 2]] as const) {
  if (!(await accountExists(id))) {
    const kp = KeyPair.fromRandom("ed25519");
    await master.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(near) });
    saveKey(id, kp);
    say(`created ${id}`);
  }
}
const owner = account(cfg.vault); // the vault owner's full-access key
const agentAcct = account(cfg.agent);
const head0 = await lastFinal("testnet");
const current = (await provider.viewAccount({ accountId: cfg.vault })).code_hash;
if (current !== V1_HASH) {
  const r: any = await owner.deployContract(V1);
  say(`reset: vault was ${current.slice(0, 8)}…, redeployed v1 (tx ${r.transaction.hash.slice(0, 10)}…)`);
}
try {
  await view(cfg.vault, "get_owner");
} catch {
  await owner.callFunction({ contractId: cfg.vault, methodName: "new", args: { owner_id: cfg.vault }, gas: TGAS(30) });
  say("initialised vault (owner = the vault account's own key)");
}
// Start the watcher now (in this process), from the block before any reset, so it records every change.
const poster = await registryPoster();
const ctrl = new AbortController();
let resolveV2: (e: any) => void;
const sawV2 = new Promise<any>((r) => (resolveV2 = r));
const watcher = follow({
  network: "testnet",
  watch: new Set([cfg.vault]),
  from: head0,
  poster,
  feed: path.join(ROOT, "data/feed-testnet.jsonl"),
  signal: ctrl.signal,
  log: (l) => say(l),
  until: () => false,
}).catch((e) => say(`[watch] error: ${e.message}`));
// follow() logs every event; resolve when the v2 deploy has been posted.
const origLog = console.log;
const pollV2 = setInterval(async () => {
  try {
    const latest: any = await new (await import("../packages/core/src/index.ts")).Rpc({ network: "testnet" }).view(process.env.KH_REGISTRY ?? "registry.keyhole.testnet", "get_latest", { account_id: cfg.vault });
    if (latest?.attestation?.new_hash === V2_HASH && latest.timestamp_ms > t0) resolveV2(latest);
  } catch {
    /* keep polling */
  }
}, 1500);

// ── 1. inspect v1 ──
step(1, `Keyhole inspects ${cfg.vault}`);
let rep = await inspect(cfg.vault, { network: "testnet", history: false, checkRepo: false });
say(verdictLine(rep));
topReasons(rep);

// ── 2. guarded deposit while v1 runs ──
step(2, "agent deposits through guardCall (policy: proceed on CAUTION with a warning)");
const execute = async (contractId: string, call: { methodName: string; deposit?: bigint | string }) => {
  const res: any = await agentAcct.callFunctionRaw({ contractId, methodName: call.methodName, args: {}, deposit: BigInt(call.deposit ?? 0), gas: TGAS(30) });
  return res.transaction.hash as string;
};
const tx1 = await guardCall(cfg.vault, { methodName: "deposit", deposit: NEAR(0.1) }, { execute, policy: { onCaution: "allow" }, inspect: { network: "testnet", history: false, checkRepo: false }, log: say });
say(`deposit 0.1 NEAR ok: ${txLink(tx1)}`);
say(`vault total: ${yoctoToNear(await view<string>(cfg.vault, "get_total"))} NEAR`);

// ── 3. silent redeploy ──
step(3, "the owner key silently redeploys the vault with v2");
const r3: any = await owner.deployContract(V2);
say(`DeployContract v2: ${txLink(r3.transaction.hash)}`);

// ── 4. watcher catches it ──
step(4, "watcher: block stream → registry");
const obs = await Promise.race([sawV2, new Promise((_, rej) => setTimeout(() => rej(new Error("watcher did not report the v2 deploy within 90 s")), 90_000))]);
clearInterval(pollV2);
say(`registry ${process.env.KH_REGISTRY ?? "registry.keyhole.testnet"} record #${(obs as any).id}: ChangeObserved ${V1_HASH.slice(0, 8)}… → ${V2_HASH.slice(0, 8)}… at block ${(obs as any).attestation.block_height}`);
const d = exportDiff(analyzeWasm(V1), analyzeWasm(V2));
say(`export diff v1 → v2: ${[...d.addedMethods.map((m) => "+ " + m), ...d.removedMethods.map((m) => "- " + m), ...d.addedHostImports.map((m) => "+ import " + m)].join("  ") || "(none)"}`);

// ── 5. inspect again ──
step(5, `Keyhole inspects ${cfg.vault} again`);
rep = await inspect(cfg.vault, { network: "testnet", history: false, checkRepo: false });
say(verdictLine(rep));
topReasons(rep);

// ── 6. guarded deposit is refused ──
step(6, "agent tries to deposit again");
let refused = false;
try {
  await guardCall(cfg.vault, { methodName: "deposit", deposit: NEAR(0.1) }, { execute, policy: { onCaution: "allow" }, inspect: { network: "testnet", history: false, checkRepo: false }, log: say });
} catch (e) {
  if (!(e instanceof GuardRefusal)) throw e;
  refused = true;
  say("deposit NOT sent: GuardRefusal thrown before signing; no transaction was created");
}
ctrl.abort();
await watcher;
console.log = origLog;
console.log(`\n${ts()}  done. ${refused && rep.grade.verdict === "STOP" ? "Attack caught: verdict STOP, agent refused." : "UNEXPECTED: see output above."}`);
console.log(`           re-check: npx keyhole inspect ${cfg.vault} --evidence`);
console.log(`           registry: near view registry.keyhole.testnet get_history '{"account_id":"${cfg.vault}"}'`);
process.exit(refused && rep.grade.verdict === "STOP" ? 0 : 1);
