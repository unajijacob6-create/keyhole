// Optional private review of a pending upgrade in a NEAR AI Cloud TEE.
//
// For an unverified pending upgrade there is usually no source, only bytes. What the model sees is
// the deterministic structural diff (methods, capabilities, host imports) and the printable strings
// that are new in the pending wasm (e.g. a hard-coded account id). It is an opinion with a receipt
// (who answered, inside which attested TEE, over exactly which request); it is not proof that the
// code is safe or unsafe. The deterministic grade is computed first and stands on its own.
import { verifiedCompletion, extractJson, DEFAULT_MODEL, type Receipt } from "../../reviewer/src/nearai.ts";
import type { Reviewer } from "./assess.ts";

const ACCOUNTISH = /^(?=.{5,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)+(near|testnet|tg|aurora)$|^[0-9a-f]{64}$/;

/** Printable ASCII runs (>= minLen) in a wasm binary; data segments hold string literals. */
export function printableStrings(bytes: Uint8Array, minLen = 6): Set<string> {
  const out = new Set<string>();
  let cur = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
    else {
      if (cur.length >= minLen) out.add(cur);
      cur = "";
    }
  }
  if (cur.length >= minLen) out.add(cur);
  return out;
}

/** Account ids that appear in the pending code's strings but not in the live code's. */
export function newAccountIds(live: Uint8Array | null, pending: Uint8Array): string[] {
  const before = live ? printableStrings(live) : new Set<string>();
  const ids = new Set<string>();
  for (const s of printableStrings(pending)) {
    if (before.has(s)) continue;
    for (const tok of s.split(/[^a-z0-9._-]+/)) if (ACCOUNTISH.test(tok) && ![...before].some((b) => b.includes(tok))) ids.add(tok);
  }
  return [...ids].sort();
}

export const UPGRADE_SYSTEM = `You assess a PENDING code upgrade of a NEAR smart contract for the people who have money deposited in it.
You get a structural diff of the live and the pending wasm (methods added/removed, which privileged host capabilities each method can reach) and account ids that newly appear in the pending binary's strings. You do not get source code.
Answer ONLY with JSON: {"risk":"high"|"medium"|"low"|"none","summary":"<=160 chars, plain words, what a depositor should know"}.
"high" = the upgrade plausibly lets someone take or lock depositors' funds (e.g. a new method that can transfer the contract's balance, a new way to replace the code or add keys, removal of the withdraw path, a hard-coded beneficiary). Be concrete; do not speculate beyond the facts given.`;

export interface TeeReview {
  risk: "high" | "medium" | "low" | "none";
  summary: string;
  model: string;
  receipt: Receipt;
}

export function teeReviewer(o: { model?: string; extraFacts?: (input: { target: string; pending_hash: string }) => string[]; onReceipt?: (r: TeeReview) => void } = {}): Reviewer {
  return async (input) => {
    const facts = [...input.summary, ...(o.extraFacts?.(input) ?? [])];
    const user = `Contract: ${input.target}\nLive code hash: ${input.live_hash}\nPending code hash: ${input.pending_hash}\nStructural diff (live -> pending):\n${facts.map((f) => `- ${f}`).join("\n") || "- (no structural change)"}`;
    const { content, receipt } = await verifiedCompletion({ model: o.model ?? DEFAULT_MODEL, system: UPGRADE_SYSTEM, user, maxTokens: 300, temperature: 0 });
    const parsed = extractJson<{ risk: string; summary: string }>(content);
    const risk = (["high", "medium", "low", "none"] as const).includes(parsed.risk as any) ? (parsed.risk as TeeReview["risk"]) : "high";
    const r: TeeReview = { risk, summary: String(parsed.summary ?? "").slice(0, 200), model: receipt.model, receipt };
    o.onReceipt?.(r);
    return { risk: r.risk, summary: r.summary, receipt_id: receipt.chat_id };
  };
}
