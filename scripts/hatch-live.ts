// Live testnet proof for @keyhole/hatch against the real NEP-141 venue wrap.testnet (and, for fc-key
// mode, a real testnet staking pool). Testnet only: scripts/lib/near.ts refuses any other network.
//
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/hatch-live.ts
//
// Flow: fresh user hatch-<ts>.keyhole.testnet (0.5 NEAR) → storage_deposit + near_deposit 0.1 NEAR into
// wrap.testnet → armDelegateHatch(near_withdraw {amount: <exact balance>}, 1 yocto) → verifyHatch +
// hatchHealth (ARMED) → relayer keyhole.testnet fires it → user's wNEAR is 0, NEAR up by the amount →
// hatchHealth USED → a replay is rejected on chain. Then fc-key mode, revocation, and cleanup (the user
// account is deleted with beneficiary keyhole.testnet).
//
// Writes packages/hatch/test/fixtures/live-run.json: hatch records (public data only; no secret key
// ever leaves memory), tx hashes and the recorded tx outcomes, which the unit tests replay.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { Rpc, recordingTransport } from "../packages/core/src/rpc.ts";
import {
  armDelegateHatch,
  armFunctionCallHatch,
  decodeHatch,
  fireFunctionCallHatch,
  fireHatch,
  hatchHealth,
  probeDeposit,
  verifyHatch,
  type Hatch,
} from "../packages/hatch/src/index.ts";
import { account, cfg, credentialPath, log, NEAR, NETWORK, provider, saveKey, TGAS, txLink, view, yoctoToNear } from "./lib/near.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "packages/hatch/test/fixtures/live-run.json");
const WRAP = "wrap.testnet";
const POOL = process.env.KH_POOL ?? "aurora.pool.f863973.m0";
const RELAYER = process.env.KH_RELAYER ?? cfg.master;
const USER = `hatch-${Date.now()}.${cfg.master}`;
if (NETWORK !== "testnet") throw new Error("testnet only");

const rpc = () => new Rpc({ network: "testnet" }); // fresh each time: Rpc memoizes identical requests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
const wnear = async (id: string) => BigInt((await view<string>(WRAP, "ft_balance_of", { account_id: id })) ?? "0");
function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${what}`);
  log("  ✓", what);
}
async function until<T>(what: string, f: () => Promise<T>, ok: (v: T) => boolean, tries = 30): Promise<T> {
  let v = await f();
  for (let i = 0; i < tries && !ok(v); i++) {
    await sleep(1000);
    v = await f();
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what} (last: ${String(v)})`);
  return v;
}
const health = async (h: Hatch, want: string) => until(`hatchHealth ${want}`, () => hatchHealth(rpc(), h), (r) => r.state === want);

const run: Record<string, any> = { network: "testnet", started_at: new Date().toISOString(), user: USER, relayer: RELAYER, venue: WRAP, pool: POOL, txs: {} as Record<string, string> };
const outcomes: Record<string, { result?: unknown; error?: unknown }> = {};
const tx = (name: string, hash: string) => {
  run.txs[name] = hash;
  log(`  tx ${name}`, txLink(hash));
};
async function recordOutcome(hash: string, sender: string) {
  // Recorded through core's Rpc so tests can replay them with fixtureTransport.
  const r = new Rpc({ network: "testnet", transport: recordingTransport(outcomes) });
  await r.call("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
}

async function main() {
  const master = account(cfg.master);
  const relayer = account(RELAYER);
  log("network testnet; user", USER);
  log("relayer", `${RELAYER} balance ${yoctoToNear(await balance(RELAYER))} NEAR`);

  // 1. The venue is real and its withdraw demands exactly 1 yoctoNEAR.
  const wrapView = await provider.viewAccount({ accountId: WRAP });
  log(`${WRAP} exists, code_hash ${wrapView.code_hash}`);
  const probe = await probeDeposit(rpc(), WRAP, "near_withdraw", { amount: "1" });
  log("probeDeposit near_withdraw", probe);
  assert(probe.need === "one-yocto", `${WRAP} near_withdraw needs exactly 1 yoctoNEAR (so an fc key cannot call it)`);
  run.probe = probe;

  // 2. Fresh, independent user funded with 0.5 NEAR.
  const userKey = KeyPair.fromRandom("ed25519");
  const created = await master.createSubAccount({ accountOrPrefix: USER, publicKey: userKey.getPublicKey(), nearToTransfer: NEAR(0.5) });
  saveKey(USER, userKey); // ~/.near-credentials/testnet, outside the repo, so a crashed run can be cleaned up
  tx("create_user", created.transaction.hash);
  await until("user account", () => balance(USER).catch(() => 0n), (b) => b > 0n);
  const user = account(USER);
  try {
    await delegateFlow(user, relayer);
    await fcKeyFlow(user);
  } finally {
    await cleanup(user);
  }
  run.finished_at = new Date().toISOString();
  run.outcomes = outcomes;
  fs.writeFileSync(OUT, JSON.stringify(run, null, 1) + "\n");
  log("wrote", path.relative(ROOT, OUT));
}

async function delegateFlow(user: Account, relayer: Account) {
  log("— delegate mode —");
  const bounds = await view<{ min: string }>(WRAP, "storage_balance_bounds");
  tx("storage_deposit", (await user.callFunctionRaw({ contractId: WRAP, methodName: "storage_deposit", args: { account_id: USER, registration_only: true }, deposit: BigInt(bounds.min), gas: TGAS(30) })).transaction.hash);
  tx("near_deposit", (await user.callFunctionRaw({ contractId: WRAP, methodName: "near_deposit", args: {}, deposit: NEAR(0.1), gas: TGAS(30) })).transaction.hash);
  const deposited = await until("wNEAR balance", () => wnear(USER), (b) => b > 0n);
  log("user wNEAR balance", deposited.toString());

  const hatch = await armDelegateHatch({ owner: user, provider, venue: WRAP, method: "near_withdraw", args: { amount: deposited.toString() }, deposit: "1", trigger: "manual" });
  log("armed delegate hatch", { id: hatch.id, public_key: hatch.public_key, nonce: hatch.nonce, max_block_height: hatch.max_block_height });
  run.hatch = hatch;
  const v = verifyHatch(hatch);
  for (const c of v.checks) log("  verify", c);
  assert(v.ok, "verifyHatch ok");
  const d = decodeHatch(hatch);
  log("decoded", { senderId: d.senderId, receiverId: d.receiverId, actions: d.actions, nonce: d.nonce.toString(), maxBlockHeight: d.maxBlockHeight.toString() });
  const armed = await health(hatch, "ARMED");
  log("hatchHealth", armed);
  assert(armed.state === "ARMED", `hatchHealth ARMED with ${armed.blocks_left} blocks left`);
  run.health_armed = armed;

  const nearBefore = await balance(USER);
  const relayerBefore = await balance(RELAYER);
  const fired = await fireHatch(hatch, relayer);
  log("fireHatch", fired);
  tx("fire_delegate", fired.tx);
  assert(fired.ok, "fireHatch ok (inner near_withdraw succeeded)");
  await recordOutcome(fired.tx, RELAYER);

  const after = await until("wNEAR 0", () => wnear(USER), (b) => b === 0n);
  assert(after === 0n, "user wNEAR balance is 0");
  const nearAfter = await until("NEAR credited", () => balance(USER), (b) => b > nearBefore);
  const gain = nearAfter - nearBefore;
  log("user NEAR", `${nearBefore} -> ${nearAfter} (+${gain} yocto = +${yoctoToNear(gain)} NEAR)`);
  // wrap.testnet's near_withdraw transfers amount + 1: it refunds the 1 yocto deposit, which the relayer
  // paid (seen in run 1: Transfer receipt of 100000000000000000000001 for a 0.1 NEAR withdraw).
  assert(gain === deposited || gain === deposited + 1n, `user NEAR rose by the withdrawn ${deposited} yocto (+${gain - deposited} refunded deposit); the user paid no gas`);
  const relayerCost = relayerBefore - (await balance(RELAYER));
  log("relayer paid", `${relayerCost} yocto (${yoctoToNear(relayerCost)} NEAR) for gas + 1 yocto deposit`);
  run.user_gain_yocto = gain.toString();
  run.relayer_cost_yocto = relayerCost.toString();

  const used = await health(hatch, "USED");
  log("hatchHealth", used);
  assert(used.state === "USED", "hatchHealth USED after firing");
  run.health_used = used;

  // A hatch is one-shot: the chain rejects a replay (delegate nonce already spent).
  const replay = await fireHatch(hatch, relayer);
  log("replay fireHatch", replay);
  if (replay.tx) {
    tx("replay_delegate", replay.tx);
    await recordOutcome(replay.tx, RELAYER);
  }
  assert(!replay.ok, "replaying the same signed hatch fails");
  run.replay = replay;

  // Revocation is just deleting the dedicated key.
  tx("revoke_delegate_key", (await user.deleteKey(hatch.public_key)).transaction.hash);
  const revoked = await health(hatch, "REVOKED");
  assert(revoked.state === "REVOKED", "hatchHealth REVOKED after the owner deletes the key");
}

async function fcKeyFlow(user: Account) {
  log("— fc-key mode —");
  // wrap.testnet has no withdraw that takes 0 deposit; show it, then use a real staking pool whose
  // withdraw_all takes none.
  const wrapProbes: Record<string, unknown> = {};
  for (const [m, a] of [["near_withdraw", { amount: "1" }], ["ft_transfer", { receiver_id: WRAP, amount: "1" }], ["storage_withdraw", {}], ["storage_unregister", {}]] as const) {
    wrapProbes[m] = await probeDeposit(rpc(), WRAP, m, a);
    log(`  probe ${WRAP} ${m}`, wrapProbes[m]);
  }
  run.wrap_probes = wrapProbes;

  // (a) What an fc key does with a 1-yocto method: the hatch fires a 0-deposit call and the venue panics.
  const wrapFc = await armFunctionCallHatch({ owner: user, venue: WRAP, methods: ["near_withdraw"], method: "near_withdraw", args: { amount: "1" }, trigger: "manual" });
  run.fc_wrap_hatch = wrapFc.hatch;
  await health(wrapFc.hatch, "ARMED");
  const wrapFire = await fireFunctionCallHatch(wrapFc.hatch, wrapFc.keyPair, provider);
  log("fireFunctionCallHatch on wrap.testnet near_withdraw (0 deposit)", wrapFire);
  if (wrapFire.tx) {
    tx("fc_wrap_fire", wrapFire.tx);
    await recordOutcome(wrapFire.tx, USER);
  }
  assert(!wrapFire.ok && /1 yoctoNEAR/.test(wrapFire.error ?? ""), "fc-key call to a 1-yocto method fails inside the venue, and judgeOutcome sees it");
  run.fc_wrap_fire = wrapFire;
  // (b) And the protocol refuses a function-call key that tries to attach the deposit.
  try {
    const raw = new Account(USER, provider, new KeyPairSigner(wrapFc.keyPair));
    await raw.signAndSendTransaction({ receiverId: WRAP, actions: [actions.functionCall("near_withdraw", { amount: "1" }, TGAS(30), 1n)] });
    throw new Error("an fc key attached a deposit: unexpected");
  } catch (e) {
    const msg = (e as Error).message;
    log("fc key + 1 yocto deposit rejected", msg.slice(0, 200));
    assert(/deposit/i.test(msg) && !/unexpected/.test(msg), "RPC rejects a function-call-key tx that attaches 1 yoctoNEAR");
    run.fc_deposit_rejected = msg.slice(0, 300);
  }
  tx("delete_fc_wrap_key", (await user.deleteKey(wrapFc.hatch.public_key)).transaction.hash);

  // (c) A venue whose exit takes no deposit: core staking pool withdraw_all of unstaked balance.
  const poolProbe = await probeDeposit(rpc(), POOL, "withdraw_all", {});
  log(`probe ${POOL} withdraw_all`, poolProbe);
  run.pool_probe = poolProbe;
  tx("pool_deposit", (await user.callFunctionRaw({ contractId: POOL, methodName: "deposit", args: {}, deposit: NEAR(0.1), gas: TGAS(50) })).transaction.hash);
  const acct = await until("pool balance", () => view<any>(POOL, "get_account", { account_id: USER }), (a) => BigInt(a.unstaked_balance) > 0n);
  log("pool account", acct);
  const fc = await armFunctionCallHatch({ owner: user, venue: POOL, methods: ["withdraw_all"], method: "withdraw_all", args: {}, trigger: "manual" });
  run.fc_hatch = fc.hatch;
  log("armed fc-key hatch", { id: fc.hatch.id, public_key: fc.hatch.public_key });
  const v = verifyHatch(fc.hatch);
  for (const c of v.checks) log("  verify", c);
  const armed = await health(fc.hatch, "ARMED");
  log("hatchHealth", armed);
  run.fc_health_armed = armed;
  const before = await balance(USER);
  const fired = await fireFunctionCallHatch(fc.hatch, fc.keyPair, provider);
  log("fireFunctionCallHatch", fired);
  tx("fc_pool_fire", fired.tx);
  assert(fired.ok, "fc-key hatch withdraw_all succeeded");
  await recordOutcome(fired.tx, USER);
  const left = await until("pool withdrawn", () => view<any>(POOL, "get_account", { account_id: USER }), (a) => BigInt(a.unstaked_balance) === 0n);
  assert(BigInt(left.unstaked_balance) === 0n, "pool unstaked balance is 0");
  const after = await until("NEAR credited", () => balance(USER), (b) => b > before);
  log("user NEAR", `${before} -> ${after} (+${after - before} yocto; the user's balance paid this call's gas)`);
  run.fc_user_gain_yocto = (after - before).toString();
  tx("delete_fc_pool_key", (await user.deleteKey(fc.hatch.public_key)).transaction.hash);
}

async function cleanup(user: Account) {
  log("— cleanup —");
  if (process.env.KH_KEEP) return log("KH_KEEP set: leaving", USER);
  try {
    const w = await wnear(USER).catch(() => 0n);
    if (w > 0n) tx("cleanup_withdraw", (await user.callFunctionRaw({ contractId: WRAP, methodName: "near_withdraw", args: { amount: w.toString() }, deposit: 1n, gas: TGAS(30) })).transaction.hash);
    const pa = await view<any>(POOL, "get_account", { account_id: USER }).catch(() => null);
    if (pa && BigInt(pa.unstaked_balance) > 0n) tx("cleanup_pool", (await user.callFunctionRaw({ contractId: POOL, methodName: "withdraw_all", args: {}, gas: TGAS(50) })).transaction.hash);
    const reg = await view<unknown>(WRAP, "storage_balance_of", { account_id: USER }).catch(() => null);
    if (reg) tx("storage_unregister", (await user.callFunctionRaw({ contractId: WRAP, methodName: "storage_unregister", args: { force: false }, deposit: 1n, gas: TGAS(30) })).transaction.hash);
  } catch (e) {
    log("cleanup step failed (continuing to delete)", (e as Error).message.slice(0, 200));
  }
  const res = await user.deleteAccount(cfg.master);
  tx("delete_user", res.transaction.hash);
  fs.rmSync(credentialPath(USER), { force: true }); // the account is gone; so is any use for its key
  log("deleted", `${USER}, beneficiary ${cfg.master}`);
}

main().catch((e) => {
  console.error(e);
  run.error = String(e?.message ?? e);
  run.outcomes = outcomes;
  const failed = path.join(os.tmpdir(), `hatch-live-${Date.now()}.failed.json`); // never into the repo
  fs.writeFileSync(failed, JSON.stringify(run, null, 1) + "\n");
  console.error("partial run written to", failed);
  process.exit(1);
});
