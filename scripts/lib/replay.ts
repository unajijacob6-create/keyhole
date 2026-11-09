// Re-check a recorded Keyhole Guardian run (data/guardian-run.json) against public testnet archival
// RPC, with no keys. Nothing is taken from the recording on trust except the transaction hashes:
// every claim below is re-derived from chain data.
import fs from "node:fs";
import { analyzeWasm, ARCHIVAL_RPC, base64ToBytes, codeHash, exportDiff, Rpc } from "../../packages/core/src/index.ts";
import { decodeHatch, verifyHatch, type Hatch } from "../../packages/hatch/src/index.ts";

type Check = { ok: boolean; text: string };

const fcActions = (tx: any) => (tx.transaction.actions as any[]).filter((a) => a && typeof a === "object" && "FunctionCall" in a).map((a) => a.FunctionCall);

function failed(outcome: any): string | null {
  const st = outcome?.status;
  if (st && typeof st === "object" && "Failure" in st) return JSON.stringify(st.Failure).slice(0, 200);
  for (const r of outcome?.receipts_outcome ?? []) {
    const s = r.outcome?.status;
    if (s && typeof s === "object" && "Failure" in s) return JSON.stringify(s.Failure).slice(0, 200);
  }
  return null;
}

export async function replayGuardianRun(file: string, opts: { rpc?: Rpc; log?: (s: string) => void } = {}): Promise<boolean> {
  const log = opts.log ?? ((s: string) => console.log(s));
  if (!fs.existsSync(file)) {
    log(`no recording at ${file}: run npm run demo:guardian (live, testnet keys) first`);
    return false;
  }
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  const rpc = opts.rpc ?? new Rpc({ network: "testnet", url: ARCHIVAL_RPC.testnet });
  const checks: Check[] = [];
  const check = (ok: boolean, text: string) => {
    checks.push({ ok, text });
    log(`  ${ok ? "ok " : "XX "} ${text}`);
  };
  const signers: Record<string, string> = run.signers ?? {};
  const tx = async (key: string) => {
    const hash = run.tx?.[key];
    if (!hash) return null;
    const r: any = await rpc.call("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signers[key], wait_until: "FINAL" });
    const height = ((await rpc.block({ block_id: r.transaction_outcome.block_hash })) as any).header.height as number;
    return { r, height };
  };

  log(`Replaying ${file} (recorded ${run.recordedAt}) against ${rpc.url}`);
  log(`DAO ${run.dao} · vault ${run.vault}`);

  // 1. Every recorded transaction exists and succeeded.
  const got: Record<string, { r: any; height: number } | null> = {};
  for (const key of Object.keys(run.tx ?? {})) {
    got[key] = await tx(key);
    const f = got[key] ? failed(got[key]!.r) : "not found";
    check(!f, `${key}: ${run.tx[key]} ${f ? `FAILED ${f}` : `succeeded at block ${got[key]!.height}`}`);
  }

  // 2. The bytes the DAO stored are the code the proposal names, and they add a drain.
  const store = got.store_blob?.r;
  const blobArgs = store ? fcActions(store).find((a) => a.method_name === "store_blob")?.args : null;
  const blob = blobArgs ? base64ToBytes(blobArgs) : null;
  const blobHash = blob ? await codeHash(blob) : null;
  check(blobHash === run.code.evil, `store_blob bytes hash to ${blobHash} (proposal hash ${run.code.evil})`);
  const add = got.add_proposal?.r;
  const addArgs = add ? JSON.parse(new TextDecoder().decode(base64ToBytes(fcActions(add)[0].args))) : null;
  const kind = addArgs?.proposal?.kind?.UpgradeRemote;
  check(kind?.hash === run.code.evil && kind?.receiver_id === run.vault, `add_proposal: UpgradeRemote(${kind?.receiver_id}.${kind?.method_name}, ${kind?.hash})`);
  if (blob && got.deploy_vault) {
    const honest = await rpc.viewCode(run.vault, got.deploy_vault.height + 2);
    const d = exportDiff(analyzeWasm(honest.code), analyzeWasm(blob));
    check(d.addedMethods.includes("sweep"), `diff of live code vs the stored blob (re-derived now): + ${d.addedMethods.join(", ") || "(none)"}; newly reachable: ${d.newlyReachable.map((n) => `${n.capability}←${n.methods.join("/")}`).join(", ") || "(none)"}`);
  }

  // 3. The hatch is exactly what Alice signed, and the guardian submitted it unchanged.
  const hatch: Hatch | null = run.hatch;
  if (hatch) {
    const v = verifyHatch(hatch);
    const dh = decodeHatch(hatch);
    check(v.ok, `hatch signature valid: ${dh.senderId} → ${dh.receiverId}.${dh.actions.map((a) => a.method).join(",")} deposit ${dh.actions[0]?.deposit} yocto, max block ${dh.maxBlockHeight}`);
    const fired = got.hatch_fired?.r;
    const del = fired ? (fired.transaction.actions as any[]).find((a) => a && typeof a === "object" && "Delegate" in a)?.Delegate : null;
    check(Boolean(del) && del.delegate_action?.sender_id === dh.senderId && del.delegate_action?.receiver_id === dh.receiverId && String(del.delegate_action?.nonce) === String(dh.nonce) && del.delegate_action?.public_key === hatch.public_key, `guardian tx ${run.tx.hatch_fired} carries that signed delegate (sender ${del?.delegate_action?.sender_id}, nonce ${del?.delegate_action?.nonce}, signer ${fired?.transaction?.signer_id})`);
    if (got.hatch_fired) {
      const after = await rpc.view<string>(run.vault, "get_balance", { account_id: dh.senderId }, got.hatch_fired.height + 3);
      check(after === "0", `${dh.senderId}'s vault balance 3 blocks after the hatch: ${after}`);
    }
  }

  // 4. Order: the hatch landed before the vote that executed the upgrade.
  const firedAt = got.hatch_fired?.height ?? 0;
  const execAt = got.vote_2?.height ?? 0;
  check(firedAt > 0 && execAt > 0 && firedAt < execAt, `hatch at block ${firedAt} < deciding vote at block ${execAt} (${execAt - firedAt} blocks earlier)`);
  if (got.vote_2) {
    const codeAfter = (await rpc.viewAccount(run.vault, execAt + 3)).code_hash;
    check(codeAfter === run.code.evil, `vault code 3 blocks after the deciding vote: ${codeAfter}`);
  }
  if (got.sweep) {
    const total = await rpc.view<string>(run.vault, "get_total", {}, got.sweep.height + 3);
    check(total === "0", `vault total after sweep: ${total}`);
  }
  const bad = checks.filter((c) => !c.ok).length;
  log(bad ? `\n${bad} of ${checks.length} checks FAILED` : `\nall ${checks.length} checks passed: the recording matches the chain`);
  return bad === 0;
}
