// npm run demo:guardian — Keyhole Guardian end to end on testnet, in one command.
//
//   A Sputnik DAO (2 of 2 council approvals) owns a vault. Alice and Bob deposit. Alice arms an
//   escape hatch: a withdraw_all she signs now, that the guardian may submit later. Bob does not.
//   A council member stores a new wasm blob and proposes UpgradeRemote. Before the deciding vote,
//   Keyhole reads the exact bytes being voted on, diffs them against the live code (+ sweep), finds
//   no verified build, says STOP and fires Alice's hatch. The votes pass, the upgrade runs, the
//   sweep takes what is left: Bob's deposit. Alice's funds are already home.
//
// Every step's tx hash is recorded to data/guardian-run.json. `npm run demo:guardian -- --replay`
// re-checks that recording against public testnet RPC with no keys (see scripts/lib/replay.ts).
// Live mode needs the keys created by `npm run setup:guardian`. Testnet only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { analyzeWasm, codeHash, exportDiff, inspect, Rpc, txApi, type KeyholeReport } from "../packages/core/src/index.ts";
import { armDelegateHatch, fireHatch, hatchHealth, verifyHatch, decodeHatch, type Hatch } from "../packages/hatch/src/index.ts";
import { Guardian, type Alert } from "../guardian/src/guardian.ts";
import { Radar } from "../guardian/src/radar.ts";
import { account, accountExists, cfg, NEAR, provider, saveKey, TGAS, txLink, view, yoctoToNear } from "./lib/near.ts";
import { replayGuardianRun } from "./lib/replay.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_FILE = path.join(ROOT, "data/guardian-run.json");
const argv = process.argv.slice(2);
if (argv.includes("--replay")) process.exit((await replayGuardianRun(argv[argv.indexOf("--replay") + 1] && !argv[argv.indexOf("--replay") + 1].startsWith("--") ? argv[argv.indexOf("--replay") + 1] : RUN_FILE)) ? 0 : 1);

const t0 = Date.now();
const rpc = new Rpc({ network: "testnet" });
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
type Step = { t: number; step: number; title: string; lines: string[] };
export interface GuardianRun {
  schema: "keyhole.guardian-run/1";
  recordedAt: string;
  network: "testnet";
  dao: string;
  vault: string;
  accounts: { alice: string; bob: string; proposer: string; approver: string; guardian: string; sweepTo: string };
  code: { honest: string; evil: string };
  proposal_id: number | null;
  hatch: Hatch | null;
  tx: Record<string, string>;
  signers: Record<string, string>;
  heights: Record<string, number>;
  timings_ms: Record<string, number>;
  balances: Record<string, string>;
  verdicts: Record<string, { verdict: string; class?: string; flags: string[]; headline: string }>;
  alerts: Alert[];
  steps: Step[];
  outcome: { alice_safe: boolean; bob_swept: boolean; fired_before_execution: boolean } | null;
}
const run: GuardianRun = {
  schema: "keyhole.guardian-run/1",
  recordedAt: new Date().toISOString(),
  network: "testnet",
  dao: cfg.dao,
  vault: "",
  accounts: { alice: cfg.alice, bob: cfg.bob, proposer: cfg.councilA, approver: cfg.councilB, guardian: cfg.guardian, sweepTo: process.env.KH_SWEEP_TO ?? "keyhole-attacker.testnet" },
  code: { honest: "", evil: "" },
  proposal_id: null,
  hatch: null,
  tx: {},
  signers: {},
  heights: {},
  timings_ms: {},
  balances: {},
  verdicts: {},
  alerts: [],
  steps: [],
  outcome: null,
};
const say = (s: string) => {
  console.log(`${ts()}  ${s}`);
  run.steps.at(-1)?.lines.push(`${ts()}  ${s}`);
};
const step = (n: number, s: string) => {
  console.log(`\n${ts()}  ── ${n}. ${s}`);
  run.steps.push({ t: Date.now() - t0, step: n, title: s, lines: [] });
};
const mark = (k: string) => (run.timings_ms[k] = Date.now() - t0);
const txOf = (r: any): string => r?.transaction?.hash ?? r?.transaction_outcome?.id ?? "";
const heightOf = async (hash: string, signer: string): Promise<number> => {
  if (!hash) return 0;
  try {
    const r: any = await rpc.call("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" });
    return ((await rpc.block({ block_id: r.transaction_outcome.block_hash })) as any).header.height as number;
  } catch {
    return 0;
  }
};
const record = async (key: string, r: any, signer: string) => {
  const h = txOf(r);
  run.tx[key] = h;
  run.signers[key] = signer;
  run.heights[key] = await heightOf(h, signer);
  return h;
};

function wasm(name: string): Uint8Array {
  const repro = path.join(ROOT, "contracts/repro", `${name}.wasm`);
  const out = path.join(ROOT, "contracts/out", `${name}.wasm`);
  const file = fs.existsSync(repro) ? repro : out;
  if (!fs.existsSync(file)) throw new Error(`missing ${name}.wasm: run bash contracts/test.sh (builds contracts/out)`);
  return new Uint8Array(fs.readFileSync(file));
}
const HONEST = wasm("guarded_vault");
const EVIL = wasm("guarded_vault_evil_sweep");
run.code = { honest: await codeHash(HONEST), evil: await codeHash(EVIL) };

const REG = { rpc: undefined, account: cfg.registry };
const verdictLine = (r: KeyholeReport) => `${r.grade.verdict} · ${r.grade.class}${r.grade.flags.length ? " · " + r.grade.flags.join(" ") : ""} — ${r.grade.headline}`;
const bal = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
const vbal = async (vault: string, id: string) => BigInt(await view<string>(vault, "get_balance", { account_id: id }));

console.log(`Keyhole Guardian demo (testnet)\n  DAO ${cfg.dao}\n  honest vault ${run.code.honest}\n  evil upgrade ${run.code.evil}`);

// ── 0. setup ──
step(0, "setup: a fresh vault owned by the DAO");
for (const id of [cfg.master, cfg.councilA, cfg.councilB, cfg.alice, cfg.bob, cfg.guardian, cfg.dao]) {
  if (!(await accountExists(id))) throw new Error(`${id} does not exist: run npm run setup:guardian first`);
}
const master = account(cfg.master);
const vaultId = `gv-${Date.now().toString(36)}.${cfg.master}`;
run.vault = vaultId;
{
  const kp = KeyPair.fromRandom("ed25519");
  await master.createSubAccount({ accountOrPrefix: vaultId, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(1.4) });
  saveKey(vaultId, kp);
  const v = account(vaultId);
  await record("deploy_vault", await v.deployContract(HONEST), vaultId);
  await record("init_vault", await v.callFunction({ contractId: vaultId, methodName: "new", args: { owner_id: cfg.dao }, gas: TGAS(30) }), vaultId);
  // Leave only the DAO able to change the code: delete the vault's own full-access key.
  await record("delete_vault_key", await v.deleteKey(kp.getPublicKey()), vaultId);
  say(`${vaultId}: guarded vault (withdraw_all needs exactly 1 yoctoNEAR, like Ref and Burrow), owner ${cfg.dao}, no access keys left`);
}

// ── 1. deposits ──
step(1, "Alice deposits 1 NEAR, Bob deposits 0.5 NEAR");
const alice = account(cfg.alice);
const bob = account(cfg.bob);
await record("alice_deposit", await alice.callFunction({ contractId: vaultId, methodName: "deposit", args: {}, deposit: NEAR(1), gas: TGAS(30) }), cfg.alice);
await record("bob_deposit", await bob.callFunction({ contractId: vaultId, methodName: "deposit", args: {}, deposit: NEAR(0.5), gas: TGAS(30) }), cfg.bob);
say(`vault total ${yoctoToNear(await view<string>(vaultId, "get_total"))} NEAR (alice ${yoctoToNear(await vbal(vaultId, cfg.alice))}, bob ${yoctoToNear(await vbal(vaultId, cfg.bob))})`);

// ── 2. inspect ──
step(2, `Keyhole inspects ${vaultId}`);
const before = await inspect(vaultId, { network: "testnet", history: false, checkRepo: false, registry: REG });
say(verdictLine(before));
for (const r of before.grade.reasons.slice(0, 3)) say(`   [${{ stop: "XX", caution: "!!", info: "--", ok: "ok" }[r.severity]}] ${r.text}`);
run.verdicts.vault_before = { verdict: before.grade.verdict, class: before.grade.class, flags: before.grade.flags, headline: before.grade.headline };

// ── 3. Alice arms an escape hatch ──
step(3, "Alice arms an escape hatch (pre-signed withdraw_all, 1 yoctoNEAR, relayed by the guardian)");
const hatch = await armDelegateHatch({ owner: alice, provider, venue: vaultId, method: "withdraw_all", args: {}, deposit: "1", gas: TGAS(50).toString(), ttlBlocks: 7 * 24 * 3600, trigger: "stop" });
run.hatch = hatch;
const vh = verifyHatch(hatch);
const dh = decodeHatch(hatch);
say(`hatch ${hatch.id}: ${dh.senderId} → ${dh.receiverId}.${dh.actions[0].method}(${JSON.stringify(dh.actions[0].args)}) deposit ${dh.actions[0].deposit} yocto, valid to block ${dh.maxBlockHeight}`);
say(`signature check: ${vh.ok ? "valid" : "INVALID"} (${vh.checks.join("; ")})`);
say(`dedicated full-access key ${hatch.public_key} added; its secret was used once to sign and never written to disk`);
let health = await hatchHealth(rpc, hatch);
say(`health: ${health.state} (${health.blocks_left ?? "?"} blocks left)`);

// ── 4. guardian starts watching ──
step(4, "guardian starts watching the vault");
const api = txApi("testnet");
const alerts: Alert[] = [];
const radar = new Radar(rpc, "testnet", undefined, { last: 10 });
const ctl = await radar.watch(vaultId);
say(`controller resolved by inspect: ${ctl.daos.join(", ") || "(none)"}`);
const relayer = account(cfg.guardian);
const guardian = new Guardian({
  rpc,
  assess: { rpc, api, registry: { rpc, account: cfg.registry } },
  radar,
  hatches: () => [hatch],
  driver: {
    health: (h) => hatchHealth(rpc, h),
    fire: async (h) => {
      mark("fire_sent");
      const r = await fireHatch(h, relayer);
      mark("fire_done");
      if (r.tx) {
        run.tx.hatch_fired = r.tx;
        run.signers.hatch_fired = cfg.guardian;
        run.heights.hatch_fired = await heightOf(r.tx, cfg.guardian);
      }
      return r;
    },
  },
  onAlert: (a) => {
    alerts.push(a);
    const g = a.assessment?.grade;
    say(`ALERT ${a.event}${a.proposal_id !== null ? ` #${a.proposal_id}` : ""} on ${a.target}${a.votes_to_execute !== null ? ` · ${a.votes_to_execute} more approval(s) execute it` : ""}${g ? ` · ${g.verdict}: ${g.headline}` : ""}`);
    for (const l of a.assessment?.summary ?? []) say(`   diff: ${l}`);
    if (a.assessment?.code_source) say(`   bytes: ${a.assessment.pending_size} from ${a.assessment.code_source.kind}${"tx" in a.assessment.code_source ? ` ${a.assessment.code_source.tx}` : ""}`);
    for (const f of a.fired) say(`   ${f.ok ? "FIRED" : "NOT FIRED"} hatch ${f.hatch} for ${f.account}${f.tx ? `: ${txLink(f.tx)}` : ""}${f.error ? ` (${f.error})` : ""}`);
  },
});
await guardian.tick(); // baseline: existing proposals and the live hash are now "seen"
alerts.length = 0;
say("baseline taken; waiting for changes");

// ── 5. the upgrade is proposed ──
step(5, `${cfg.councilA} stores a new wasm and proposes UpgradeRemote(${vaultId}.upgrade)`);
const proposer = account(cfg.councilA);
const storeCost = BigInt(EVIL.length + 32) * 10n ** 19n + NEAR(0.01);
const storeRes: any = await proposer.callFunctionRaw({ contractId: cfg.dao, methodName: "store_blob", args: EVIL, deposit: storeCost, gas: TGAS(100), waitUntil: "FINAL" } as any);
await record("store_blob", storeRes, cfg.councilA);
say(`store_blob: ${EVIL.length} bytes, ${txLink(run.tx.store_blob)}`);
const addRes: any = await proposer.callFunctionRaw({
  contractId: cfg.dao,
  methodName: "add_proposal",
  args: { proposal: { description: "Vault v1.1: gas optimisations", kind: { UpgradeRemote: { receiver_id: vaultId, method_name: "upgrade", hash: run.code.evil } } } },
  deposit: NEAR(1),
  gas: TGAS(50),
  waitUntil: "FINAL",
} as any);
await record("add_proposal", addRes, cfg.councilA);
mark("proposed");
run.proposal_id = (await view<number>(cfg.dao, "get_last_proposal_id")) - 1;
say(`proposal #${run.proposal_id} "Vault v1.1: gas optimisations": ${txLink(run.tx.add_proposal)}`);

// ── 6. guardian: read the bytes, grade, fire ──
step(6, "guardian: fetch the exact bytes being voted on, diff, grade, act");
// The tx index may need a few seconds to serve the store_blob transaction; the guardian re-checks
// a pending proposal whose bytes it could not read yet on every tick.
for (let i = 0; i < 60 && !alerts.some((a) => a.proposal_id === run.proposal_id && a.assessment?.code_source); i++) {
  await guardian.tick();
  if (!alerts.some((a) => a.proposal_id === run.proposal_id && a.assessment?.code_source)) await new Promise((r) => setTimeout(r, 1000));
}
mark("graded");
const graded = alerts.find((a) => a.proposal_id === run.proposal_id && a.assessment?.code_source);
if (graded?.assessment) run.verdicts.pending = { verdict: graded.assessment.grade.verdict, flags: graded.assessment.grade.flags, headline: graded.assessment.grade.headline };
const d = exportDiff(analyzeWasm(HONEST), analyzeWasm(EVIL));
say(`independent check from repo builds: + ${d.addedMethods.join(", ") || "(none)"}`);
health = await hatchHealth(rpc, hatch);
say(`hatch health now: ${health.state}`);
const aliceInVault = await vbal(vaultId, cfg.alice);
say(`alice in vault: ${yoctoToNear(aliceInVault)} NEAR · bob in vault: ${yoctoToNear(await vbal(vaultId, cfg.bob))} NEAR`);

// ── 7. the votes ──
step(7, "the council votes; the second approval executes the upgrade in the same call");
const vote = async (who: string, key: string) => {
  const r: any = await account(who).callFunctionRaw({ contractId: cfg.dao, methodName: "act_proposal", args: { id: run.proposal_id, action: "VoteApprove", proposal: { UpgradeRemote: { receiver_id: vaultId, method_name: "upgrade", hash: run.code.evil } } }, gas: TGAS(250), waitUntil: "FINAL" } as any);
  await record(key, r, who);
  return r;
};
await vote(cfg.councilA, "vote_1");
say(`vote 1/2 by ${cfg.councilA}: ${txLink(run.tx.vote_1)}`);
await guardian.tick();
await vote(cfg.councilB, "vote_2");
mark("executed");
say(`vote 2/2 by ${cfg.councilB}: ${txLink(run.tx.vote_2)}`);
for (let i = 0; i < 20; i++) {
  if ((await provider.viewAccount({ accountId: vaultId })).code_hash === run.code.evil) break;
  await new Promise((r) => setTimeout(r, 1000));
}
say(`vault code is now ${(await provider.viewAccount({ accountId: vaultId })).code_hash} (version ${await view<string>(vaultId, "version")})`);
await guardian.tick();

// ── 8. the drain ──
step(8, "anyone calls sweep()");
const sweepRes: any = await account(cfg.master).callFunctionRaw({ contractId: vaultId, methodName: "sweep", args: {}, gas: TGAS(50), waitUntil: "FINAL" } as any);
await record("sweep", sweepRes, cfg.master);
say(`sweep: ${txLink(run.tx.sweep)}`);
const aliceAfter = await vbal(vaultId, cfg.alice);
const total = BigInt(await view<string>(vaultId, "get_total"));
run.balances = { alice_in_vault_after_fire: aliceInVault.toString(), vault_total_after_sweep: total.toString(), alice_vault_entry_after_sweep: aliceAfter.toString() };

// ── 9. outcome ──
step(9, "outcome");
const firedAt = run.heights.hatch_fired ?? 0;
const execAt = run.heights.vote_2 ?? 0;
run.outcome = { alice_safe: aliceInVault === 0n && Boolean(run.tx.hatch_fired), bob_swept: total === 0n, fired_before_execution: firedAt > 0 && execAt > 0 && firedAt < execAt };
run.alerts = alerts;
say(`alice: hatch fired at block ${firedAt}, upgrade executed at block ${execAt} → ${run.outcome.fired_before_execution ? "out before it landed" : "NOT before execution"}`);
say(`bob: no hatch; the sweep took the vault's remaining total`);
say(`proposal → STOP+fire: ${((run.timings_ms.fire_done ?? 0) - (run.timings_ms.proposed ?? 0)) / 1000}s (wall clock in this run)`);
health = await hatchHealth(rpc, hatch);
say(`hatch health: ${health.state}`);

// Tidy up: Alice removes the used hatch key; the proposer reclaims the blob's storage deposit.
try {
  await alice.deleteKey(hatch.public_key);
  say("alice deleted the used hatch key");
} catch (e) {
  say(`could not delete hatch key: ${String((e as Error).message).slice(0, 80)}`);
}
try {
  await proposer.callFunction({ contractId: cfg.dao, methodName: "remove_blob", args: { hash: run.code.evil }, gas: TGAS(30) });
  say("proposer removed the blob (storage deposit refunded)");
} catch (e) {
  say(`remove_blob: ${String((e as Error).message).slice(0, 80)}`);
}
if (!process.env.KH_NO_RECORD) fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 1));
const ok = run.outcome.alice_safe && run.outcome.fired_before_execution && run.verdicts.pending?.verdict === "STOP";
console.log(`\n${ts()}  ${ok ? "done: STOP before the deciding vote, Alice exited, Bob was swept." : "UNEXPECTED: see output above."}\n           replay without keys: npm run demo:guardian -- --replay`);
process.exit(ok ? 0 : 1);
