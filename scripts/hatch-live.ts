// npm run hatch:live — live testnet proof of a delegate-mode hatch against a real NEP-141 venue,
// wrap.testnet, whose near_withdraw requires exactly 1 yoctoNEAR (so a function-call key cannot
// call it). A fresh user wraps 0.1 NEAR, arms a hatch for near_withdraw, and the guardian relayer
// (a different account, which never holds the user's keys) fires it. Testnet only.
import { KeyPair } from "near-api-js";
import { Rpc } from "../packages/core/src/index.ts";
import { armDelegateHatch, decodeHatch, fireHatch, hatchHealth, probeDeposit, verifyHatch } from "../packages/hatch/src/index.ts";
import { account, cfg, log, NEAR, provider, saveKey, TGAS, txLink, view, yoctoToNear } from "./lib/near.ts";

const VENUE = "wrap.testnet";
const rpc = () => new Rpc({ network: "testnet" }); // fresh client per read: no cached answers
const master = account(cfg.master);
const userId = `hl-${Date.now().toString(36)}.${cfg.master}`;
const kp = KeyPair.fromRandom("ed25519");
await master.createSubAccount({ accountOrPrefix: userId, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(0.6) });
saveKey(userId, kp);
const user = account(userId);
log("user", `${userId} (0.6 NEAR)`);

const probe = await probeDeposit(rpc(), VENUE, "near_withdraw", { amount: "1" });
log("probe", `${VENUE}.near_withdraw: ${probe.need} (${probe.detail})`);

await user.callFunction({ contractId: VENUE, methodName: "storage_deposit", args: {}, deposit: NEAR(0.00125), gas: TGAS(30) });
await user.callFunction({ contractId: VENUE, methodName: "near_deposit", args: {}, deposit: NEAR(0.1), gas: TGAS(30) });
const wnear = await view<string>(VENUE, "ft_balance_of", { account_id: userId });
log("wrapped", `${yoctoToNear(wnear)} wNEAR`);

const hatch = await armDelegateHatch({ owner: user, provider, venue: VENUE, method: "near_withdraw", args: { amount: wnear }, deposit: "1", gas: TGAS(30).toString(), ttlBlocks: 3600, trigger: "manual" });
const d = decodeHatch(hatch);
log("armed", `${hatch.id}: ${d.senderId} → ${d.receiverId}.${d.actions[0].method}(${JSON.stringify(d.actions[0].args)}) deposit ${d.actions[0].deposit} yocto, nonce ${d.nonce}, valid to block ${d.maxBlockHeight}`);
const v = verifyHatch(hatch);
log("verify", `${v.ok ? "ok" : "FAILED"}: ${v.checks.join("; ")}`);
log("health", (await hatchHealth(rpc(), hatch)).state);

const nearBefore = BigInt((await provider.viewAccount({ accountId: userId })).amount);
const relayerBefore = BigInt((await provider.viewAccount({ accountId: cfg.guardian })).amount);
const fired = await fireHatch(hatch, account(cfg.guardian));
log("fired", `${fired.ok ? "ok" : "FAILED " + fired.error} by ${cfg.guardian}: ${fired.tx ? txLink(fired.tx) : ""}`);
await new Promise((r) => setTimeout(r, 3000));
const wnearAfter = await view<string>(VENUE, "ft_balance_of", { account_id: userId });
const nearAfter = BigInt((await provider.viewAccount({ accountId: userId })).amount);
const relayerAfter = BigInt((await provider.viewAccount({ accountId: cfg.guardian })).amount);
log("result", `wNEAR ${yoctoToNear(wnear)} → ${yoctoToNear(wnearAfter)}; user NEAR +${yoctoToNear(nearAfter - nearBefore)}; relayer paid ${yoctoToNear(relayerBefore - relayerAfter)} NEAR (gas + 1 yocto)`);
const health = await hatchHealth(rpc(), hatch);
log("health", `${health.state} (${health.reasons.join("; ")})`);
// A second submission of the same bytes must fail: the nonce is spent.
const again = await fireHatch(hatch, account(cfg.guardian));
log("replay", again.ok ? "UNEXPECTED: fired twice" : `refused as expected (${(again.error ?? "").slice(0, 110)})`);

const ok = v.ok && fired.ok && wnearAfter === "0" && nearAfter - nearBefore > NEAR(0.099) && health.state === "USED" && !again.ok && probe.need === "one-yocto";
await user.deleteAccount(cfg.master); // reclaim the test funds
log(ok ? "PASS" : "FAIL", `user account ${userId} deleted, funds returned to ${cfg.master}`);
process.exit(ok ? 0 : 1);
