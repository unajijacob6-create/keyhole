// Shared test helpers: a fixed-seed key (so signatures are reproducible) and borsh tampering.
import { deserialize, serialize } from "borsh";
import { KeyPair, KeyPairEd25519, SCHEMA, type KeyPairString } from "near-api-js";
import { base58, base64ToBytes, bytesToBase64 } from "../../core/src/hash.ts";
import { requestKey } from "../../core/src/rpc.ts";
import { prepareDelegateHatch, type Hatch } from "../src/index.ts";

/** ed25519 key from a fixed 32-byte seed (near-api-js derives the public key from the first 32 bytes). */
export function seedKey(byte: number): KeyPair {
  const seed = new Uint8Array(32).fill(byte);
  const pub = new KeyPairEd25519(base58.encode(new Uint8Array([...seed, ...new Uint8Array(32)]))).getPublicKey().data;
  return KeyPair.fromString(`ed25519:${base58.encode(new Uint8Array([...seed, ...pub]))}` as KeyPairString);
}

export const KEY = seedKey(7);
export const OTHER_KEY = seedKey(9);
export const KEY_NONCE = 276948928000016n; // a real-looking nonce: (block height) * 1e6 + uses
export const HEAD = 276975000;
export const TTL = 1000;

export const baseOptions = {
  network: "testnet" as const,
  account: "alice.testnet",
  venue: "wrap.testnet",
  method: "near_withdraw",
  args: { amount: "100000000000000000000000" },
  deposit: "1",
  gas: "30000000000000",
  keyPair: KEY,
  keyNonce: KEY_NONCE,
  headHeight: HEAD,
  ttlBlocks: TTL,
  trigger: "stop" as const,
  now: new Date("2026-11-09T12:00:00.000Z"),
};
export const fixedHatch = () => prepareDelegateHatch(baseOptions);

/** Decode the signed delegate, let `edit` change it, re-encode (signature untouched). */
export function tamperPayload(h: Hatch, edit: (da: any) => void): string {
  const plain: any = deserialize(SCHEMA.SignedDelegate, base64ToBytes(h.signed_delegate!));
  edit(plain.delegateAction);
  return bytesToBase64(serialize(SCHEMA.SignedDelegate, plain));
}

export type Fixtures = Record<string, { result?: unknown; error?: unknown }>;
export const blockFixture = (height: number): Fixtures => ({ [requestKey("block", { finality: "final" })]: { result: { header: { height } } } });
export const keyFixture = (account: string, publicKey: string, answer: { result?: unknown; error?: unknown }): Fixtures => ({
  [requestKey("query", { request_type: "view_access_key", account_id: account, public_key: publicKey, finality: "final" })]: answer,
});
/** The shape testnet RPC really returns for a missing key (recorded 2026-11-09 against keyhole.testnet). */
export const missingKeyAnswer = (publicKey: string) => ({ error: { result_error: `access key ${publicKey} does not exist while viewing` } });
