// npm run setup:testnet — idempotent. Creates registry.<master>, watcher.<master> (attester),
// deploys and initialises the Keyhole registry, and registers the watcher as an attester.
// Needs the master account key (keyhole.testnet by default). Testnet only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { codeHash } from "../packages/core/src/hash.ts";
import { account, accountExists, cfg, hasKey, log, NEAR, provider, saveKey, TGAS, view } from "./lib/near.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = account(cfg.master);

async function ensureSub(id: string, near: number) {
  if (await accountExists(id)) return log("exists", id);
  const kp = KeyPair.fromRandom("ed25519");
  await master.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: NEAR(near) });
  saveKey(id, kp);
  log("created", `${id} with ${near} NEAR`);
}

await ensureSub(cfg.registry, 3.5);
await ensureSub(cfg.attester, 1.5);

const wasm = new Uint8Array(fs.readFileSync(path.join(ROOT, process.env.KH_REGISTRY_WASM ?? "contracts/out/registry.wasm")));
const want = await codeHash(wasm);
const have = (await provider.viewAccount({ accountId: cfg.registry })).code_hash;
const reg = account(cfg.registry);
if (have !== want) {
  if (!hasKey(cfg.registry)) throw new Error(`registry code differs (${have} vs ${want}) and no key for ${cfg.registry}`);
  await reg.deployContract(wasm);
  log("deployed registry", want);
} else log("registry code current", want);

let owner: string | null = null;
try {
  owner = await view<string>(cfg.registry, "get_owner");
} catch {
  /* not initialised */
}
if (!owner) {
  await reg.callFunction({ contractId: cfg.registry, methodName: "new", args: { owner_id: cfg.master }, gas: TGAS(30) });
  log("initialised", `owner ${cfg.master}`);
} else log("owner", owner);

const attesters = await view<string[]>(cfg.registry, "get_attesters");
if (!attesters.includes(cfg.attester)) {
  await master.callFunction({ contractId: cfg.registry, methodName: "add_attester", args: { account_id: cfg.attester }, gas: TGAS(30) });
  log("attester added", cfg.attester);
} else log("attester", cfg.attester);
log("stats", await view(cfg.registry, "get_stats"));
