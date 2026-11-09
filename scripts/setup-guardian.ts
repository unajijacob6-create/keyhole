// npm run setup:guardian — idempotent, testnet only. Creates the accounts and the Sputnik DAO that
// the Keyhole Guardian demo uses:
//   council-a.<master>  council member who proposes the upgrade (the "rogue or compromised" member)
//   council-b.<master>  council member who approves it
//   alice.<master>      depositor who arms an escape hatch
//   bob.<master>        depositor who does not
//   guardian.<master>   relayer that submits pre-signed hatches (pays gas and the 1 yoctoNEAR)
//   <dao>               a Sputnik v2 DAO from the official factory (sputnikv2.testnet), council = A + B,
//                       default policy: 2 of 2 council approvals, 7-day proposal period.
// Needs the master account key (keyhole.testnet by default).
import { KeyPair } from "near-api-js";
import { account, accountExists, cfg, DAO_FACTORY, hasKey, log, NEAR, provider, saveKey, TGAS, view, yoctoToNear } from "./lib/near.ts";

const master = account(cfg.master);
const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);

async function ensureSub(id: string, near: number, minNear = near / 2) {
  if (await accountExists(id)) {
    if (!hasKey(id)) throw new Error(`${id} exists but its key is not in ~/.near-credentials/testnet`);
    const b = await balance(id);
    if (b < NEAR(minNear)) {
      await master.transfer({ receiverId: id, amount: NEAR(near) - b });
      log("topped up", `${id} to ${near} NEAR`);
    } else log("exists", `${id} (${yoctoToNear(b)} NEAR)`);
    return;
  }
  const kp = KeyPair.fromRandom("ed25519");
  await master.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(near) });
  saveKey(id, kp);
  log("created", `${id} with ${near} NEAR`);
}

await ensureSub(cfg.councilA, 3.5, 2.5); // proposal bond (1 NEAR, refunded) + store_blob storage (~1.2 NEAR, refundable)
await ensureSub(cfg.councilB, 0.5, 0.2);
await ensureSub(cfg.alice, 2.5, 1.5);
await ensureSub(cfg.bob, 1.5, 0.8);
await ensureSub(cfg.guardian, 1, 0.5);

if (await accountExists(cfg.dao)) {
  const policy = await view<any>(cfg.dao, "get_policy");
  const council = policy.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [];
  log("dao exists", `${cfg.dao} council=${JSON.stringify(council)} proposal_bond=${yoctoToNear(policy.proposal_bond)} period=${Number(BigInt(policy.proposal_period) / 3_600_000_000_000n)}h`);
  if (!council.includes(cfg.councilA) || !council.includes(cfg.councilB)) throw new Error(`${cfg.dao} council does not contain ${cfg.councilA} and ${cfg.councilB}`);
} else {
  const name = cfg.dao.slice(0, -(DAO_FACTORY.length + 1));
  // sputnikdao2 new(config, policy): VersionedPolicy::Default(council) is the factory's default policy.
  const args = { config: { name, purpose: "Keyhole Guardian demo: governs a testnet vault", metadata: "" }, policy: [cfg.councilA, cfg.councilB] };
  const out = await master.callFunction({
    contractId: DAO_FACTORY,
    methodName: "create",
    args: { name, args: Buffer.from(JSON.stringify(args)).toString("base64") },
    gas: TGAS(300),
    deposit: NEAR(6),
  });
  log("dao created", `${cfg.dao} (${JSON.stringify(out)})`);
  log("policy", await view(cfg.dao, "get_policy"));
}
