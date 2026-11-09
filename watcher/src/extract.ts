// Pure extraction of code- and key-changing actions from a neardata block. Works from *executed
// receipts* (receipt_execution_outcomes), which is where every action actually takes effect:
// direct transactions, meta-transactions (Delegate) and contract self-upgrades through an
// `upgrade` method all end up there. Only successful receipts count.
import bs58 from "bs58";

export type WatchKind = "DeployContract" | "DeployGlobalContract" | "UseGlobalContract" | "AddFullAccessKey" | "DeleteKey" | "DeleteAccount";

export interface WatchEvent {
  kind: WatchKind;
  account: string; // receiver whose code/keys changed
  predecessor: string;
  signer: string | null;
  /** How the action got there: a plain transaction, a meta-transaction (Delegate), or a contract
   *  creating the action in a receipt (e.g. an `upgrade` method calling deploy on itself). */
  origin: "transaction" | "meta-transaction" | "contract-receipt" | "unknown";
  newHash?: string; // DeployContract / DeployGlobalContract: base58 sha256 of the new code
  global?: { by: "hash" | "account"; ref: string };
  publicKey?: string;
  height: number;
  timestampMs: number;
  txHash: string | null;
  receiptId: string;
}

export interface TxSummary {
  signer: string;
  receiver: string;
  /** Top-level action kinds, e.g. ["DeployContract"] or ["Delegate"]. */
  kinds: string[];
  /** For Delegate: inner receiver and action kinds. */
  delegate?: { sender: string; receiver: string; kinds: string[] };
}

const kindOf = (a: unknown) => (typeof a === "string" ? a : Object.keys(a as object)[0]);
const b64hash = (b64: string) => bs58.encode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

/** Transactions included in this block, by hash, for classifying receipts (keep a few blocks). */
export function summarizeTransactions(block: any): Map<string, TxSummary> {
  const out = new Map<string, TxSummary>();
  for (const s of block?.shards ?? []) {
    for (const t of s.chunk?.transactions ?? []) {
      const tx = t.transaction;
      const kinds = (tx.actions ?? []).map(kindOf);
      const del = (tx.actions ?? []).find((a: any) => a?.Delegate || a?.DelegateV2);
      const d = del ? (del.Delegate ?? del.DelegateV2).delegate_action : null;
      out.set(tx.hash, { signer: tx.signer_id, receiver: tx.receiver_id, kinds, ...(d ? { delegate: { sender: d.sender_id, receiver: d.receiver_id, kinds: (d.actions ?? []).map((x: any) => kindOf(x)) } } : {}) });
    }
  }
  return out;
}

function succeeded(status: any): boolean {
  return Boolean(status && (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined));
}

export function extractEvents(block: any, recentTxs: Map<string, TxSummary> = new Map()): WatchEvent[] {
  const height: number = block.block.header.height;
  const timestampMs = Number(BigInt(block.block.header.timestamp_nanosec ?? block.block.header.timestamp) / 1_000_000n);
  const txs = new Map([...recentTxs, ...summarizeTransactions(block)]);
  const events: WatchEvent[] = [];
  for (const s of block.shards ?? []) {
    for (const o of s.receipt_execution_outcomes ?? []) {
      const r = o.receipt;
      const action = r?.receipt?.Action;
      if (!action || !succeeded(o.execution_outcome?.outcome?.status)) continue;
      const tx = o.tx_hash ? txs.get(o.tx_hash) : undefined;
      const originFor = (k: string): WatchEvent["origin"] => {
        if (tx) {
          if (tx.delegate && tx.delegate.receiver === r.receiver_id && tx.delegate.kinds.includes(k)) return "meta-transaction";
          if (tx.receiver === r.receiver_id && r.predecessor_id === tx.signer && tx.kinds.includes(k)) return "transaction";
          return "contract-receipt";
        }
        // Receipt from an older block: a contract acting on itself (e.g. `upgrade`) has
        // predecessor == receiver but a different original signer.
        if (r.predecessor_id === r.receiver_id && action.signer_id && action.signer_id !== r.receiver_id) return "contract-receipt";
        return "unknown";
      };
      const base = (k: string) => ({ account: r.receiver_id, predecessor: r.predecessor_id, signer: action.signer_id ?? null, origin: originFor(k), height, timestampMs, txHash: o.tx_hash ?? null, receiptId: r.receipt_id });
      for (const a of action.actions ?? []) {
        const k = kindOf(a);
        const v = (a as any)[k];
        if (k === "DeployContract") events.push({ ...base(k), kind: "DeployContract", newHash: b64hash(v.code) });
        else if (k === "DeployGlobalContract" || k === "DeployGlobalContractByAccountId") events.push({ ...base(k), kind: "DeployGlobalContract", newHash: b64hash(v.code), global: { by: k.endsWith("AccountId") ? "account" : "hash", ref: r.receiver_id } });
        else if (k === "UseGlobalContract") events.push({ ...base(k), kind: "UseGlobalContract", global: { by: "hash", ref: v.code_hash } });
        else if (k === "UseGlobalContractByAccountId") events.push({ ...base(k), kind: "UseGlobalContract", global: { by: "account", ref: v.account_id } });
        else if (k === "AddKey" && v.access_key?.permission === "FullAccess") events.push({ ...base(k), kind: "AddFullAccessKey", publicKey: v.public_key });
        else if (k === "DeleteKey") events.push({ ...base(k), kind: "DeleteKey", publicKey: v.public_key });
        else if (k === "DeleteAccount") events.push({ ...base(k), kind: "DeleteAccount" });
      }
    }
  }
  return events;
}
