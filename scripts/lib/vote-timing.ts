// Find the vote that executed a Sputnik DAO proposal: the act_proposal(VoteApprove, id) transaction
// whose receipts reach the proposal's target. Used by judge check 10 to show that a proposal's
// bytes were on chain (store_blob) before the vote that ran them.
import { base64ToBytes, type TxApi } from "../../packages/core/src/index.ts";

export interface ExecutingVote {
  tx: string;
  signer: string;
  /** Block of the vote transaction. */
  txHeight: number;
  /** First block in which a receipt of the vote executed on the target. */
  execHeight: number;
}

const TX_BATCH = 20;

function decodeArgs(b64: string | undefined): any {
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(b64 ?? "")));
  } catch {
    return null;
  }
}

/** Walks `dao`'s transactions newest first (at most `maxPages` pages of the tx index). */
export async function findExecutingVote(opts: { api: TxApi; dao: string; id: number; target: string; maxPages?: number }): Promise<ExecutingVote | null> {
  const maxPages = opts.maxPages ?? 8;
  let resume: unknown = undefined;
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { account_id: opts.dao, is_real_receiver: true };
    if (resume !== undefined && resume !== null) body.resume_token = resume;
    const r = await opts.api("/v0/account", body);
    const entries: any[] = (r?.account_txs ?? []).filter((t: any) => t?.is_success !== false && !seen.has(t.transaction_hash));
    entries.forEach((t) => seen.add(t.transaction_hash));
    const height = new Map(entries.map((t) => [t.transaction_hash as string, Number(t.tx_block_height)]));
    for (let i = 0; i < entries.length; i += TX_BATCH) {
      const d = await opts.api("/v0/transactions", { tx_hashes: entries.slice(i, i + TX_BATCH).map((t) => t.transaction_hash) });
      for (const t of d?.transactions ?? []) {
        const tx = t?.transaction;
        if (tx?.receiver_id !== opts.dao) continue;
        const fc = (tx.actions ?? []).length === 1 ? tx.actions[0]?.FunctionCall : null;
        if (fc?.method_name !== "act_proposal") continue;
        const a = decodeArgs(fc.args);
        if (a?.id !== opts.id || a?.action !== "VoteApprove") continue;
        const onTarget = (t.receipts ?? []).filter((x: any) => x?.receipt?.receiver_id === opts.target).map((x: any) => Number(x?.execution_outcome?.block_height));
        if (!onTarget.length) continue;
        return { tx: tx.hash, signer: tx.signer_id, txHeight: height.get(tx.hash) ?? Number(t?.execution_outcome?.block_height ?? 0), execHeight: Math.min(...onTarget) };
      }
    }
    resume = r?.resume_token;
    if (!entries.length && !(r?.account_txs ?? []).length) break;
    if (resume === undefined || resume === null) break;
  }
  return null;
}
