// Testnet measurement behind @keyhole/hatch's FC_PREPAID_PRICE_FACTOR and DEFAULT_FC_ALLOWANCE: how much
// allowance a function-call-key transaction needs up front, and how much one call really consumes.
// Testnet only (scripts/lib/near.ts refuses any other network). Costs well under 0.01 NEAR of gas.
//
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/hatch-allowance.ts
//
// Flow: throwaway hatch-allow-<ts>.keyhole.testnet (0.3 NEAR) → fc key for wrap.testnet ft_balance_of
// with 0.25 NEAR allowance → one 100 Tgas call → allowance before/after; a second key with 0.005 NEAR
// allowance → 100 Tgas and 30 Tgas calls (the node reports the up-front cost when it refuses) → account
// deleted, beneficiary keyhole.testnet.
import fs from "node:fs";
import { Account, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { account, cfg, credentialPath, log, NEAR, provider, saveKey, TGAS, txLink } from "./lib/near.ts";

const SUB = `hatch-allow-${Date.now()}.${cfg.master}`;
const VENUE = "wrap.testnet";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const allowanceOf = async (pk: string): Promise<string> =>
  ((await provider.viewAccessKey({ accountId: SUB, publicKey: pk, finalityQuery: { finality: "final" } })) as any).permission.FunctionCall.allowance;
const call = (signer: KeyPair, tgas: number) =>
  new Account(SUB, provider, new KeyPairSigner(signer)).signAndSendTransaction({
    receiverId: VENUE,
    actions: [actions.functionCall("ft_balance_of", { account_id: SUB }, TGAS(tgas), 0n)],
    waitUntil: "FINAL",
  });

async function main() {
  const key = KeyPair.fromRandom("ed25519");
  const created = await account(cfg.master).createSubAccount({ accountOrPrefix: SUB, publicKey: key.getPublicKey(), nearToTransfer: NEAR(0.3) });
  saveKey(SUB, key); // outside the repo, so a crashed run can be cleaned up
  log("create", txLink(created.transaction.hash));
  await sleep(3000);
  const sub = account(SUB);
  try {
    const gasPrice = (await provider.viewBlock({ finality: "final" })).header.gas_price;
    log("gas_price", gasPrice);

    const big = KeyPair.fromRandom("ed25519");
    await sub.addFunctionCallAccessKey({ publicKey: big.getPublicKey(), contractId: VENUE, methodNames: ["ft_balance_of"], allowance: NEAR(0.25) });
    await sleep(3000);
    const before = await allowanceOf(big.getPublicKey().toString());
    const r: any = await call(big, 100);
    await sleep(3000);
    const after = await allowanceOf(big.getPublicKey().toString());
    log("100 Tgas call", { tx: txLink(r.transaction_outcome.id), allowance_before: before, allowance_after: after, used: (BigInt(before) - BigInt(after)).toString() });

    const small = KeyPair.fromRandom("ed25519");
    await sub.addFunctionCallAccessKey({ publicKey: small.getPublicKey(), contractId: VENUE, methodNames: ["ft_balance_of"], allowance: 5_000_000_000_000_000_000_000n });
    await sleep(3000);
    for (const tgas of [100, 30]) {
      try {
        const ok: any = await call(small, tgas);
        log(`${tgas} Tgas with 0.005 NEAR allowance: landed`, txLink(ok.transaction_outcome.id));
      } catch (e) {
        log(`${tgas} Tgas with 0.005 NEAR allowance: refused`, (e as Error).message.slice(0, 300));
      }
    }
  } finally {
    const d = await sub.deleteAccount(cfg.master);
    log("delete", txLink(d.transaction.hash));
    fs.rmSync(credentialPath(SUB), { force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
