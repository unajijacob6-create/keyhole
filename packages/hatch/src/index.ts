// @keyhole/hatch — escape hatches for NEAR depositors.
//
// A hatch is a withdraw-to-self that the depositor signs now and a guardian submits later, only if
// the contract holding the funds is about to change in a way Keyhole grades STOP.
//
// Two modes, because of one protocol rule: a function-call access key cannot attach a deposit
// (nearcore rejects it, meta-transactions included), and most withdraw methods on NEAR require
// exactly 1 yoctoNEAR (Ref `withdraw`, Burrow `execute`, wrap.near `near_withdraw`, NEP-141
// `ft_transfer`).
//
//   "delegate" — a NEP-366 SignedDelegateAction signed by a DEDICATED full-access key that is added
//                for this one hatch and whose secret is used once and dropped. It may carry the
//                1 yoctoNEAR. Anyone may relay it; the signature covers sender, receiver, method,
//                args, gas, deposit, nonce, expiry and key, so the relayer cannot change any of it.
//   "fc-key"   — a function-call key limited to the venue and its exit methods, held by the
//                guardian. Only for exits that take no deposit (e.g. LiNEAR unstake / withdraw).
//
// What a hatch cannot do: move funds anywhere but the depositor's own account (the venue pays the
// predecessor, which is the depositor); survive the depositor's own key being compromised (any
// full-access key can delete the hatch key or move funds first); help when the change lands with no
// window (stage + deploy in one transaction); work with venues that check signer_account_id.
import { deserialize } from "borsh";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  actions,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  SCHEMA,
  SignedDelegate,
  type Account,
  type Provider,
} from "near-api-js";
import { Rpc, RpcAnswerError, bytesToBase64, base64ToBytes, base58, type Network } from "../../core/src/index.ts";

export interface Hatch {
  schema: "keyhole.hatch/1";
  /** First 16 hex chars of sha256(signed delegate bytes) (delegate) or of the key + venue (fc-key). */
  id: string;
  network: Network;
  account: string;
  venue: string;
  method: string;
  args: Record<string, unknown>;
  /** yoctoNEAR attached to the call. */
  deposit: string;
  gas: string;
  mode: "delegate" | "fc-key";
  /** The dedicated key this hatch uses. */
  public_key: string;
  nonce: string | null;
  max_block_height: string | null;
  /** base64 borsh SignedDelegate (delegate mode). */
  signed_delegate: string | null;
  created_at: string;
  created_height: number;
  trigger: "stop" | "any-upgrade" | "manual";
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const DEFAULT_GAS = 50_000_000_000_000n;

/** Pure and offline: build and sign the delegate for a key whose current nonce is `keyNonce`. */
export async function prepareDelegateHatch(o: {
  network: Network;
  account: string;
  venue: string;
  method: string;
  args?: Record<string, unknown>;
  deposit?: string;
  gas?: string;
  keyPair: KeyPair;
  keyNonce: bigint;
  headHeight: number;
  ttlBlocks: number;
  trigger?: Hatch["trigger"];
  now?: Date;
}): Promise<Hatch> {
  const args = o.args ?? {};
  const deposit = BigInt(o.deposit ?? "1");
  const gas = BigInt(o.gas ?? DEFAULT_GAS);
  const publicKey = o.keyPair.getPublicKey();
  const nonce = o.keyNonce + 1n;
  const maxBlockHeight = BigInt(o.headHeight + o.ttlBlocks);
  const da = buildDelegateAction({
    senderId: o.account,
    receiverId: o.venue,
    actions: [actions.functionCall(o.method, args, gas, deposit)],
    nonce,
    maxBlockHeight,
    publicKey,
  } as any);
  const { signedDelegate } = await new KeyPairSigner(o.keyPair).signDelegateAction(da);
  const bytes = encodeSignedDelegate(signedDelegate);
  return {
    schema: "keyhole.hatch/1",
    id: hex(sha256(bytes)).slice(0, 16),
    network: o.network,
    account: o.account,
    venue: o.venue,
    method: o.method,
    args,
    deposit: deposit.toString(),
    gas: gas.toString(),
    mode: "delegate",
    public_key: publicKey.toString(),
    nonce: nonce.toString(),
    max_block_height: maxBlockHeight.toString(),
    signed_delegate: bytesToBase64(bytes),
    created_at: (o.now ?? new Date()).toISOString(),
    created_height: o.headHeight,
    trigger: o.trigger ?? "stop",
  };
}

async function waitForKey(provider: Provider, accountId: string, publicKey: string): Promise<bigint> {
  for (let i = 0; i < 30; i++) {
    try {
      const ak: any = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } } as any);
      return BigInt(ak.nonce);
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`key ${publicKey} did not appear on ${accountId}`);
}

/**
 * Arm a delegate-mode hatch: add a dedicated full-access key to the depositor's account (signed by
 * `owner`, the depositor's own account), pre-sign the exit with it, and drop the secret. The secret
 * is never written anywhere; JavaScript cannot guarantee that memory is zeroed, so treat the process
 * that armed it like any process that has held a key.
 */
export async function armDelegateHatch(o: {
  owner: Account;
  provider: Provider;
  venue: string;
  method: string;
  args?: Record<string, unknown>;
  deposit?: string;
  gas?: string;
  ttlBlocks?: number;
  trigger?: Hatch["trigger"];
  network?: Network;
}): Promise<Hatch> {
  let kp: KeyPair | null = KeyPair.fromRandom("ed25519");
  const pk = kp.getPublicKey().toString();
  // Wait for finality: hatchHealth reads final state, and a hatch must not look REVOKED while the
  // AddKey is still settling.
  await o.owner.signAndSendTransaction({ receiverId: o.owner.accountId, actions: [actions.addFullAccessKey(PublicKey.from(pk))], waitUntil: "FINAL" } as any);
  const keyNonce = await waitForKey(o.provider, o.owner.accountId, pk);
  const head: any = await o.provider.viewBlock({ finality: "final" } as any);
  const hatch = await prepareDelegateHatch({
    network: o.network ?? "testnet",
    account: o.owner.accountId,
    venue: o.venue,
    method: o.method,
    args: o.args,
    deposit: o.deposit,
    gas: o.gas,
    keyPair: kp,
    keyNonce,
    headHeight: head.header.height,
    ttlBlocks: o.ttlBlocks ?? 7 * 24 * 3600,
    trigger: o.trigger,
  });
  kp = null; // the only reference to the secret
  return hatch;
}

function signedDelegateOf(h: Hatch): SignedDelegate {
  if (!h.signed_delegate) throw new Error(`hatch ${h.id} has no signed delegate (mode ${h.mode})`);
  const raw: any = deserialize(SCHEMA.SignedDelegate as any, base64ToBytes(h.signed_delegate));
  return raw as SignedDelegate;
}

const pkString = (pk: any): string => {
  const data: Uint8Array | undefined = pk?.ed25519Key?.data ?? pk?.data;
  if (!data) throw new Error("unsupported public key type in delegate");
  return `ed25519:${base58.encode(new Uint8Array(data))}`;
};

/** Everything the signed bytes allow, decoded from the bytes themselves (not from the record). */
export function decodeHatch(h: Hatch) {
  const sd: any = signedDelegateOf(h);
  const da = sd.delegateAction;
  return {
    senderId: da.senderId as string,
    receiverId: da.receiverId as string,
    actions: (da.actions as any[]).map((a) => {
      const fc = a.functionCall;
      if (!fc) return { method: `(non-function-call action: ${Object.keys(a).join(",")})`, args: null as unknown, deposit: "0", gas: "0" };
      const text = new TextDecoder().decode(new Uint8Array(fc.args));
      let args: unknown = text;
      try {
        args = JSON.parse(text);
      } catch {
        /* raw bytes */
      }
      return { method: fc.methodName as string, args, deposit: BigInt(fc.deposit).toString(), gas: BigInt(fc.gas).toString() };
    }),
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    publicKey: pkString(da.publicKey),
  };
}

/** Offline: the signature is valid for the bytes, and the bytes say what the record says. */
export function verifyHatch(h: Hatch): { ok: boolean; checks: string[] } {
  const checks: string[] = [];
  let ok = true;
  const fail = (s: string) => {
    ok = false;
    checks.push(s);
  };
  if (h.mode !== "delegate") return { ok: true, checks: ["fc-key hatch: nothing pre-signed; the key's permission is checked on chain by hatchHealth"] };
  let sd: any;
  try {
    sd = signedDelegateOf(h);
  } catch (e) {
    return { ok: false, checks: [`cannot decode signed delegate: ${(e as Error).message}`] };
  }
  const msg = sha256(encodeDelegateAction(sd.delegateAction));
  const sig: Uint8Array = new Uint8Array(sd.signature?.ed25519Signature?.data ?? sd.signature?.data ?? []);
  const pkData = new Uint8Array(sd.delegateAction.publicKey?.ed25519Key?.data ?? []);
  let sigOk = false;
  try {
    sigOk = ed25519.verify(sig, msg, pkData);
  } catch {
    sigOk = false;
  }
  if (sigOk) checks.push("ed25519 signature over sha256(NEP-461 prefix + delegate) is valid");
  else fail("signature does NOT verify");
  const d = decodeHatch(h);
  const a = d.actions[0];
  if (d.actions.length !== 1) fail(`delegate has ${d.actions.length} actions, expected 1`);
  if (d.senderId !== h.account) fail(`sender ${d.senderId} != record ${h.account}`);
  if (d.receiverId !== h.venue) fail(`receiver ${d.receiverId} != record ${h.venue}`);
  if (a?.method !== h.method) fail(`method ${a?.method} != record ${h.method}`);
  if (JSON.stringify(a?.args) !== JSON.stringify(h.args)) fail("args differ from record");
  if (a?.deposit !== h.deposit) fail(`deposit ${a?.deposit} != record ${h.deposit}`);
  if (a?.gas !== h.gas) fail(`gas ${a?.gas} != record ${h.gas}`);
  if (d.nonce.toString() !== h.nonce) fail(`nonce ${d.nonce} != record ${h.nonce}`);
  if (d.maxBlockHeight.toString() !== h.max_block_height) fail(`max_block_height ${d.maxBlockHeight} != record ${h.max_block_height}`);
  if (d.publicKey !== h.public_key) fail(`public key ${d.publicKey} != record ${h.public_key}`);
  if (ok) checks.push("sender, receiver, method, args, deposit, gas, nonce, expiry and key match the record");
  return { ok, checks };
}

export type HatchState = "ARMED" | "USED" | "REVOKED" | "EXPIRED" | "STALE";

/** Is this hatch still able to fire? Deterministic, from public chain state. */
export async function hatchHealth(rpc: Rpc, h: Hatch, opts: { headHeight?: number } = {}): Promise<{ state: HatchState; reasons: string[]; key_nonce: string | null; head: number; blocks_left: number | null }> {
  const head = opts.headHeight ?? (await rpc.block()).header.height;
  let ak: any;
  try {
    ak = await rpc.call("query", { request_type: "view_access_key", account_id: h.account, public_key: h.public_key, finality: "final" });
  } catch (e) {
    if (e instanceof RpcAnswerError) return { state: "REVOKED", reasons: [`key ${h.public_key} is no longer on ${h.account}`], key_nonce: null, head, blocks_left: null };
    throw e;
  }
  const nonce = BigInt(ak.nonce);
  const perm = ak.permission;
  if (h.mode === "delegate") {
    const blocksLeft = h.max_block_height ? Number(BigInt(h.max_block_height) - BigInt(head)) : null;
    if (perm !== "FullAccess") return { state: "STALE", reasons: ["the hatch key is no longer a full-access key"], key_nonce: nonce.toString(), head, blocks_left: blocksLeft };
    if (nonce >= BigInt(h.nonce!)) return { state: "USED", reasons: [`key nonce ${nonce} >= signed nonce ${h.nonce}: the hatch (or another tx with this key) already ran`], key_nonce: nonce.toString(), head, blocks_left: blocksLeft };
    if (blocksLeft !== null && blocksLeft < 0) return { state: "EXPIRED", reasons: [`head ${head} is past max_block_height ${h.max_block_height}`], key_nonce: nonce.toString(), head, blocks_left: blocksLeft };
    return { state: "ARMED", reasons: [], key_nonce: nonce.toString(), head, blocks_left: blocksLeft };
  }
  const fc = perm?.FunctionCall;
  if (!fc) return { state: "STALE", reasons: ["fc-key hatch key is not a function-call key"], key_nonce: nonce.toString(), head, blocks_left: null };
  if (fc.receiver_id !== h.venue) return { state: "STALE", reasons: [`key is for ${fc.receiver_id}, not ${h.venue}`], key_nonce: nonce.toString(), head, blocks_left: null };
  if (fc.method_names.length && !fc.method_names.includes(h.method)) return { state: "STALE", reasons: [`key does not allow ${h.method}`], key_nonce: nonce.toString(), head, blocks_left: null };
  return { state: "ARMED", reasons: [], key_nonce: nonce.toString(), head, blocks_left: null };
}

/** Did the transaction and every receipt it spawned succeed? */
export function outcomeError(out: any): string | null {
  const st = out?.status;
  if (st && typeof st === "object" && "Failure" in st) return JSON.stringify(st.Failure).slice(0, 300);
  for (const r of out?.receipts_outcome ?? []) {
    const s = r?.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify(s.Failure).slice(0, 300);
  }
  return null;
}

/** Relay a delegate hatch. The relayer pays gas and the attached deposit; it cannot alter the call. */
export async function fireHatch(h: Hatch, relayer: Account): Promise<{ tx: string | null; ok: boolean; error?: string }> {
  const sd = signedDelegateOf(h);
  try {
    const out: any = await relayer.signAndSendTransaction({ receiverId: h.account, actions: [actions.signedDelegate(sd as any)], waitUntil: "FINAL", throwOnFailure: false } as any);
    const tx = out?.transaction?.hash ?? out?.transaction_outcome?.id ?? null;
    const err = outcomeError(out);
    return err ? { tx, ok: false, error: err } : { tx, ok: true };
  } catch (e) {
    return { tx: null, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/** Arm an fc-key hatch: a function-call key for `venue` limited to `methods`. The guardian must store the key pair. */
export async function armFunctionCallHatch(o: { owner: Account; provider: Provider; venue: string; methods: string[]; method: string; args?: Record<string, unknown>; gas?: string; allowance?: bigint; trigger?: Hatch["trigger"]; network?: Network }): Promise<{ hatch: Hatch; keyPair: KeyPair }> {
  if (!o.methods.includes(o.method)) throw new Error(`${o.method} is not in the key's method list`);
  const keyPair = KeyPair.fromRandom("ed25519");
  const pk = keyPair.getPublicKey().toString();
  await o.owner.signAndSendTransaction({ receiverId: o.owner.accountId, actions: [actions.addFunctionCallAccessKey(PublicKey.from(pk), o.venue, o.methods, o.allowance ?? 250_000_000_000_000_000_000_000n)], waitUntil: "FINAL" } as any);
  await waitForKey(o.provider, o.owner.accountId, pk);
  const head: any = await o.provider.viewBlock({ finality: "final" } as any);
  const hatch: Hatch = {
    schema: "keyhole.hatch/1",
    id: hex(sha256(new TextEncoder().encode(`${pk}:${o.venue}:${o.method}`))).slice(0, 16),
    network: o.network ?? "testnet",
    account: o.owner.accountId,
    venue: o.venue,
    method: o.method,
    args: o.args ?? {},
    deposit: "0",
    gas: (o.gas ?? DEFAULT_GAS).toString(),
    mode: "fc-key",
    public_key: pk,
    nonce: null,
    max_block_height: null,
    signed_delegate: null,
    created_at: new Date().toISOString(),
    created_height: head.header.height,
    trigger: o.trigger ?? "stop",
  };
  return { hatch, keyPair };
}

/** Fire an fc-key hatch with the guardian-held key (no deposit: that is what fc keys allow). */
export async function fireFunctionCallHatch(h: Hatch, keyPair: KeyPair, provider: Provider): Promise<{ tx: string | null; ok: boolean; error?: string }> {
  const { Account } = await import("near-api-js");
  const acc = new Account(h.account, provider as any, new KeyPairSigner(keyPair) as any);
  try {
    const out: any = await acc.callFunctionRaw({ contractId: h.venue, methodName: h.method, args: h.args, gas: BigInt(h.gas), deposit: 0n, waitUntil: "FINAL" } as any);
    const tx = out?.transaction?.hash ?? null;
    const err = outcomeError(out);
    return err ? { tx, ok: false, error: err } : { tx, ok: true };
  } catch (e) {
    return { tx: null, ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

export type DepositNeed = "one-yocto" | "none-before-state" | "inconclusive";

/**
 * Does `method` demand exactly 1 yoctoNEAR? A view call runs with attached_deposit = 0, so a method
 * whose first check is assert_one_yocto panics with that message. A method that first reads the
 * caller panics with ProhibitedInView instead: inconclusive. Anything else means no deposit check
 * ran before state was touched (it may still demand one later: treat as a hint, not a proof).
 */
export async function probeDeposit(rpc: Rpc, contract: string, method: string, args: unknown = {}): Promise<{ need: DepositNeed; detail: string }> {
  try {
    await rpc.view(contract, method, args);
    return { need: "none-before-state", detail: "the view call returned without a deposit check" };
  } catch (e) {
    const msg = String((e as Error).message);
    if (/exactly 1 yoctoNEAR|Requires attached deposit of exactly 1/i.test(msg)) return { need: "one-yocto", detail: "panics: Requires attached deposit of exactly 1 yoctoNEAR" };
    if (/ProhibitedInView/.test(msg)) return { need: "inconclusive", detail: `the method reads the caller before any deposit check (${msg.match(/ProhibitedInView[^"\\]*/)?.[0] ?? "ProhibitedInView"})` };
    if (!(e instanceof RpcAnswerError)) throw e;
    return { need: "none-before-state", detail: msg.slice(0, 160) };
  }
}

