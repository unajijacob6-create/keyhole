// Re-check a recorded Keyhole Guardian run (data/guardian-run.json) against public testnet archival
// RPC, with no keys. The recording supplies transaction hashes; everything else it says (who signed,
// which contract was called, the heights, the proposal id, the code hashes, the signed hatch, the
// balances) is compared with what the chain says, and a mismatch is a FAIL. Every step a Guardian run
// records is required: a recording with a step left out fails instead of running fewer checks.
import fs from "node:fs";
import { serialize } from "borsh";
import { SCHEMA } from "near-api-js";
import { analyzeWasm, ARCHIVAL_RPC, base58, base64ToBytes, bytesToBase64, codeHash, exportDiff, KEYHOLE_REGISTRY, Rpc } from "../../packages/core/src/index.ts";
import { decodeHatch, verifyHatch, type Hatch } from "../../packages/hatch/src/index.ts";

type Check = { id: string; ok: boolean; text: string };

/** Steps every Guardian run records (scripts/demo-guardian.ts). `ai_review` is posted only when the
 *  private TEE review ran, so it is checked when present. */
export const REQUIRED_STEPS = ["deploy_vault", "init_vault", "delete_vault_key", "alice_deposit", "bob_deposit", "store_blob", "add_proposal", "hatch_fired", "vote_1", "vote_2", "sweep"] as const;
export const OPTIONAL_STEPS = ["ai_review"] as const;

/** Check ids that must all have run for a replay to pass (a step check per required step, plus these). */
export const REQUIRED_CHECKS = [
  "steps",
  ...REQUIRED_STEPS.map((k) => `step:${k}`),
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
  "hatch:signature",
  "hatch:onchain",
  "hatch:withdraw",
  "hatch:balance",
  "order",
  "sweep",
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

  log(`Replaying ${opts.label ?? "recording"} (recorded ${run?.recordedAt}) against ${rpc.url}`);
  log(`DAO ${dao} · vault ${vault}`);

  // 1. Every required step is in the recording; nothing unknown is.
  const known = new Set<string>([...REQUIRED_STEPS, ...OPTIONAL_STEPS]);
  const missing = REQUIRED_STEPS.filter((k) => !txs[k]);
  const unknown = Object.keys(txs).filter((k) => !known.has(k));
  check("steps", missing.length === 0 && unknown.length === 0 && run?.network === "testnet" && Boolean(hatch), `recording has every required step (${REQUIRED_STEPS.length}${txs.ai_review ? " + ai_review" : ""})${missing.length ? `; MISSING ${missing.join(", ")}` : ""}${unknown.length ? `; unknown ${unknown.join(", ")}` : ""}${hatch ? "" : "; MISSING hatch"}${run?.network === "testnet" ? "" : `; network ${run?.network}`}`);

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

  // 5. The hatch: Alice's signature is valid, the chain ran exactly those bytes, and it paid her out.
  let withdrawAt = 0;
  let aliceDeposit: bigint | null = null;
  await section("hatch:signature", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    const v = verifyHatch(hatch);
    const dh = decodeHatch(hatch);
    const ok = v.ok && dh.senderId === acc.alice && dh.receiverId === vault;
    check("hatch:signature", ok, `hatch signature valid: ${dh.senderId} → ${dh.receiverId}.${dh.actions.map((a) => a.method).join(",")} deposit ${dh.actions[0]?.deposit} yocto, max block ${dh.maxBlockHeight}${v.ok ? "" : ` · ${v.checks.filter((c) => c.startsWith("FAIL")).join("; ")}`}${dh.senderId === acc.alice ? "" : ` · sender is not ${acc.alice}`}${dh.receiverId === vault ? "" : ` · receiver is not ${vault}`}`);
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
  await section("hatch:withdraw", async () => {
    if (!hatch) throw new Error("no hatch in the recording");
    aliceDeposit = BigInt(fcOf("alice_deposit")?.deposit ?? -1);
    const recs = receiptsOf(got.hatch_fired?.r);
    const w = recs.find((x) => x.predecessor === hatch.account && x.receiver === vault && x.actions.length === 1 && x.actions[0]?.FunctionCall?.method_name === hatch.method);
    withdrawAt = w?.block && succeeded(w.status) ? await heightOf(w.block) : 0;
    const paid = recs.find((x) => x.predecessor === vault && x.receiver === hatch.account && x.actions.some((a) => a?.Transfer));
    const amount = paid ? BigInt(paid.actions.find((a) => a?.Transfer).Transfer.deposit) : null;
    const code = withdrawAt ? (await rpc.viewAccount(vault, withdrawAt)).code_hash : null;
    check("hatch:withdraw", withdrawAt > 0 && amount === aliceDeposit && code === run?.code?.honest, `${hatch.account}.${hatch.method} ran on ${vault} at block ${withdrawAt} (vault code then: ${code}) and paid ${amount} yocto back to ${paid?.receiver} (deposited ${aliceDeposit})`);
  });
  await section("hatch:balance", async () => {
    if (!hatch || !withdrawAt) throw new Error("no withdraw receipt");
    const before = await rpc.view<string>(vault, "get_balance", { account_id: hatch.account }, withdrawAt - 1);
    const after = await rpc.view<string>(vault, "get_balance", { account_id: hatch.account }, withdrawAt);
    check("hatch:balance", before === String(aliceDeposit) && after === "0", `${hatch.account}'s vault balance: ${before} at block ${withdrawAt - 1} → ${after} at ${withdrawAt}`);
  });

  // 6. Order: the hatch's withdraw ran before the block in which the upgrade replaced the code.
  await section("order", async () => {
    const fired = got.hatch_fired?.height ?? 0;
    const vote = got.vote_2?.height ?? 0;
    const ok = withdrawAt > 0 && upgradeAt > 0 && withdrawAt < upgradeAt && fired > 0 && vote > 0 && fired < vote;
    check("order", ok, `hatch at block ${fired} < deciding vote at block ${vote} (${vote - fired} blocks earlier); Alice's withdraw ran at ${withdrawAt}, the new code landed at ${upgradeAt}`);
  });

  // 7. The sweep took what was left (Bob's deposit) to the recorded address.
  let sweptAt = 0;
  await section("sweep", async () => {
    const bobDeposit = BigInt(fcOf("bob_deposit")?.deposit ?? -1);
    const recs = receiptsOf(got.sweep?.r);
    const s = recs.find((x) => x.receiver === vault && x.actions[0]?.FunctionCall?.method_name === "sweep");
    sweptAt = s?.block && succeeded(s.status) ? await heightOf(s.block) : 0;
    const out = recs.find((x) => x.predecessor === vault && x.actions.some((a) => a?.Transfer));
    const amount = out ? BigInt(out.actions.find((a) => a?.Transfer).Transfer.deposit) : null;
    const before = sweptAt ? await rpc.view<string>(vault, "get_total", {}, sweptAt - 1) : null;
    const after = sweptAt ? await rpc.view<string>(vault, "get_total", {}, sweptAt) : null;
    const ok = sweptAt > upgradeAt && upgradeAt > 0 && out?.receiver === acc.sweepTo && amount === bobDeposit && before === String(bobDeposit) && after === "0";
    check("sweep", ok, `sweep at block ${sweptAt}: vault total ${before} → ${after}; sent ${amount} yocto to ${out?.receiver} (recorded ${acc.sweepTo}; Bob deposited ${bobDeposit})`);
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
  return bad === 0;
}

/** The replay lines `npm run judge` (check 8) shows: one per thing its title claims, plus the summary.
 *  `missing` lists the prefixes with no matching `ok` line; the check fails unless it is empty. */
export const JUDGE_REPLAY_LINES = ["ok  recording has every required step", "ok  store_blob bytes", "ok  diff", "ok  hatch signature valid", "ok  guardian tx", "ok  deciding vote", "ok  hatch at block", "ok  sweep at block"] as const;
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
