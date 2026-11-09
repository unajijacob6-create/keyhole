// @keyhole/hatch — an escape hatch a depositor arms in advance: a withdraw-to-self that someone else
// (the Keyhole guardian) can submit later, when it sees a dangerous upgrade of the venue coming.
//
// Two modes (docs/HATCH.md, docs/GUARDIAN_DESIGN.md):
//   delegate  A NEP-366 SignedDelegateAction signed by a dedicated full-access key whose secret is
//             dropped right after signing. It can carry the 1 yoctoNEAR most withdraw methods demand,
//             anyone can relay it (the relayer pays gas and the deposit), and nobody can change it:
//             the signature covers sender, receiver, actions, nonce, max_block_height and public key.
//   fc-key    A function-call access key limited to (venue, methods) that the guardian keeps. It can
//             fire more than once, but it can never attach a deposit (nearcore rejects a function-call
//             key transaction with a non-zero deposit: InvalidAccessKeyError::DepositWithFunctionCall).
//
// The worst a holder of a hatch can do is submit exactly the signed (or permitted) call, early or never.
// It cannot redirect funds: the withdraw pays `predecessor_account_id`, which is the depositor.
import { sha256 } from "@noble/hashes/sha2.js";
import { deserialize, serialize } from "borsh";
import {
  Account,
  KeyPair,
  KeyPairSigner,
  KeyType,
  PublicKey,
  SCHEMA,
  actions,
  buildDelegateAction,
  encodeSignedDelegate,
  type Provider,
  type SignedDelegate,
} from "near-api-js";
import { base64ToBytes, bytesToBase64 } from "../../core/src/hash.ts";
import { Rpc, RpcAnswerError, type Network } from "../../core/src/rpc.ts";

export type { Network } from "../../core/src/rpc.ts";

export interface Hatch {
  schema: "keyhole.hatch/1";
  id: string;
  network: Network;
  account: string;
  venue: string;
  method: string;
  args: Record<string, unknown>;
  deposit: string;
  gas: string;
  mode: "delegate" | "fc-key";
  /** The dedicated key: signs the delegate action (delegate) or is the guardian's key (fc-key). */
  public_key: string;
  nonce: string | null;
  max_block_height: string | null;
  /** base64 borsh SignedDelegate (delegate mode). */
  signed_delegate: string | null;
  created_at: string;
  created_height: number;
  trigger: "stop" | "any-upgrade" | "manual";
}
export type HatchTrigger = Hatch["trigger"];
export type HatchState = "ARMED" | "USED" | "REVOKED" | "EXPIRED" | "STALE";
export type DepositNeed = "one-yocto" | "none-before-state" | "inconclusive";

export const HATCH_SCHEMA = "keyhole.hatch/1" as const;
/** NEP-461 prefix for NEP-366 delegate actions: 2^30 + 366, borsh u32 little-endian (bytes 6e 01 00 40). */
export const NEP461_DELEGATE_PREFIX = 2 ** 30 + 366;
/** 100 Tgas. Unused gas is refunded to whoever paid for it (the relayer in delegate mode). */
export const DEFAULT_GAS = "100000000000000";
/** near-sdk `assert_one_yocto()`: the deposit Ref `withdraw`, `wrap.near` `near_withdraw` and NEP-141
 *  `ft_transfer` demand (view-call probes in packages/hatch/test/fixtures/probe-mainnet.json). */
export const DEFAULT_DEPOSIT = "1";
/** About 30 days: 4,500,000 blocks x 0.578 s, the mainnet average over blocks 222,823,162-223,823,162
 *  (measured 2026-11-09; testnet was 0.593 s over its last 1,000,000 blocks). The protocol sets no cap. */
export const DEFAULT_TTL_BLOCKS = 4_500_000;
/** Allowance for an fc-key hatch: caps what the guardian could burn on gas from the user's balance.
 *  Measured by scripts/hatch-allowance.ts on testnet 2026-11-09 (gas_price 100,000,000 yocto/gas; docs/HATCH.md
 *  "fc-key allowance"): a 100 Tgas call is only accepted
 *  while the allowance covers ~0.1009 NEAR up front (refused at 0.005 NEAR with "cost:
 *  100919362755690500000000"), and after it ran the allowance was down by only the gas burnt
 *  (156716395580200000000 yocto for a ft_balance_of call). 0.25 NEAR clears the up-front check for one
 *  100 Tgas call with room for many such calls; it does not mean "25 calls". */
export const DEFAULT_FC_ALLOWANCE = "250000000000000000000000";
/** The up-front allowance a function-call-key transaction needs, per gas unit at the current gas price.
 *  Testnet (protocol 88) charged prepaid gas at 10x gas_price on 2026-11-09: 30 Tgas cost
 *  30919362755690500000000 and 100 Tgas 100919362755690500000000 at gas_price 1e8, i.e. 1e9 per prepaid
 *  gas plus ~0.00092 NEAR of fees. Why 10x is not visible in EXPERIMENTAL_protocol_config
 *  (pessimistic_gas_price_inflation_ratio was [1,1]); this is a measured factor, not a protocol constant. */
export const FC_PREPAID_PRICE_FACTOR = 10n;
/** The ~0.00092 NEAR of fees above, expressed in gas at the 10x price, rounded up to 1 Tgas. */
const FC_FEE_GAS = 1_000_000_000_000n;
/** Estimated up-front allowance one fc-key call with `gas` needs (see FC_PREPAID_PRICE_FACTOR). */
export function fcAllowanceNeeded(gas: string | bigint, gasPrice: string | bigint): bigint {
  return (BigInt(gas) + FC_FEE_GAS) * BigInt(gasPrice) * FC_PREPAID_PRICE_FACTOR;
}
/**
 * Fewest blocks between the final head and max_block_height that a delegate action fired now can still
 * land in. nearcore checks max_block_height against the block where the delegate *receipt* is applied:
 * the final head trails the tip (2 to 4 blocks in three samples on testnet, 2026-11-09), the relayer's
 * transaction lands in a later block, and its receipt to the user runs at least one block after that
 * (live run: tx in block 276977260, delegate receipt in 276977261). 2 + 1 + 1 = 4 is a lower bound; a
 * guardian should not wait for it.
 */
export const MIN_LANDING_BLOCKS = 4;

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const DECIMAL = /^(0|[1-9]\d*)$/;

/** JSON with sorted keys, so two records that mean the same thing compare (and hash) the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Stable id: hash of everything that defines what the hatch does (not when it was made). */
export function hatchId(h: Omit<Hatch, "id" | "created_at" | "created_height" | "trigger"> & Partial<Hatch>): string {
  const core = [h.schema, h.network, h.account, h.venue, h.method, h.args, h.deposit, h.gas, h.mode, h.public_key, h.nonce, h.max_block_height, h.signed_delegate];
  return hex(sha256(utf8(canonicalJson(core)))).slice(0, 16);
}
/** Puts `id` right after `schema` so stored records read top-down. */
function withId(body: Omit<Hatch, "id">): Hatch {
  const { schema, ...rest } = body;
  return { schema, id: hatchId(body), ...rest };
}

function amount(name: string, v: string | bigint | number | undefined, dflt: string): string {
  const s = v === undefined ? dflt : String(v);
  if (!DECIMAL.test(s)) throw new Error(`${name} must be a non-negative integer (got ${s})`);
  return s;
}
function requireArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be a JSON object");
  return args as Record<string, unknown>;
}
function networkOf(id: string): Network {
  if (id === "mainnet" || id === "testnet") return id;
  throw new Error(`unsupported network ${id}`);
}

// ---------------------------------------------------------------------------------------------------
// Delegate mode: prepare (pure), arm (on chain), decode, verify
// ---------------------------------------------------------------------------------------------------

export interface PrepareDelegateOptions {
  network: Network;
  account: string;
  venue: string;
  method: string;
  args: Record<string, unknown>;
  deposit: string | bigint;
  gas: string | bigint;
  /** The dedicated key. Must already be a full-access key of `account` when the hatch is fired. */
  keyPair: KeyPair;
  /** That key's current on-chain nonce; the hatch uses keyNonce + 1. */
  keyNonce: bigint;
  headHeight: number;
  ttlBlocks: number;
  trigger: HatchTrigger;
  now?: Date;
}

/** Signs the withdraw as a NEP-366 delegate action. Pure and offline: no RPC, no disk. */
export async function prepareDelegateHatch(o: PrepareDelegateOptions): Promise<Hatch> {
  const args = requireArgs(o.args);
  const deposit = amount("deposit", o.deposit, DEFAULT_DEPOSIT);
  const gas = amount("gas", o.gas, DEFAULT_GAS);
  if (!o.account || !o.venue || !o.method) throw new Error("account, venue and method are required");
  if (!Number.isSafeInteger(o.headHeight) || o.headHeight < 0) throw new Error("headHeight must be a block height");
  if (!Number.isSafeInteger(o.ttlBlocks) || o.ttlBlocks <= 0) throw new Error("ttlBlocks must be a positive integer");
  if (typeof o.keyNonce !== "bigint" || o.keyNonce < 0n) throw new Error("keyNonce must be a bigint");
  const nonce = o.keyNonce + 1n;
  const maxBlockHeight = BigInt(o.headHeight) + BigInt(o.ttlBlocks);
  const publicKey = o.keyPair.getPublicKey();
  const delegateAction = buildDelegateAction({
    senderId: o.account,
    receiverId: o.venue,
    // Args are passed as bytes so what is signed is exactly JSON.stringify(args), nothing re-encoded later.
    actions: [actions.functionCall(o.method, utf8(JSON.stringify(args)), BigInt(gas), BigInt(deposit))],
    nonce,
    maxBlockHeight,
    publicKey,
  });
  const { signedDelegate } = await new KeyPairSigner(o.keyPair).signDelegateAction(delegateAction);
  const body: Omit<Hatch, "id"> = {
    schema: HATCH_SCHEMA,
    network: o.network,
    account: o.account,
    venue: o.venue,
    method: o.method,
    args,
    deposit,
    gas,
    mode: "delegate",
    public_key: publicKey.toString(),
    nonce: nonce.toString(),
    max_block_height: maxBlockHeight.toString(),
    signed_delegate: bytesToBase64(encodeSignedDelegate(signedDelegate)),
    created_at: (o.now ?? new Date()).toISOString(),
    created_height: o.headHeight,
    trigger: o.trigger,
  };
  return withId(body);
}

export interface ArmDelegateOptions {
  owner: Account;
  provider: Provider;
  venue: string;
  method: string;
  args: Record<string, unknown>;
  deposit?: string | bigint;
  gas?: string | bigint;
  ttlBlocks?: number;
  trigger?: HatchTrigger;
}

/**
 * Generates a fresh ed25519 key, has `owner` add it as a FULL ACCESS key (a delegate action carrying a
 * deposit must be signed by one), reads its nonce, signs the hatch and lets the secret go.
 *
 * The secret is never written anywhere: not to disk, not into the record, not to a log. After signing,
 * every reference to the KeyPair is dropped so it can be garbage-collected. JavaScript cannot zero
 * memory (the key lives in immutable strings and buffers we do not own), so "dropped" means
 * unreachable, not wiped. Anyone who can read this process's memory before GC could recover it.
 */
export async function armDelegateHatch(o: ArmDelegateOptions): Promise<Hatch> {
  const network = networkOf(await o.provider.getNetworkId());
  let keyPair: KeyPair | null = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey();
  try {
    // Inside the try: an add that reports an error (a timeout, say) may still land, and then the key
    // would be a full-access key nobody holds a hatch for.
    await o.owner.addFullAccessKey(publicKey);
    const keyNonce = await waitForKeyNonce(o.provider, o.owner.accountId, publicKey.toString());
    const head = (await o.provider.viewBlock({ finality: "final" })).header.height;
    return await prepareDelegateHatch({
      network,
      account: o.owner.accountId,
      venue: o.venue,
      method: o.method,
      args: o.args,
      deposit: o.deposit ?? DEFAULT_DEPOSIT,
      gas: o.gas ?? DEFAULT_GAS,
      keyPair,
      keyNonce,
      headHeight: head,
      ttlBlocks: o.ttlBlocks ?? DEFAULT_TTL_BLOCKS,
      trigger: o.trigger ?? "stop",
    });
  } catch (e) {
    // A full-access key nobody holds a hatch for is pure risk: take it off again (a no-op error if
    // the add never landed).
    await o.owner.deleteKey(publicKey).catch(() => {});
    throw e;
  } finally {
    keyPair = null;
  }
}

async function waitForKeyNonce(provider: Provider, accountId: string, publicKey: string, tries = 30): Promise<bigint> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const k = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } });
      return BigInt(k.nonce);
    } catch (e) {
      last = e; // not final yet
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`key ${publicKey} did not appear on ${accountId}: ${(last as Error)?.message ?? last}`);
}

interface DecodedDelegate {
  plain: any; // borsh-decoded SignedDelegate (plain objects, bigints)
  delegateBytes: Uint8Array; // borsh(DelegateAction), without prefix
  signature: Uint8Array;
  publicKey: PublicKey;
}

const KEY_TYPES: Record<string, KeyType> = { ed25519Key: KeyType.ED25519, secp256k1Key: KeyType.SECP256K1, mlDsa65Key: KeyType.MLDSA65 };

function decodeSigned(b64: string): DecodedDelegate {
  const bytes = base64ToBytes(b64);
  const plain: any = deserialize(SCHEMA.SignedDelegate, bytes);
  // Canonical round trip: rejects trailing bytes and any encoding borsh would not produce itself,
  // so the bytes a relayer submits are exactly the bytes we checked.
  const again = serialize(SCHEMA.SignedDelegate, plain);
  if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i])) throw new Error("signed_delegate is not canonical borsh");
  const pkKind = Object.keys(plain.delegateAction.publicKey)[0];
  const publicKey = new PublicKey({ keyType: KEY_TYPES[pkKind], data: Uint8Array.from(plain.delegateAction.publicKey[pkKind].data) });
  const sigKind = Object.keys(plain.signature)[0];
  return {
    plain,
    delegateBytes: serialize(SCHEMA.DelegateAction, plain.delegateAction),
    signature: Uint8Array.from(plain.signature[sigKind].data),
    publicKey,
  };
}

/** The NEP-461 message a delegate action's signature covers: sha256(u32le(2^30 + 366) ++ borsh(DelegateAction)). */
export function delegateSigningHash(delegateBytes: Uint8Array): Uint8Array {
  const msg = new Uint8Array(4 + delegateBytes.length);
  new DataView(msg.buffer).setUint32(0, NEP461_DELEGATE_PREFIX, true);
  msg.set(delegateBytes, 4);
  return sha256(msg);
}

function parseArgs(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { base64: bytesToBase64(bytes) };
  }
}

export interface DecodedAction {
  /** borsh Action variant: "functionCall" for every hatch Keyhole makes. */
  kind: string;
  method: string;
  args: unknown;
  deposit: string;
  gas: string;
}

/** What the signed bytes actually say (not what the record claims). */
export function decodeHatch(h: Hatch): { senderId: string; receiverId: string; actions: DecodedAction[]; nonce: bigint; maxBlockHeight: bigint; publicKey: string } {
  if (!h.signed_delegate) throw new Error(`hatch ${h.id} (${h.mode}) carries no signed delegate action`);
  const { plain, publicKey } = decodeSigned(h.signed_delegate);
  const da = plain.delegateAction;
  return {
    senderId: da.senderId,
    receiverId: da.receiverId,
    actions: da.actions.map((a: any): DecodedAction => {
      const kind = Object.keys(a)[0];
      if (kind === "functionCall") {
        const fc = a.functionCall;
        return { kind, method: fc.methodName, args: parseArgs(Uint8Array.from(fc.args)), deposit: String(fc.deposit), gas: String(fc.gas) };
      }
      const v = a[kind] ?? {};
      return { kind, method: "", args: null, deposit: String(v.deposit ?? v.stake ?? 0), gas: "0" };
    }),
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    publicKey: publicKey.toString(),
  };
}

/** Offline check: the signature is valid over the NEP-461 hash, and every record field matches the signed bytes. */
export function verifyHatch(h: Hatch): { ok: boolean; checks: string[] } {
  const checks: string[] = [];
  let ok = true;
  const check = (cond: boolean, pass: string, fail: string) => {
    checks.push(cond ? `ok: ${pass}` : `FAIL: ${fail}`);
    if (!cond) ok = false;
  };
  check(h.schema === HATCH_SCHEMA, `schema ${HATCH_SCHEMA}`, `schema is ${h.schema}, expected ${HATCH_SCHEMA}`);
  let pk: PublicKey | null = null;
  try {
    pk = PublicKey.fromString(h.public_key);
  } catch {
    /* reported below */
  }
  check(pk !== null, `public key ${h.public_key} parses`, `public key ${h.public_key} does not parse`);

  if (h.mode === "fc-key") {
    check(h.signed_delegate === null && h.nonce === null && h.max_block_height === null, "fc-key record carries no signed payload", "fc-key record carries delegate fields");
    check(h.deposit === "0", "deposit 0 (a function-call key cannot attach a deposit)", `deposit ${h.deposit}: a function-call key cannot attach a deposit`);
    // Nothing is signed, so the id is the only thing that ties the stored call (method, args, venue)
    // to what was armed.
    check(h.id === hatchId(h), `id ${h.id}`, `id ${h.id} != ${hatchId(h)} (record edited after arming)`);
    checks.push("info: an fc-key hatch's power is the key's on-chain permission; hatchHealth checks it");
    return { ok, checks };
  }
  if (h.mode !== "delegate" || !h.signed_delegate) {
    check(false, "", `mode ${h.mode} without a signed delegate action`);
    return { ok, checks };
  }
  let d: DecodedDelegate;
  try {
    d = decodeSigned(h.signed_delegate);
  } catch (e) {
    check(false, "", `signed_delegate does not decode: ${(e as Error).message}`);
    return { ok, checks };
  }
  const da = d.plain.delegateAction;
  const hash = delegateSigningHash(d.delegateBytes);
  let sigOk = false;
  try {
    sigOk = d.publicKey.verify(hash, d.signature);
  } catch {
    sigOk = false;
  }
  check(sigOk, `signature by ${d.publicKey.toString()} valid over NEP-461 hash ${hex(hash)}`, `signature does not verify over the NEP-461 hash (payload altered or signed by another key)`);
  check(d.publicKey.toString() === h.public_key, "signed public key matches record", `signed public key ${d.publicKey.toString()} != record ${h.public_key}`);
  check(da.senderId === h.account, `sender ${da.senderId}`, `signed sender ${da.senderId} != record account ${h.account}`);
  check(da.receiverId === h.venue, `receiver ${da.receiverId}`, `signed receiver ${da.receiverId} != record venue ${h.venue}`);
  check(String(da.nonce) === h.nonce, `nonce ${da.nonce}`, `signed nonce ${da.nonce} != record ${h.nonce}`);
  check(String(da.maxBlockHeight) === h.max_block_height, `max_block_height ${da.maxBlockHeight}`, `signed max_block_height ${da.maxBlockHeight} != record ${h.max_block_height}`);
  const acts: any[] = da.actions;
  const fc = acts.length === 1 && acts[0].functionCall ? acts[0].functionCall : null;
  check(fc !== null, "exactly one FunctionCall action", `expected exactly one FunctionCall action, found ${acts.map((a) => Object.keys(a)[0]).join(",") || "none"}`);
  if (fc) {
    check(fc.methodName === h.method, `method ${fc.methodName}`, `signed method ${fc.methodName} != record ${h.method}`);
    const signedArgs = parseArgs(Uint8Array.from(fc.args));
    check(canonicalJson(signedArgs) === canonicalJson(h.args), `args ${canonicalJson(signedArgs)}`, `signed args ${canonicalJson(signedArgs)} != record ${canonicalJson(h.args)}`);
    check(String(fc.deposit) === h.deposit, `deposit ${fc.deposit} yoctoNEAR`, `signed deposit ${fc.deposit} != record ${h.deposit}`);
    check(String(fc.gas) === h.gas, `gas ${fc.gas}`, `signed gas ${fc.gas} != record ${h.gas}`);
  }
  // Every field above is checked against the signed bytes, so the id is a label. Records armed before
  // ids covered the whole record used sha256(signed delegate) (the recorded Guardian run of
  // 2026-11-09 has one); that form is still accepted for delegate records.
  const legacy = h.signed_delegate ? hex(sha256(base64ToBytes(h.signed_delegate))).slice(0, 16) : null;
  check(h.id === hatchId(h) || h.id === legacy, h.id === legacy ? `id ${h.id} (earlier form: sha256 of the signed delegate)` : `id ${h.id}`, `id ${h.id} != ${hatchId(h)} (record edited after signing)`);
  return { ok, checks };
}

// ---------------------------------------------------------------------------------------------------
// Health: is the hatch still able to fire?
// ---------------------------------------------------------------------------------------------------

const KEY_GONE = /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/;

/**
 * Reads the dedicated key from chain and says whether the hatch can still fire.
 * Order: REVOKED (key gone) > STALE (key or record no longer fits) > USED (nonce spent) > EXPIRED > ARMED.
 * Rpc memoizes identical requests, so pass a fresh Rpc (or opts.headHeight) for each check.
 */
export async function hatchHealth(
  rpc: Rpc,
  h: Hatch,
  opts: { headHeight?: number } = {},
): Promise<{ state: HatchState; reasons: string[]; key_nonce: string | null; head: number; blocks_left: number | null }> {
  if (rpc.network !== h.network) throw new Error(`hatch is for ${h.network}, rpc is ${rpc.network}`);
  const head = opts.headHeight ?? (await rpc.block({ finality: "final" })).header.height;
  let key: { nonce: number | string; permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } } | null;
  try {
    key = await rpc.call("query", { request_type: "view_access_key", account_id: h.account, public_key: h.public_key, finality: "final" });
  } catch (e) {
    if (!(e instanceof RpcAnswerError) || !KEY_GONE.test(`${e.message} ${JSON.stringify(e.data)}`)) throw e;
    key = null;
  }
  const out = (state: HatchState, reasons: string[], blocks_left: number | null = null) => ({ state, reasons, key_nonce: key ? String(key.nonce) : null, head, blocks_left });
  if (!key) return out("REVOKED", [`key ${h.public_key} is not on ${h.account} (deleted, or the account is gone)`]);

  if (h.mode === "fc-key") {
    const perm = key.permission;
    if (perm === "FullAccess") return out("STALE", ["the guardian's key has FULL access; an fc-key hatch must be limited to the venue (revoke it)"]);
    const fc = perm.FunctionCall;
    if (fc.receiver_id !== h.venue) return out("STALE", [`key may only call ${fc.receiver_id}, not ${h.venue}`]);
    if (fc.method_names.length && !fc.method_names.includes(h.method)) return out("STALE", [`key may call ${fc.method_names.join(", ")}, not ${h.method}`]);
    if (h.deposit !== "0") return out("STALE", [`record needs deposit ${h.deposit}; a function-call key cannot attach one`]);
    const v = verifyHatch(h);
    if (!v.ok) return out("STALE", v.checks.filter((c) => c.startsWith("FAIL")));
    if (fc.allowance !== null) {
      // The node refuses the whole transaction (NotEnoughAllowance) unless the allowance covers the
      // prepaid gas up front, even though only the gas burnt is kept afterwards.
      const price = (await rpc.call<{ gas_price: string }>("gas_price", [null])).gas_price;
      const need = fcAllowanceNeeded(h.gas, price);
      if (BigInt(fc.allowance) < need) {
        return out("STALE", [`allowance ${fc.allowance} yoctoNEAR is below the ~${need} a ${h.gas}-gas call needs up front at gas price ${price}: the node would refuse it (lower the record's gas or re-arm with more allowance)`]);
      }
    }
    const reasons = [`function-call key for ${fc.receiver_id}: ${fc.method_names.join(", ") || "any method"}`];
    reasons.push(fc.allowance === null ? "allowance: unlimited (gas comes from the account balance)" : `allowance left: ${fc.allowance} yoctoNEAR`);
    return out("ARMED", reasons);
  }

  const v = verifyHatch(h);
  if (!v.ok) return out("STALE", v.checks.filter((c) => c.startsWith("FAIL")));
  if (key.permission !== "FullAccess") return out("STALE", [`key ${h.public_key} is no longer full access; a delegate action with a deposit needs a full-access key`]);
  const keyNonce = BigInt(String(key.nonce));
  const nonce = BigInt(h.nonce!);
  if (keyNonce >= nonce) return out("USED", [`key nonce ${keyNonce} >= hatch nonce ${nonce}: the signed action was submitted (or the key signed something else)`]);
  const max = Number(h.max_block_height);
  if (head > max) return out("EXPIRED", [`head ${head} is past max_block_height ${max}`]);
  if (max - head < MIN_LANDING_BLOCKS) {
    return out("EXPIRED", [`head ${head} is ${max - head} blocks from max_block_height ${max}: a delegate action sent now executes at least ${MIN_LANDING_BLOCKS} blocks after the final head, past its expiry`], max - head);
  }
  return out("ARMED", [`key present, full access, nonce ${keyNonce} < ${nonce}`, `${max - head} blocks until max_block_height ${max}`], max - head);
}

// ---------------------------------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------------------------------

type Status = any;
const isFailure = (s: Status) => s !== null && typeof s === "object" && "Failure" in s;
const isSuccess = (s: Status) => s !== null && typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);
const brief = (x: unknown) => JSON.stringify(x).slice(0, 400);

/**
 * Judges a final execution outcome. A transaction can "succeed" while the call inside it fails (a
 * delegate action spawns a receipt on the venue; a panic there is only visible in receipts_outcome),
 * so ok requires: no Failure anywhere, and at least one receipt executed on the venue, all succeeded.
 */
export function judgeOutcome(result: any, venue: string): { ok: boolean; error?: string } {
  if (!result) return { ok: false, error: "no outcome" };
  if (isFailure(result.status)) return { ok: false, error: `transaction failed: ${brief(result.status.Failure)}` };
  const receipts: any[] = result.receipts_outcome ?? [];
  for (const r of receipts) {
    if (isFailure(r.outcome?.status)) return { ok: false, error: `receipt ${r.id} on ${r.outcome.executor_id} failed: ${brief(r.outcome.status.Failure)}` };
  }
  const inner = receipts.filter((r) => r.outcome?.executor_id === venue);
  if (!inner.length) return { ok: false, error: `no receipt executed on ${venue}` };
  const bad = inner.find((r) => !isSuccess(r.outcome.status));
  if (bad) return { ok: false, error: `receipt ${bad.id} on ${venue} ended ${brief(bad.outcome.status)}` };
  return { ok: true };
}

const txHashOf = (res: any): string => res?.transaction_outcome?.id ?? res?.transaction?.hash ?? "";
const errorTx = (e: any): string => e?.context?.transactionHash ?? e?.transactionHash ?? "";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/** Relayer submits the signed withdraw. The relayer pays gas and the attached deposit; funds go to h.account. */
export async function fireHatch(h: Hatch, relayer: Account): Promise<{ tx: string; ok: boolean; error?: string }> {
  if (h.mode !== "delegate" || !h.signed_delegate) return { tx: "", ok: false, error: `hatch ${h.id} is ${h.mode}, not a delegate hatch` };
  const v = verifyHatch(h);
  // Refuse before spending the relayer's gas on something the chain would reject anyway.
  if (!v.ok) return { tx: "", ok: false, error: `hatch does not verify: ${v.checks.filter((c) => c.startsWith("FAIL")).join("; ")}` };
  const { plain } = decodeSigned(h.signed_delegate);
  const signed = plain as SignedDelegate; // borsh-shaped plain objects serialize back to the same bytes
  let res: any;
  try {
    res = await relayer.signAndSendTransaction({
      receiverId: h.account,
      actions: [actions.signedDelegate({ delegateAction: signed.delegateAction, signature: signed.signature })],
      throwOnFailure: false,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
  } catch (e) {
    return { tx: errorTx(e), ok: false, error: errorText(e) };
  }
  return { tx: txHashOf(res), ...judgeOutcome(res, h.venue) };
}

// ---------------------------------------------------------------------------------------------------
// fc-key mode
// ---------------------------------------------------------------------------------------------------

export interface ArmFunctionCallOptions {
  owner: Account;
  venue: string;
  /** Methods the key may call on the venue. Must be non-empty (an empty list means "any method"). */
  methods: string[];
  method: string;
  args: Record<string, unknown>;
  allowance?: string | bigint;
  gas?: string | bigint;
  trigger?: HatchTrigger;
}

/**
 * Adds a function-call key limited to (venue, methods) and returns it with the record. The guardian
 * must store the keyPair: unlike a delegate hatch, the secret is the hatch. It can only call those
 * methods with 0 deposit, paying gas from the allowance.
 */
export async function armFunctionCallHatch(o: ArmFunctionCallOptions): Promise<{ hatch: Hatch; keyPair: KeyPair }> {
  if (!o.methods.length) throw new Error("methods must be non-empty: an empty list lets the key call any method on the venue");
  if (!o.methods.includes(o.method)) throw new Error(`method ${o.method} is not in methods [${o.methods.join(", ")}]`);
  const args = requireArgs(o.args);
  const allowance = amount("allowance", o.allowance, DEFAULT_FC_ALLOWANCE);
  const gas = amount("gas", o.gas, DEFAULT_GAS);
  const provider = o.owner.provider;
  const network = networkOf(await provider.getNetworkId());
  // Refuse before adding a key that could never send its call (hatchHealth would call it STALE).
  const price = (await provider.viewBlock({ finality: "final" })).header.gas_price;
  const need = fcAllowanceNeeded(gas, price);
  if (BigInt(allowance) < need) throw new Error(`allowance ${allowance} is below the ~${need} yoctoNEAR a ${gas}-gas call needs up front at gas price ${price}`);
  const keyPair = KeyPair.fromRandom("ed25519");
  await o.owner.addFunctionCallAccessKey({ publicKey: keyPair.getPublicKey(), contractId: o.venue, methodNames: o.methods, allowance: BigInt(allowance) });
  const head = (await provider.viewBlock({ finality: "final" })).header.height;
  const body: Omit<Hatch, "id"> = {
    schema: HATCH_SCHEMA,
    network,
    account: o.owner.accountId,
    venue: o.venue,
    method: o.method,
    args,
    deposit: "0",
    gas,
    mode: "fc-key",
    public_key: keyPair.getPublicKey().toString(),
    nonce: null,
    max_block_height: null,
    signed_delegate: null,
    created_at: new Date().toISOString(),
    created_height: head,
    trigger: o.trigger ?? "stop",
  };
  return { hatch: withId(body), keyPair };
}

/** Signs and sends the permitted call with the guardian-held function-call key (0 deposit). */
export async function fireFunctionCallHatch(h: Hatch, keyPair: KeyPair, provider: Provider): Promise<{ tx: string; ok: boolean; error?: string }> {
  if (h.mode !== "fc-key") return { tx: "", ok: false, error: `hatch ${h.id} is ${h.mode}, not an fc-key hatch` };
  if (h.deposit !== "0") return { tx: "", ok: false, error: `hatch needs deposit ${h.deposit}; a function-call key cannot attach one` };
  if (keyPair.getPublicKey().toString() !== h.public_key) return { tx: "", ok: false, error: `keyPair is ${keyPair.getPublicKey().toString()}, hatch key is ${h.public_key}` };
  // The key would accept any args to its methods, so the record is all that fixes the call: refuse
  // one edited after arming.
  const v = verifyHatch(h);
  if (!v.ok) return { tx: "", ok: false, error: `hatch does not verify: ${v.checks.filter((c) => c.startsWith("FAIL")).join("; ")}` };
  const account = new Account(h.account, provider, new KeyPairSigner(keyPair));
  let res: any;
  try {
    res = await account.signAndSendTransaction({
      receiverId: h.venue,
      actions: [actions.functionCall(h.method, utf8(JSON.stringify(h.args)), BigInt(h.gas), 0n)],
      throwOnFailure: false,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
  } catch (e) {
    return { tx: errorTx(e), ok: false, error: errorText(e) };
  }
  return { tx: txHashOf(res), ...judgeOutcome(res, h.venue) };
}

// ---------------------------------------------------------------------------------------------------
// Deposit probe
// ---------------------------------------------------------------------------------------------------

// near-sdk assert_one_yocto ("exactly") and near-contract-standards assert_at_least_one_yocto ("at least",
// NFT nft_approve on asac.near and near-punks.near): 1 yocto satisfies both.
const ONE_YOCTO = /Requires attached deposit of (?:exactly|at least) 1 yoctoNEAR/i;
// Any other demand phrased the near-sdk way, e.g. wrap.near near_deposit "Requires positive attached deposit".
const OTHER_DEPOSIT = /attached deposit/i;
const NOT_FOUND = /MethodNotFound|MethodResolveError|CodeDoesNotExist|NO_CONTRACT_CODE|UNKNOWN_ACCOUNT|does not exist/;

function panicText(e: RpcAnswerError): string {
  const raw = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  const m = /panic_msg: \\?"(.*?)\\?"(?: \}|\))/.exec(raw) ?? /"panic_msg":"(.*?)"/.exec(raw);
  return (m ? m[1] : raw).replace(/\\n/g, " ").replace(/\\"/g, '"').slice(0, 240);
}

/**
 * Does `method` demand a deposit? Asks the chain with a view call (deposit 0, no state writes):
 *   panic "Requires attached deposit of exactly|at least 1 yoctoNEAR" => one-yocto (near-sdk
 *                                                                assert_one_yocto / assert_at_least_one_yocto)
 *   ProhibitedInView (e.g. predecessor_account_id read first) => inconclusive: the method stopped
 *                                                                before reaching any deposit check
 *   method or contract missing                                => inconclusive
 *   any other panic about an "attached deposit"               => inconclusive: it wants some deposit
 *   any other panic, or a normal return                        => none-before-state: no deposit was
 *     demanded before the method failed for another reason. Not proof that none is demanded later.
 */
export async function probeDeposit(rpc: Rpc, contract: string, method: string, args: unknown = {}): Promise<{ need: DepositNeed; detail: string }> {
  try {
    await rpc.view(contract, method, args);
    return { need: "none-before-state", detail: "view call returned without demanding a deposit" };
  } catch (e) {
    if (e instanceof SyntaxError) return { need: "none-before-state", detail: "view call returned (non-JSON) without demanding a deposit" };
    if (!(e instanceof RpcAnswerError)) throw e;
    const text = `${e.message} ${JSON.stringify(e.data)}`;
    if (ONE_YOCTO.test(text)) return { need: "one-yocto", detail: panicText(e) };
    const prohibited = /ProhibitedInView \{ method_name: \\?"(\w+)/.exec(text) ?? /ProhibitedInView/.exec(text);
    if (prohibited) return { need: "inconclusive", detail: `view call stopped at host function ${prohibited[1] ?? "?"} (ProhibitedInView) before any deposit check` };
    if (NOT_FOUND.test(text)) return { need: "inconclusive", detail: `method or contract not found: ${e.message.slice(0, 200)}` };
    // It did demand a deposit, just not one of the 1-yocto forms: "none" would be false.
    if (OTHER_DEPOSIT.test(panicText(e))) return { need: "inconclusive", detail: `panicked demanding a deposit other than 1 yoctoNEAR: ${panicText(e)}` };
    return { need: "none-before-state", detail: `panicked without demanding a deposit: ${panicText(e)}` };
  }
}
