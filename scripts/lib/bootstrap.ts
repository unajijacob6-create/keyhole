// Zero-key bootstrap for `npm run demo:attack` on a fresh clone. If no key for the master account
// is available, create a new testnet account through the public faucet helper, then deploy a
// private copy of the Keyhole registry (the reproducible CI build in contracts/repro), register a
// watcher attester, and relay the CI build attestation for demo-vault-v1. Testnet only.
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { account, accountExists, cfg, hasKey, log, NEAR, saveKey, TGAS, view } from "./near.ts";

export async function ensureDemoAccounts(root: string): Promise<{ fresh: boolean }> {
  if (hasKey(cfg.master)) return { fresh: false };
  const id = `kh-demo-${Math.random().toString(36).slice(2, 8)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`testnet faucet refused to create ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  saveKey(id, kp);
  process.env.KH_MASTER = id;
  log("created", `${id} from the testnet faucet (key saved in ~/.near-credentials/testnet/)`);
  for (let i = 0; i < 30 && !(await accountExists(id)); i++) await new Promise((res) => setTimeout(res, 1000));
  const master = account(id);
  for (const [sub, near] of [[cfg.registry, 2.7], [cfg.attester, 0.6]] as const) {
    const k = KeyPair.fromRandom("ed25519");
    await master.createSubAccount({ accountOrPrefix: sub, publicKey: k.getPublicKey(), nearToTransfer: NEAR(near) });
    saveKey(sub, k);
  }
  await account(cfg.registry).deployContract(new Uint8Array(fs.readFileSync(path.join(root, "contracts/repro/keyhole_registry.wasm"))));
  await account(cfg.registry).callFunction({ contractId: cfg.registry, methodName: "new", args: { owner_id: id }, gas: TGAS(30) });
  await master.callFunction({ contractId: cfg.registry, methodName: "add_attester", args: { account_id: cfg.attester }, gas: TGAS(30) });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "contracts/repro/manifest.json"), "utf8"));
  const v1 = manifest.wasm["demo_vault_v1.wasm"];
  await account(cfg.attester).callFunction({
    contractId: cfg.registry,
    methodName: "attest",
    args: { code_hash: v1.code_hash, attestation: { kind: "ReproducibleBuild", account: null, repo: "https://github.com/unajijacob6-create/keyhole", rev: manifest.rev, image_digest: manifest.image.split("@")[1], matches: true } },
    gas: TGAS(30),
  });
  log("private registry ready", `${cfg.registry} (owner ${id}, attester ${cfg.attester}); v1 build attested from ${manifest.run}`);
  log("registry stats", await view(cfg.registry, "get_stats"));
  return { fresh: true };
}
