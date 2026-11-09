// Testnet signing helpers (near-api-js v7). Pattern adapted from the same author's Standing Order
// repo (scripts/lib/near.ts). Keys are read from ~/.near-credentials/<network>/<account>.json or
// from KEY_<ACCOUNT_WITH_UNDERSCORES> env vars; they never enter the repository.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

export const NETWORK = (process.env.NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";
if (NETWORK !== "testnet") throw new Error("Keyhole scripts sign on testnet only");
export const RPC_URL = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC_URL });

export const cfg = {
  master: process.env.KH_MASTER ?? "keyhole.testnet",
  get registry() { return process.env.KH_REGISTRY ?? `registry.${this.master}`; },
  get attester() { return process.env.KH_ATTESTER ?? `watcher.${this.master}`; },
  get vault() { return process.env.KH_VAULT ?? `vault.${this.master}`; },
  get agent() { return process.env.KH_AGENT ?? `agent.${this.master}`; },
};

const credDir = path.join(os.homedir(), ".near-credentials", NETWORK);
export const credentialPath = (id: string) => path.join(credDir, `${id}.json`);

export function loadKey(accountId: string): KeyPairString {
  const envKey = process.env[`KEY_${accountId.replace(/[.-]/g, "_").toUpperCase()}`];
  if (envKey) return envKey as KeyPairString;
  const file = credentialPath(accountId);
  if (!fs.existsSync(file)) throw new Error(`No credentials for ${accountId} at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")).private_key as KeyPairString;
}
export const hasKey = (id: string) => Boolean(process.env[`KEY_${id.replace(/[.-]/g, "_").toUpperCase()}`]) || fs.existsSync(credentialPath(id));

export function saveKey(accountId: string, keyPair: KeyPair): void {
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(credentialPath(accountId), JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }, null, 2), { mode: 0o600 });
}

export const account = (id: string) => new Account(id, provider, loadKey(id));

export async function accountExists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id });
    return true;
  } catch {
    return false;
  }
}
export async function view<T = unknown>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as unknown as T;
}

export const TGAS = (n: number) => BigInt(n) * 1_000_000_000_000n;
export const NEAR = (n: number | string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
export const yoctoToNear = (y: bigint | string) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);
export const txLink = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

export function log(step: string, detail?: unknown): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${step}${detail !== undefined ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
}
