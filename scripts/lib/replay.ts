// Re-check a recorded Keyhole Guardian run (data/guardian-run.json) against public testnet archival
// RPC, with no keys. The recording supplies transaction hashes; everything else it says (who signed,
// which contract was called, the heights, the proposal id, the code hashes, the signed hatch, the
// balances) is compared with what the chain says, and a mismatch is a FAIL. Every step a Guardian run
// records is required: a recording with a step left out fails instead of running fewer checks.
import fs from "node:fs";
import { serialize } from "borsh";
import { SCHEMA } from "near-api-js";
import { analyzeWasm, ARCHIVAL_RPC, base58, base64ToBytes, bytesToBase64, codeHash, exportDiff, gradeUpgrade, KEYHOLE_REGISTRY, Rpc, RpcAnswerError } from "../../packages/core/src/index.ts";
import { decodeHatch, verifyHatch, type Hatch } from "../../packages/hatch/src/index.ts";
import { verifyReceiptOffline } from "../../reviewer/src/review.ts";

export type Check = { id: string; ok: boolean; text: string };

/** NEAR's access-key nonce rule: a key added by a receipt applied in block H starts at nonce
 *  (H - 1) * 1e6. The replay does not take this on trust: it finds the AddKey transaction with it and
 *  then requires the receipt's block (from the chain) to agree. */
export const ACCESS_KEY_NONCE_MULTIPLIER = 1_000_000n;

const NEAR = 10n ** 24n;
/** The amounts the site (web/src/guardian.ts) shows for this run, in yoctoNEAR. The replay derives
 *  each one from archival state and fails if the chain says otherwise. */
export const SITE_FIGURES = {
  alice_deposit: NEAR,
  bob_deposit: NEAR / 2n,
  vault_total_before_fire: (3n * NEAR) / 2n,
  alice_refund: NEAR,
  vault_total_after_fire: NEAR / 2n,
  bob_in_vault_before_sweep: NEAR / 2n,
  swept: NEAR / 2n,
} as const;
export type Figures = Record<keyof typeof SITE_FIGURES, string | null>;

/** What the replay re-derived from the chain (null where it could not), for pages that show the run. */
export interface ReplayResult {
  ok: boolean;
  checks: Check[];
  derived: {
    figures: Figures;
    hatch_key: { add_tx: string; add_height: number; initial_nonce: string } | null;
    upgrade_height: number | null;
    withdraw_height: number | null;
    ai_review: { registry_id: number; height: number } | null;
    grade: { verdict: string; flags: string[]; headline: string } | null;
  };
}

/** Steps every Guardian run records (scripts/demo-guardian.ts). `ai_review` is posted only when the
 *  private TEE review ran, and is then required: a recording with a `review` must carry the
 *  registry transaction that put it on chain. */
export const REQUIRED_STEPS = ["deploy_vault", "init_vault", "delete_vault_key", "alice_deposit", "bob_deposit", "store_blob", "add_proposal", "hatch_fired", "vote_1", "vote_2", "sweep"] as const;
export const OPTIONAL_STEPS = ["ai_review"] as const;

/** Check ids that must all have run for a replay to pass (a step check per required step, plus these). */
export const REQUIRED_CHECKS = [
  "steps",
  ...REQUIRED_STEPS.map((k) => `step:${k}`),
  "deposits",
  "code:honest",
  "vault:keys",
  "vault:owner",
  "blob",
  "proposal:id",
  "proposal:kind",
  "proposal:state",
  "vote:vote_1",
  "vote:vote_2",
  "upgrade",
  "diff",
  "review",
  "verdict",
  "hatch:signature",
  "hatch:created",
  "hatch:onchain",
  "hatch:withdraw",
  "hatch:balance",
  "order",
  "sweep",
  "figures",
  "recording",
] as const;

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const json = (b64: string | undefined): any => {
  try {
    return b64 === undefined ? null : JSON.parse(utf8(base64ToBytes(b64)));
  } catch {
    return null;
  }
};
const b64ToB58 = (b64: string | undefined) => {
  try {
    return b64 ? base58.encode(base64ToBytes(b64)) : null;
  } catch {
    return null;
  }
};
const actionsOf = (tx: any): any[] => (Array.isArray(tx?.transaction?.actions) ? tx.transaction.actions : []);
/** The only action of a transaction, if it has exactly one of `kind`. */
const only = (tx: any, kind: string): any => {
  const a = actionsOf(tx);
  return a.length === 1 && a[0] && typeof a[0] === "object" && kind in a[0] ? a[0][kind] : null;
};

function failed(outcome: any): string | null {
  const st = outcome?.status;
  if (!st || typeof st !== "object") return "no final status";
  if ("Failure" in st) return JSON.stringify(st.Failure).slice(0, 200);
  for (const r of outcome?.receipts_outcome ?? []) {
    const s = r.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify(s.Failure).slice(0, 200);
  }
  return null;
}

/** Receipts of a tx outcome (EXPERIMENTAL_tx_status), joined with where each executed. */
function receiptsOf(r: any): { id: string; predecessor: string; receiver: string; actions: any[]; block: string; status: any }[] {
  const outcomes = new Map<string, any>((r?.receipts_outcome ?? []).map((o: any) => [o.id, o]));
  return (r?.receipts ?? []).map((x: any) => ({
    id: x.receipt_id,
    predecessor: x.predecessor_id,
    receiver: x.receiver_id,
    actions: x.receipt?.Action?.actions ?? [],
    block: outcomes.get(x.receipt_id)?.block_hash,
    status: outcomes.get(x.receipt_id)?.outcome?.status,
  }));
}
const succeeded = (status: any) => Boolean(status && typeof status === "object" && ("SuccessValue" in status || "SuccessReceiptId" in status));

const KEY_KINDS: Record<string, [string, string]> = { ed25519: ["ed25519Key", "ed25519Signature"], secp256k1: ["secp256k1Key", "secp256k1Signature"] };
/** Borsh bytes (base64) of a SignedDelegate as the chain's JSON view shows it, so it can be compared
 *  byte for byte with the delegate Alice signed. Null if the view holds something a hatch never does. */
export function signedDelegateFromView(view: any): string | null {
  const da = view?.delegate_action;
  if (!da || typeof view.signature !== "string" || typeof da.public_key !== "string") return null;
  const [pkKind, pkData] = da.public_key.split(":");
  const [sigKind, sigData] = view.signature.split(":");
  if (!KEY_KINDS[pkKind] || pkKind !== sigKind) return null;
  const acts: any[] = [];
  for (const a of da.actions ?? []) {
    const fc = a?.FunctionCall;
    if (!fc || Object.keys(a).length !== 1) return null;
    acts.push({ functionCall: { methodName: fc.method_name, args: base64ToBytes(fc.args ?? ""), gas: BigInt(fc.gas), deposit: BigInt(fc.deposit) } });
  }
  const plain = {
    delegateAction: {
      senderId: da.sender_id,
      receiverId: da.receiver_id,
      actions: acts,
      nonce: BigInt(da.nonce),
      maxBlockHeight: BigInt(da.max_block_height),
      publicKey: { [KEY_KINDS[pkKind][0]]: { data: Array.from(base58.decode(pkData)) } },
    },
    signature: { [KEY_KINDS[sigKind][1]]: { data: Array.from(base58.decode(sigData)) } },
  };
  try {
    return bytesToBase64(serialize(SCHEMA.SignedDelegate, plain));
  } catch {
    return null; // e.g. a key or signature of the wrong length
  }
}

export async function replayGuardianRun(file: string, opts: { rpc?: Rpc; log?: (s: string) => void } = {}): Promise<boolean> {
  const log = opts.log ?? ((s: string) => console.log(s));
  if (!fs.existsSync(file)) {
    log(`no recording at ${file}: run npm run demo:guardian (live, testnet keys) first`);
    return false;
  }
  return replayGuardianRecording(JSON.parse(fs.readFileSync(file, "utf8")), { ...opts, label: file });
}

export async function replayGuardianRecording(run: any, opts: { rpc?: Rpc; log?: (s: string) => void; label?: string } = {}): Promise<boolean> {
  return (await replayGuardianDetailed(run, opts)).ok;
}

/** Stable JSON (sorted keys) for comparing a recorded object with a re-derived one. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

export async function replayGuardianDetailed(run: any, opts: { rpc?: Rpc; log?: (s: string) => void; label?: string } = {}): Promise<ReplayResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const rpc = opts.rpc ?? new Rpc({ network: "testnet", url: ARCHIVAL_RPC.testnet });
  const checks: Check[] = [];
  const check = (id: string, ok: boolean, text: string) => {
    checks.push({ id, ok, text });
    log(`  ${ok ? "ok " : "XX "} ${text}`);
  };
  /** A section that throws (missing data, an RPC answer it cannot read) fails its check instead of
   *  being skipped. */
  const section = async (id: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      check(id, false, `${id}: could not be checked: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  };
  const txs: Record<string, string> = run?.tx ?? {};
  const signers: Record<string, string> = run?.signers ?? {};
  const heights: Record<string, number> = run?.heights ?? {};
  const acc: Record<string, string> = run?.accounts ?? {};
  const hatch: Hatch | null = run?.hatch ?? null;
  const vault: string = run?.vault;
  const dao: string = run?.dao;
  const heightOf = async (blockHash: string) => ((await rpc.block({ block_id: blockHash })) as any).header.height as number;
  /** An access key at a block, or null when the chain says it is not there. */
  const keyAt = async (account: string, publicKey: string, height: number): Promise<{ nonce: string; permission: unknown } | null> => {
    try {
      const k: any = await rpc.call("query", { request_type: "view_access_key", account_id: account, public_key: publicKey, block_id: height });
      return { nonce: String(k.nonce), permission: k.permission };
    } catch (e) {
      if (e instanceof RpcAnswerError) return null;
      throw e;
    }
  };
  const balanceAt = async (account: string, height: number) => BigInt(await rpc.view<string>(vault, "get_balance", { account_id: account }, height));
  const totalAt = async (height: number) => BigInt(await rpc.view<string>(vault, "get_total", {}, height));
  const review: any = run?.review ?? null;
  /** A recording that shows a TEE review must carry the registry transaction that posted it. */
  const reviewRequired = review !== null && review !== undefined;
  const figures: Figures = { alice_deposit: null, bob_deposit: null, vault_total_before_fire: null, alice_refund: null, vault_total_after_fire: null, bob_in_vault_before_sweep: null, swept: null };
  const derived: ReplayResult["derived"] = { figures, hatch_key: null, upgrade_height: null, withdraw_height: null, ai_review: null, grade: null };

  log(`Replaying ${opts.label ?? "recording"} (recorded ${run?.recordedAt}) against ${rpc.url}`);
  log(`DAO ${dao} · vault ${vault}`);

  // 1. Every required step is in the recording; nothing unknown is.
  const known = new Set<string>([...REQUIRED_STEPS, ...OPTIONAL_STEPS]);
  const missing: string[] = REQUIRED_STEPS.filter((k) => !txs[k]);
  if (reviewRequired && !txs.ai_review) missing.push("ai_review (the recording has a TEE review)");
  const unknown = Object.keys(txs).filter((k) => !known.has(k));
  check("steps", missing.length === 0 && unknown.length === 0 && run?.network === "testnet" && Boolean(hatch), `recording has every required step (${REQUIRED_STEPS.length}${reviewRequired ? " + ai_review, required because it has a TEE review" : txs.ai_review ? " + ai_review" : ""})${missing.length ? `; MISSING ${missing.join(", ")}` : ""}${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}${hatch ? "" : "; MISSING hatch"}${run?.network === "testnet" ? "" : `; network ${run?.network}`}`);

  // 2. Each transaction exists, succeeded, was signed by the recorded signer, went to the contract that
  //    step calls, and landed at the recorded height.
  const got: Record<string, { r: any; height: number } | null> = {};
  for (const key of [...REQUIRED_STEPS, ...OPTIONAL_STEPS]) got[key] = null;
  const fetchTx = async (key: string) => {
    const r: any = await rpc.call("EXPERIMENTAL_tx_status", { tx_hash: txs[key], sender_account_id: signers[key], wait_until: "FINAL" });
    return { r, height: await heightOf(r.transaction_outcome.block_hash) };
  };
  const fcOf = (key: string) => only(got[key]?.r, "FunctionCall");
  const role: Record<string, { signer: string | undefined; receiver: string | undefined; what: (key: string) => string | null }> = {
    deploy_vault: { signer: vault, receiver: vault, what: (k) => (only(got[k]?.r, "DeployContract") ? null : "not a single DeployContract") },
    init_vault: { signer: vault, receiver: vault, what: (k) => (fcOf(k)?.method_name === "new" && json(fcOf(k)?.args)?.owner_id === dao ? null : `not new({owner_id: ${dao}}): ${fcOf(k)?.method_name}(${utf8(base64ToBytes(fcOf(k)?.args ?? "")).slice(0, 80)})`) },
    delete_vault_key: { signer: vault, receiver: vault, what: (k) => (only(got[k]?.r, "DeleteKey") ? null : "not a single DeleteKey") },
    alice_deposit: { signer: acc.alice, receiver: vault, what: (k) => (fcOf(k)?.method_name === "deposit" && BigInt(fcOf(k)?.deposit ?? 0) > 0n ? null : "not a deposit with NEAR attached") },
    bob_deposit: { signer: acc.bob, receiver: vault, what: (k) => (fcOf(k)?.method_name === "deposit" && BigInt(fcOf(k)?.deposit ?? 0) > 0n ? null : "not a deposit with NEAR attached") },
    store_blob: { signer: acc.proposer, receiver: dao, what: (k) => (fcOf(k)?.method_name === "store_blob" ? null : `method ${fcOf(k)?.method_name}`) },
    add_proposal: { signer: acc.proposer, receiver: dao, what: (k) => (fcOf(k)?.method_name === "add_proposal" ? null : `method ${fcOf(k)?.method_name}`) },
    hatch_fired: { signer: acc.guardian, receiver: hatch?.account, what: (k) => (only(got[k]?.r, "Delegate") ? (got[k]!.r.transaction.signer_id !== hatch?.account ? null : "signed by the depositor, not relayed") : "not a single Delegate action") },
    vote_1: { signer: acc.proposer, receiver: dao, what: (k) => (fcOf(k)?.method_name === "act_proposal" ? null : `method ${fcOf(k)?.method_name}`) },
    vote_2: { signer: acc.approver, receiver: dao, what: (k) => (fcOf(k)?.method_name === "act_proposal" ? null : `method ${fcOf(k)?.method_name}`) },
    sweep: { signer: signers.sweep, receiver: vault, what: (k) => (fcOf(k)?.method_name === "sweep" ? null : `method ${fcOf(k)?.method_name}`) },
    ai_review: { signer: signers.ai_review, receiver: KEYHOLE_REGISTRY.account, what: (k) => (fcOf(k)?.method_name === "attest" && json(fcOf(k)?.args)?.code_hash === run?.code?.evil ? null : "not an attest() about the proposed code hash") },
  };
  for (const key of [...REQUIRED_STEPS, ...OPTIONAL_STEPS]) {
    if (!txs[key]) {
      if ((REQUIRED_STEPS as readonly string[]).includes(key)) check(`step:${key}`, false, `${key}: MISSING from the recording`);
      else if (key === "ai_review" && reviewRequired) check(`step:${key}`, false, `${key}: MISSING from the recording, which shows a TEE review (${review?.risk}) and registry AiReview #${review?.registry_id}`);
      continue;
    }
    await section(`step:${key}`, async () => {
      got[key] = await fetchTx(key);
      const { r, height } = got[key]!;
      const t = r.transaction;
      const exp = role[key];
      const problems: string[] = [];
      const f = failed(r);
      if (f) problems.push(`FAILED ${f}`);
      if (t.signer_id !== signers[key]) problems.push(`chain signer ${t.signer_id} != recorded ${signers[key]}`);
      if (!exp.signer || signers[key] !== exp.signer) problems.push(`recorded signer ${signers[key]} is not the ${key} account ${exp.signer}`);
      if (!exp.receiver || t.receiver_id !== exp.receiver) problems.push(`receiver ${t.receiver_id} != ${exp.receiver}`);
      const w = exp.what(key);
      if (w) problems.push(w);
      const recorded = heights[key];
      const needsHeight = (REQUIRED_STEPS as readonly string[]).includes(key) || recorded !== undefined;
      if (needsHeight && recorded !== height) problems.push(`recorded height ${recorded} != chain ${height}`);
      check(`step:${key}`, problems.length === 0, `${key}: ${txs[key]} ${t.signer_id} → ${t.receiver_id} at block ${height}${problems.length ? ` · ${problems.join("; ")}` : " (signer, receiver, call and height match)"}`);
    });
  }

  // 2b. Each deposit was credited: the depositor's vault balance rose by exactly the attached NEAR in
  //     the block the deposit receipt ran (read from archival state, so other deposits or depositors
  //     do not matter).
  const deposited: Record<string, bigint | null> = { alice: null, bob: null };
  await section("deposits", async () => {
    const parts: string[] = [];
    let ok = true;
    for (const [who, key] of [["alice", "alice_deposit"], ["bob", "bob_deposit"]] as const) {
      const attached = BigInt(fcOf(key)?.deposit ?? -1);
      const rc = receiptsOf(got[key]?.r).find((x) => x.predecessor === acc[who] && x.receiver === vault && x.actions[0]?.FunctionCall?.method_name === "deposit");
      const at = rc?.block && succeeded(rc.status) ? await heightOf(rc.block) : 0;
      const before = at ? await balanceAt(acc[who], at - 1) : null;
      const after = at ? await balanceAt(acc[who], at) : null;
      const credited = before !== null && after !== null ? after - before : null;
      if (!(at > 0 && attached > 0n && credited === attached)) ok = false;
      else deposited[who] = attached;
      parts.push(`${who} attached ${attached} yocto; vault balance ${before} → ${after} at block ${at}`);
    }
    check("deposits", ok, `deposits credited: ${parts.join("; ")}`);
  });

  // 3. The code hashes the recording names are the ones the chain ran.
  let upgradeAt = 0; // block in which the vault's code changed (the DeployContract receipt of the deciding vote)
  let upReceipt: ReturnType<typeof receiptsOf>[number] | undefined;
  await section("upgrade", async () => {
    const recs = receiptsOf(got.vote_2?.r);
    upReceipt = recs.find((x) => x.predecessor === dao && x.receiver === vault && x.actions.length === 1 && x.actions[0]?.FunctionCall);
    const dep = recs.find((x) => x.predecessor === vault && x.receiver === vault && x.actions.some((a) => a?.DeployContract));
    const deployed = b64ToB58(dep?.actions.find((a) => a?.DeployContract)?.DeployContract?.code);
    const argsHash = upReceipt ? await codeHash(base64ToBytes(upReceipt.actions[0].FunctionCall.args ?? "")) : null;
    upgradeAt = dep?.block && succeeded(dep.status) ? await heightOf(dep.block) : 0;
    const before = upgradeAt ? (await rpc.viewAccount(vault, upgradeAt - 1)).code_hash : null;
    const after = upgradeAt ? (await rpc.viewAccount(vault, upgradeAt)).code_hash : null;
    const ok = Boolean(upReceipt && dep) && argsHash === run?.code?.evil && deployed === run?.code?.evil && before === run?.code?.honest && after === run?.code?.evil;
    check(
      "upgrade",
      ok,
      upReceipt && dep
        ? `deciding vote ${txs.vote_2}: ${dao} called ${vault}.${upReceipt.actions[0].FunctionCall.method_name}(code ${argsHash}), which deployed ${deployed} at block ${upgradeAt}; vault code ${before} at ${upgradeAt - 1} → ${after} at ${upgradeAt}`
        : `deciding vote ${txs.vote_2}: no call from ${dao} to ${vault} that deploys code (this transaction did not execute the upgrade)`,
    );
  });
  await section("code:honest", async () => {
    const dep = only(got.deploy_vault?.r, "DeployContract");
    const deployed = b64ToB58(dep?.code);
    const live = got.deploy_vault ? (await rpc.viewAccount(vault, got.deploy_vault.height)).code_hash : null;
    check("code:honest", deployed === run?.code?.honest && live === run?.code?.honest, `deploy_vault deployed ${deployed}; vault code at block ${got.deploy_vault?.height}: ${live} (recorded honest ${run?.code?.honest})`);
  });
  await section("vault:keys", async () => {
    const keys = upgradeAt ? await rpc.viewAccessKeys(vault, upgradeAt - 1) : null;
    check("vault:keys", Array.isArray(keys) && keys.length === 0, `vault access keys just before the upgrade (block ${upgradeAt - 1}): ${keys ? keys.length : "unknown"}${keys?.length ? ` (${keys.map((k) => k.public_key).join(", ")})` : ""}`);
  });
  await section("vault:owner", async () => {
    const owner = upgradeAt ? await rpc.view<string>(vault, "get_owner", {}, upgradeAt - 1) : null;
    check("vault:owner", owner === dao, `vault owner just before the upgrade: ${owner} (recorded DAO ${dao})`);
  });

  // 4. The bytes the DAO stored are the code the proposal names; the proposal is the one voted on.
  let blob: Uint8Array | null = null;
  await section("blob", async () => {
    const fc = fcOf("store_blob");
    blob = fc?.method_name === "store_blob" ? base64ToBytes(fc.args) : null;
    const h = blob ? await codeHash(blob) : null;
    const ret = json(got.store_blob?.r?.status?.SuccessValue);
    check("blob", h === run?.code?.evil && ret === h, `store_blob bytes hash to ${h} (DAO returned ${ret}; recorded proposal hash ${run?.code?.evil})`);
  });
  let proposalId: number | null = null;
  let kind: any = null;
  await section("proposal:id", async () => {
    const ret = json(got.add_proposal?.r?.status?.SuccessValue);
    proposalId = Number.isSafeInteger(ret) ? ret : null;
    check("proposal:id", proposalId !== null && proposalId === run?.proposal_id, `add_proposal returned proposal id ${proposalId} (recorded ${run?.proposal_id})`);
  });
  await section("proposal:kind", async () => {
    const args = json(fcOf("add_proposal")?.args);
    kind = args?.proposal?.kind?.UpgradeRemote ?? null;
    check("proposal:kind", kind?.hash === run?.code?.evil && kind?.receiver_id === vault && kind?.method_name === upReceipt?.actions[0]?.FunctionCall?.method_name, `add_proposal: UpgradeRemote(${kind?.receiver_id}.${kind?.method_name}, ${kind?.hash})`);
  });
  const votes: Record<string, string> = {};
  for (const key of ["vote_1", "vote_2"] as const) {
    await section(`vote:${key}`, async () => {
      const fc = fcOf(key);
      const a = json(fc?.args);
      const execs = receiptsOf(got[key]?.r).some((x) => x.receiver === vault);
      // vote_1 must not have executed anything on the vault; vote_2 must have (checked in "upgrade").
      const ok = fc?.method_name === "act_proposal" && got[key]!.r.transaction.receiver_id === dao && a?.action === "VoteApprove" && proposalId !== null && a?.id === proposalId && (key === "vote_2" ? execs : !execs);
      if (ok) votes[key] = got[key]!.r.transaction.signer_id;
      check(`vote:${key}`, ok, `${key}: ${got[key]?.r?.transaction?.signer_id} → ${got[key]?.r?.transaction?.receiver_id}.${fc?.method_name}(id ${a?.id}, ${a?.action})${key === "vote_2" ? (execs ? ", executed the proposal" : ", did NOT reach the vault") : execs ? ", but it already reached the vault" : ", did not execute yet"} (proposal id from add_proposal: ${proposalId})`);
    });
  }
  await section("proposal:state", async () => {
    const p: any = upgradeAt && proposalId !== null ? await rpc.view(dao, "get_proposal", { id: proposalId }, upgradeAt) : null;
    const ok = p?.status === "Approved" && p?.proposer === got.add_proposal?.r?.transaction?.signer_id && p?.kind?.UpgradeRemote?.hash === run?.code?.evil && votes.vote_1 && votes.vote_2 && votes.vote_1 !== votes.vote_2 && p?.votes?.[votes.vote_1] === "Approve" && p?.votes?.[votes.vote_2] === "Approve";
    check("proposal:state", Boolean(ok), `DAO at block ${upgradeAt}: proposal #${p?.id} by ${p?.proposer} ${p?.status}, votes ${JSON.stringify(p?.votes ?? {})}`);
  });
  await section("diff", async () => {
    const honest = upgradeAt ? await rpc.viewCode(vault, upgradeAt - 1) : null;
    const d = honest && blob ? exportDiff(analyzeWasm(honest.code), analyzeWasm(blob)) : null;
    check("diff", honest?.hash === run?.code?.honest && Boolean(d?.addedMethods.includes("sweep")), `diff of live code (${honest?.hash}, block ${upgradeAt - 1}) vs the stored blob (re-derived now): + ${d?.addedMethods.join(", ") || "(none)"}; newly reachable: ${d?.newlyReachable.map((n) => `${n.capability}←${n.methods.join("/")}`).join(", ") || "(none)"}`);
  });

  // 4b. The TEE review the recording shows is the one the registry holds: the ai_review transaction's
  //     attest() arguments carry its model, "<risk>: <summary>", and the TEE receipt's hashes and
  //     signer; the id it returned is the recorded registry id; the registry's own record says the same.
  await section("review", async () => {
    const reviewsInAlerts = (run?.alerts ?? []).map((a: any) => a?.assessment?.review).filter((r: any) => r);
    if (!reviewRequired) {
      const ok = !txs.ai_review && reviewsInAlerts.length === 0;
      check("review", ok, ok ? "no TEE review in this recording, and no alert's grade used one" : `the recording has no review, but ${txs.ai_review ? "an ai_review transaction" : `${reviewsInAlerts.length} alert(s) graded with a review`}`);
      return;
    }
    const problems: string[] = [];
    const rec = review.receipt ?? {};
    const fc = fcOf("ai_review");
    const a = json(fc?.args);
    const att = a?.attestation ?? {};
    const expectSummary = `${review.risk}: ${review.summary}`.slice(0, 280);
    if (!got.ai_review) problems.push("no ai_review transaction on chain");
    if (a?.code_hash !== run?.code?.evil) problems.push(`attested code hash ${a?.code_hash} != proposed ${run?.code?.evil}`);
    if (att.kind !== "AiReview") problems.push(`attestation kind ${att.kind}`);
    if (att.verdict_summary !== expectSummary) problems.push(`on-chain verdict_summary "${String(att.verdict_summary).slice(0, 60)}…" != recorded "${expectSummary.slice(0, 60)}…"`);
    if (att.model !== review.model || rec.model !== review.model) problems.push(`on-chain model ${att.model} / receipt model ${rec.model} != recorded ${review.model}`);
    if (att.request_sha256 !== rec.request_hash || att.response_sha256 !== rec.response_hash) problems.push("on-chain request/response hashes != the recorded receipt's");
    if (att.signer !== rec.recovered_signer) problems.push(`on-chain TEE signer ${att.signer} != receipt ${rec.recovered_signer}`);
    if (att.chat_id !== String(rec.chat_id ?? "").slice(0, 200)) problems.push(`on-chain chat_id ${att.chat_id} != receipt ${rec.chat_id}`);
    const returned = json(got.ai_review?.r?.status?.SuccessValue);
    if (!Number.isSafeInteger(returned) || returned !== review.registry_id) problems.push(`attest() returned registry id ${returned} != recorded ${review.registry_id}`);
    // The registry's own record of that id, read at the block the attest receipt ran.
    const rc = receiptsOf(got.ai_review?.r).find((x) => x.receiver === KEYHOLE_REGISTRY.account && x.actions[0]?.FunctionCall?.method_name === "attest");
    const at = rc?.block && succeeded(rc.status) ? await heightOf(rc.block) : 0;
    const stored: any = at && Number.isSafeInteger(returned) ? await rpc.view(KEYHOLE_REGISTRY.account, "get_attestation", { id: returned }, at) : null;
    if (!stored || stored.id !== returned || stored.code_hash !== run?.code?.evil || stored.attester !== got.ai_review?.r?.transaction?.signer_id || stored.block_height !== at || canon(stored.attestation) !== canon(att)) problems.push(`registry get_attestation(${returned}) at block ${at} does not hold this attestation`);
    // The receipt itself verifies offline (the TEE signature over model:sha256(request):sha256(response)).
    const v = verifyReceiptOffline({ receipt: rec });
    if (!v.ok) problems.push(`TEE receipt does not verify offline: ${v.checks.join("; ")}`);
    // The review each alert was graded with is this one.
    for (const r of reviewsInAlerts) if (r.risk !== review.risk || r.summary !== review.summary || r.receipt_id !== rec.chat_id) problems.push(`an alert was graded with a different review (${r.risk}: ${String(r.summary).slice(0, 40)}…)`);
    if (problems.length === 0) derived.ai_review = { registry_id: returned, height: at };
    check("review", problems.length === 0, `TEE review (${review.model}): ${review.risk} — registry ${KEYHOLE_REGISTRY.account} AiReview #${returned} at block ${at} by ${stored?.attester ?? got.ai_review?.r?.transaction?.signer_id} carries the recorded model, "${review.risk}: …" summary and receipt hashes${problems.length ? ` · ${problems.join("; ")}` : ""}`);
  });

  // 4c. The guardian's verdict, re-derived: gradeUpgrade (packages/core) on the vault code before the
  //     upgrade (archival) and the store_blob bytes (on chain), with the review checked above. The
  //     verification inputs (reproducible build, SourceScan) are taken from the recording.
  await section("verdict", async () => {
    const alerts: any[] = Array.isArray(run?.alerts) ? run.alerts : [];
    const problems: string[] = [];
    if (!alerts.length) problems.push("the recording has no alerts");
    const honest = upgradeAt ? await rpc.viewCode(vault, upgradeAt - 1) : null;
    if (!honest || !blob) throw new Error("no live code or no stored blob to grade");
    const size = (blob as Uint8Array).length;
    const live = analyzeWasm(honest.code);
    const pending = analyzeWasm(blob);
    let first: ReturnType<typeof gradeUpgrade> | null = null;
    for (const [i, a] of alerts.entries()) {
      const as = a?.assessment;
      if (!as) {
        problems.push(`alert ${i} (${a?.event}) has no assessment`);
        continue;
      }
      if (as.target !== vault || as.live_hash !== honest.hash || as.pending_hash !== run?.code?.evil || as.pending_size !== size) problems.push(`alert ${i}: graded ${as.target} ${as.live_hash} → ${as.pending_hash} (${as.pending_size} bytes), not ${vault} ${honest.hash} → ${run?.code?.evil} (${size} bytes)`);
      const g = gradeUpgrade({ target: vault, live_hash: honest.hash, pending_hash: run?.code?.evil, live, pending, verified: as.verified, review: as.review ? { risk: as.review.risk, summary: as.review.summary } : null });
      first ??= g;
      if (canon(as.grade) !== canon(g)) problems.push(`alert ${i}: recorded grade ${as.grade?.verdict} [${(as.grade?.flags ?? []).join(" ")}] != re-derived ${g.verdict} [${g.flags.join(" ")}]`);
      if (a?.fired?.length && !g.fire) problems.push(`alert ${i} fired a hatch, but the re-derived grade does not fire`);
    }
    if (!alerts.some((a) => (a?.fired ?? []).some((f: any) => f?.ok && f?.tx === txs.hatch_fired))) problems.push("no alert records firing the hatch_fired transaction");
    const pend = run?.verdicts?.pending;
    if (!first) problems.push("nothing to compare verdicts.pending with");
    else if (canon({ verdict: pend?.verdict, flags: pend?.flags, headline: pend?.headline }) !== canon({ verdict: first.verdict, flags: first.flags, headline: first.headline })) problems.push(`verdicts.pending ${pend?.verdict} [${(pend?.flags ?? []).join(" ")}] != re-derived ${first.verdict} [${first.flags.join(" ")}]`);
    if (first && problems.length === 0) derived.grade = { verdict: first.verdict, flags: first.flags, headline: first.headline };
    const v = alerts[0]?.assessment?.verified;
    check("verdict", problems.length === 0, `guardian grade re-derived offline from the stored blob and the live code (${honest.hash}): ${first?.verdict ?? "?"} [${first?.flags.join(" ") ?? ""}], equal to all ${alerts.length} recorded alerts and verdicts.pending (verification inputs as recorded: reproducible ${v?.reproducible}, sourcescan ${v?.sourcescan})${problems.length ? ` · ${problems.join("; ")}` : ""}`);
  });

  // 5. The hatch: Alice's signature is valid, the chain ran exactly those bytes, and it paid her out.
  let withdrawAt = 0;
  await section("hatch:signature", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    const v = verifyHatch(hatch);
    const dh = decodeHatch(hatch);
    const ok = v.ok && dh.senderId === acc.alice && dh.receiverId === vault;
    check("hatch:signature", ok, `hatch signature valid: ${dh.senderId} → ${dh.receiverId}.${dh.actions.map((a) => a.method).join(",")} deposit ${dh.actions[0]?.deposit} yocto, max block ${dh.maxBlockHeight}${v.ok ? "" : ` · ${v.checks.filter((c) => c.startsWith("FAIL")).join("; ")}`}${dh.senderId === acc.alice ? "" : ` · sender is not ${acc.alice}`}${dh.receiverId === vault ? "" : ` · receiver is not ${vault}`}`);
  });
  // The hatch was armed when the recording says: its key was added to Alice by an AddKey transaction
  // found from the key's first nonce, at or before created_height, and created_height is before the
  // hatch fired (and before the proposal, when the recording says the hatch was armed first).
  await section("hatch:created", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    const created = Number(hatch.created_height);
    const problems: string[] = [];
    const atCreated = Number.isSafeInteger(created) && created > 0 ? await keyAt(hatch.account, hatch.public_key, created) : null;
    const expectNonce = BigInt(hatch.nonce ?? 0) - 1n;
    if (!atCreated) problems.push(`no key ${hatch.public_key} on ${hatch.account} at created_height ${hatch.created_height}`);
    else {
      if (atCreated.permission !== "FullAccess") problems.push("the key was not a full-access key at created_height");
      if (BigInt(atCreated.nonce) !== expectNonce) problems.push(`key nonce at created_height ${atCreated.nonce} != hatch nonce - 1 (${expectNonce}): not the state the hatch was signed in`);
    }
    // The key's first nonce names the block its AddKey ran in (NEAR: (H - 1) * 1e6); find it there.
    let addTx: string | null = null;
    let addAt = 0;
    if (expectNonce > 0n && expectNonce % ACCESS_KEY_NONCE_MULTIPLIER === 0n) {
      const h = Number(expectNonce / ACCESS_KEY_NONCE_MULTIPLIER) + 1;
      const before = await keyAt(hatch.account, hatch.public_key, h - 1);
      const after = await keyAt(hatch.account, hatch.public_key, h);
      if (before || !after || BigInt(after.nonce) !== expectNonce) problems.push(`the key is not absent at ${h - 1} and present with nonce ${expectNonce} at ${h}`);
      const b: any = await rpc.block({ block_id: h });
      for (const c of b?.chunks ?? []) {
        const ch: any = await rpc.call("chunk", { block_id: h, shard_id: c.shard_id });
        const t = (ch?.transactions ?? []).find((x: any) => x.signer_id === hatch.account && x.receiver_id === hatch.account && x.actions?.length === 1 && x.actions[0]?.AddKey?.public_key === hatch.public_key);
        if (t) {
          addTx = t.hash;
          break;
        }
      }
      if (addTx) {
        const r: any = await rpc.call("EXPERIMENTAL_tx_status", { tx_hash: addTx, sender_account_id: hatch.account, wait_until: "FINAL" });
        // signer == receiver, so the action receipt is local: not listed in `receipts`, but its outcome
        // (the transaction's first receipt) says where it ran.
        const add = only(r, "AddKey");
        const first = r?.transaction_outcome?.outcome?.receipt_ids?.[0];
        const ro = (r?.receipts_outcome ?? []).find((o: any) => o.id === first);
        const isAdd = r?.transaction?.signer_id === hatch.account && r?.transaction?.receiver_id === hatch.account && add?.public_key === hatch.public_key && add?.access_key?.permission === "FullAccess";
        if (!isAdd) problems.push(`${addTx} is not a single full-access AddKey of ${hatch.public_key} by ${hatch.account} to itself`);
        addAt = isAdd && ro?.block_hash && ro.outcome?.executor_id === hatch.account && succeeded(ro.outcome?.status) && !failed(r) ? await heightOf(ro.block_hash) : 0;
        // The rule, checked against the chain: the AddKey receipt's block gives the key's first nonce.
        if (!addAt || BigInt(addAt - 1) * ACCESS_KEY_NONCE_MULTIPLIER !== expectNonce) problems.push(`AddKey ${addTx} ran at block ${addAt}, which does not give first nonce ${expectNonce}`);
      } else problems.push(`no AddKey of ${hatch.public_key} by ${hatch.account} in block ${h}`);
    } else problems.push(`first key nonce ${expectNonce} is not a multiple of 1e6: the key had signed something before the hatch`);
    if (addAt && !(addAt <= created)) problems.push(`AddKey at ${addAt} is after created_height ${created}`);
    const fired = got.hatch_fired?.height ?? 0;
    if (!(fired > 0 && created < fired)) problems.push(`created_height ${hatch.created_height} is not before the hatch fired (block ${fired})`);
    const titles: string[] = (run?.steps ?? []).map((x: any) => String(x?.title ?? ""));
    const armStep = titles.findIndex((t) => /arms an escape hatch/i.test(t));
    const proposeStep = titles.findIndex((t) => /proposes UpgradeRemote/i.test(t));
    const armedFirst = armStep >= 0 && proposeStep >= 0 && armStep < proposeStep;
    const proposed = got.add_proposal?.height ?? 0;
    if (armedFirst && !(proposed > 0 && created < proposed)) problems.push(`the recording says the hatch was armed before the proposal, but created_height ${hatch.created_height} is not before add_proposal (block ${proposed})`);
    if (problems.length === 0 && addTx) derived.hatch_key = { add_tx: addTx, add_height: addAt, initial_nonce: expectNonce.toString() };
    check("hatch:created", problems.length === 0, `hatch armed at block ${hatch.created_height}: key ${hatch.public_key.slice(0, 16)}… added by ${addTx ?? "(not found)"} at block ${addAt} (first nonce ${expectNonce} = (${addAt} - 1) * 1e6), unused at ${hatch.created_height}; before the hatch fired (${fired})${armedFirst ? ` and before add_proposal (${proposed})` : ""}${problems.length ? ` · ${problems.join("; ")}` : ""}`);
  });
  await section("hatch:onchain", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    const del = only(got.hatch_fired?.r, "Delegate");
    const onchain = del ? signedDelegateFromView(del) : null;
    const same = onchain !== null && onchain === hatch.signed_delegate;
    // Belt and braces: the bytes the chain ran also verify as this hatch.
    const v = onchain ? verifyHatch({ ...hatch, signed_delegate: onchain }) : null;
    check("hatch:onchain", same && Boolean(v?.ok), `guardian tx ${txs.hatch_fired} carries the signed delegate byte for byte (${same ? "identical" : "DIFFERENT"}: sender ${del?.delegate_action?.sender_id}, nonce ${del?.delegate_action?.nonce}, max block ${del?.delegate_action?.max_block_height}, signature ${String(del?.signature).slice(0, 20)}…; relayed by ${got.hatch_fired?.r?.transaction?.signer_id})`);
  });
  let refund: bigint | null = null;
  await section("hatch:withdraw", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    const recs = receiptsOf(got.hatch_fired?.r);
    const w = recs.find((x) => x.predecessor === hatch.account && x.receiver === vault && x.actions.length === 1 && x.actions[0]?.FunctionCall?.method_name === hatch.method);
    withdrawAt = w?.block && succeeded(w.status) ? await heightOf(w.block) : 0;
    const paid = recs.find((x) => x.predecessor === vault && x.receiver === hatch.account && x.actions.some((a) => a?.Transfer));
    refund = paid ? BigInt(paid.actions.find((a) => a?.Transfer).Transfer.deposit) : null;
    const code = withdrawAt ? (await rpc.viewAccount(vault, withdrawAt)).code_hash : null;
    check("hatch:withdraw", withdrawAt > 0 && refund !== null && refund > 0n && paid?.receiver === hatch.account && code === run?.code?.honest, `${hatch.account}.${hatch.method} ran on ${vault} at block ${withdrawAt} (vault code then: ${code}) and paid ${refund} yocto back to ${paid?.receiver}`);
  });
  // What moved is what she had: her balance in the block before the withdraw (archival), whatever
  // deposits made it up, and the vault total fell by the same amount.
  await section("hatch:balance", async () => {
    if (!hatch || !withdrawAt) throw new Error("no withdraw receipt");
    const before = await balanceAt(hatch.account, withdrawAt - 1);
    const after = await balanceAt(hatch.account, withdrawAt);
    const tBefore = await totalAt(withdrawAt - 1);
    const tAfter = await totalAt(withdrawAt);
    figures.alice_refund = refund === null ? null : String(refund);
    figures.vault_total_before_fire = String(tBefore);
    figures.vault_total_after_fire = String(tAfter);
    check("hatch:balance", refund !== null && before === refund && after === 0n && tBefore - tAfter === refund, `${hatch.account}'s vault balance: ${before} at block ${withdrawAt - 1} → ${after} at ${withdrawAt}; paid out ${refund}; vault total ${tBefore} → ${tAfter}`);
  });

  // 6. Order: the hatch's withdraw ran before the block in which the upgrade replaced the code.
  await section("order", async () => {
    const fired = got.hatch_fired?.height ?? 0;
    const vote = got.vote_2?.height ?? 0;
    const ok = withdrawAt > 0 && upgradeAt > 0 && withdrawAt < upgradeAt && fired > 0 && vote > 0 && fired < vote;
    check("order", ok, `hatch at block ${fired} < deciding vote at block ${vote} (${vote - fired} blocks earlier); Alice's withdraw ran at ${withdrawAt}, the new code landed at ${upgradeAt}`);
  });

  // 7. The sweep took what was left (the vault total in the block before it, Bob's balance included)
  //    to the recorded address.
  let sweptAt = 0;
  await section("sweep", async () => {
    const recs = receiptsOf(got.sweep?.r);
    const s = recs.find((x) => x.receiver === vault && x.actions[0]?.FunctionCall?.method_name === "sweep");
    sweptAt = s?.block && succeeded(s.status) ? await heightOf(s.block) : 0;
    const out = recs.find((x) => x.predecessor === vault && x.actions.some((a) => a?.Transfer));
    const amount = out ? BigInt(out.actions.find((a) => a?.Transfer).Transfer.deposit) : null;
    const before = sweptAt ? await totalAt(sweptAt - 1) : null;
    const after = sweptAt ? await totalAt(sweptAt) : null;
    const bob = sweptAt ? await balanceAt(acc.bob, sweptAt - 1) : null;
    figures.swept = amount === null ? null : String(amount);
    figures.bob_in_vault_before_sweep = bob === null ? null : String(bob);
    const ok = sweptAt > upgradeAt && upgradeAt > 0 && out?.receiver === acc.sweepTo && amount !== null && amount === before && after === 0n && bob !== null && bob > 0n && bob <= amount;
    check("sweep", ok, `sweep at block ${sweptAt}: vault total ${before} → ${after}; sent ${amount} yocto to ${out?.receiver} (recorded ${acc.sweepTo}); Bob had ${bob} of it in the vault at block ${sweptAt - 1}`);
  });

  // 7b. The amounts the site shows for this run are the ones the chain moved.
  await section("figures", async () => {
    figures.alice_deposit = deposited.alice === null ? null : String(deposited.alice);
    figures.bob_deposit = deposited.bob === null ? null : String(deposited.bob);
    const keys = Object.keys(SITE_FIGURES) as (keyof typeof SITE_FIGURES)[];
    const off = keys.filter((k) => figures[k] !== String(SITE_FIGURES[k]));
    const near = (y: string | null) => (y === null ? "?" : (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(2));
    check("figures", off.length === 0, `amounts the site shows match the chain: Alice deposited ${near(figures.alice_deposit)} NEAR and got ${near(figures.alice_refund)} back; Bob deposited ${near(figures.bob_deposit)} and had ${near(figures.bob_in_vault_before_sweep)} in the vault when ${near(figures.swept)} was swept; vault total ${near(figures.vault_total_before_fire)} → ${near(figures.vault_total_after_fire)} at the hatch${off.length ? ` · differ from the site: ${off.map((k) => `${k} ${figures[k]} != ${SITE_FIGURES[k]}`).join("; ")}` : ""}`);
  });

  // 8. What the recording reports about the run agrees with the chain-derived values above.
  await section("recording", async () => {
    const aliceAfterSweep = sweptAt && hatch ? await rpc.view<string>(vault, "get_balance", { account_id: hatch.account }, sweptAt) : null;
    const totalAfter = sweptAt ? await rpc.view<string>(vault, "get_total", {}, sweptAt) : null;
    const aliceAfterFire = withdrawAt && hatch ? await rpc.view<string>(vault, "get_balance", { account_id: hatch.account }, withdrawAt) : null;
    const problems: string[] = [];
    const b = run?.balances ?? {};
    if (b.alice_in_vault_after_fire !== aliceAfterFire) problems.push(`balances.alice_in_vault_after_fire ${b.alice_in_vault_after_fire} != ${aliceAfterFire}`);
    if (b.vault_total_after_sweep !== totalAfter) problems.push(`balances.vault_total_after_sweep ${b.vault_total_after_sweep} != ${totalAfter}`);
    if (b.alice_vault_entry_after_sweep !== aliceAfterSweep) problems.push(`balances.alice_vault_entry_after_sweep ${b.alice_vault_entry_after_sweep} != ${aliceAfterSweep}`);
    const o = run?.outcome ?? {};
    const derived = { alice_safe: aliceAfterFire === "0", bob_swept: totalAfter === "0", fired_before_execution: withdrawAt > 0 && withdrawAt < upgradeAt };
    for (const [k, v] of Object.entries(derived)) if (o[k] !== v) problems.push(`outcome.${k} ${o[k]} != ${v}`);
    for (const a of run?.alerts ?? []) {
      const cs = a?.assessment?.code_source;
      if (a?.event === "proposal" && a?.proposal_id !== proposalId) problems.push(`alert proposal_id ${a?.proposal_id} != ${proposalId}`);
      if (cs && (cs.tx !== txs.store_blob || cs.height !== got.store_blob?.height)) problems.push(`alert code_source ${cs.tx}@${cs.height} != store_blob`);
      for (const f of a?.fired ?? []) if (f?.tx !== txs.hatch_fired) problems.push(`alert fired tx ${f?.tx} != hatch_fired`);
    }
    if (got.ai_review && !(got.ai_review.height < upgradeAt)) problems.push(`ai_review at ${got.ai_review.height} is not before the upgrade at ${upgradeAt}`);
    check("recording", problems.length === 0, `recorded balances, outcome and alerts match the chain${got.ai_review ? `; AiReview posted at block ${got.ai_review.height}, before the upgrade` : ""}${problems.length ? ` · ${problems.join("; ")}` : ""}`);
  });

  // Every required check ran (a code path that skips one is a FAIL, not a smaller pass).
  const ran = new Set(checks.map((c) => c.id));
  const notRun = REQUIRED_CHECKS.filter((id) => !ran.has(id));
  if (notRun.length) check("complete", false, `checks that did not run: ${notRun.join(", ")}`);
  const bad = checks.filter((c) => !c.ok).length;
  log(bad ? `\n${bad} of ${checks.length} checks FAILED` : `\nall ${checks.length} checks passed: the recording matches the chain`);
  derived.upgrade_height = upgradeAt || null;
  derived.withdraw_height = withdrawAt || null;
  return { ok: bad === 0, checks, derived };
}

/** The replay lines `npm run judge` (check 8) shows: one per thing its title claims, plus the summary.
 *  `missing` lists the prefixes with no matching `ok` line; the check fails unless it is empty. */
export const JUDGE_REPLAY_LINES = ["ok  recording has every required step", "ok  store_blob bytes", "ok  diff", "ok  guardian grade re-derived", "ok  TEE review", "ok  hatch signature valid", "ok  hatch armed at block", "ok  guardian tx", "ok  deciding vote", "ok  hatch at block", "ok  sweep at block", "ok  amounts the site shows"] as const;
export function pickReplayLines(lines: string[]): { shown: string[]; missing: string[]; summary: string; passed: boolean } {
  const trimmed = lines.map((l) => l.trim());
  const shown: string[] = [];
  const missing: string[] = [];
  for (const p of JUDGE_REPLAY_LINES) {
    const l = trimmed.find((x) => x.startsWith(p));
    if (l) shown.push(l);
    else missing.push(p);
  }
  const summary = [...trimmed].reverse().find((l) => l.length > 0) ?? "";
  return { shown, missing, summary, passed: /^all \d+ checks passed/.test(summary) && !trimmed.some((l) => l.startsWith("XX")) };
}
