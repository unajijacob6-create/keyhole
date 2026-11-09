// Optional private review of a pending upgrade in a NEAR AI Cloud TEE.
//
// For an unverified pending upgrade there is usually no source, only bytes. What the model sees is
// the deterministic structural diff (methods, capabilities, host imports) and the printable strings
// that are new in the pending wasm (e.g. a hard-coded account id). It is an opinion with a receipt
// (who answered, inside which attested TEE, over exactly which request); it is not proof that the
// code is safe or unsafe. The deterministic grade is computed first and stands on its own.
import { verifiedCompletion, extractJson, DEFAULT_MODEL, type Receipt } from "../../reviewer/src/nearai.ts";
import type { Reviewer } from "./assess.ts";

// Rust string literals sit back to back in the data section with no terminator, so an account id
// can only be found as a fragment ending in a known suffix; a stray leading character from the
// previous literal may be attached. Good enough as a hint for a reviewer, never used for grading.
const ACCOUNT_FRAGMENT = /(?:[a-z0-9]+[-_.])*[a-z0-9]+\.(?:near|testnet)/g;

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

function accountFragments(bytes: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (const s of printableStrings(bytes)) for (const m of s.match(ACCOUNT_FRAGMENT) ?? []) if (m.length <= 64) out.add(m);
  return out;
}

/** Account-id-like fragments in the pending code's strings that the live code does not contain. */
export function newAccountIds(live: Uint8Array | null, pending: Uint8Array): string[] {
  const before = live ? accountFragments(live) : new Set<string>();
  return [...accountFragments(pending)].filter((f) => !before.has(f)).sort();
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

/** Models tried in order. The first is fast (about 1.4 s for this prompt on 2026-11-09), which
 *  matters when the window before execution is minutes. */
export const UPGRADE_MODELS = (process.env.KEYHOLE_UPGRADE_MODELS ?? `deepseek-ai/DeepSeek-V4.1-Flash-1017,${DEFAULT_MODEL}`).split(",").filter(Boolean);

export function teeReviewer(o: { models?: string[]; onReceipt?: (r: TeeReview) => void } = {}): Reviewer {
  return async (input) => {
    const ids = newAccountIds(input.live_bytes, input.pending_bytes);
    const facts = [...input.summary, ...(ids.length ? [`account-id-like string fragments new in the pending binary: ${ids.join(", ")}`] : [])];
    const user = `Contract: ${input.target}\nLive code hash: ${input.live_hash}\nPending code hash: ${input.pending_hash}\nStructural diff (live -> pending):\n${facts.map((f) => `- ${f}`).join("\n") || "- (no structural change)"}`;
    let lastErr: unknown;
    for (const model of o.models ?? UPGRADE_MODELS) {
      try {
        const { content, receipt } = await verifiedCompletion({ model, system: UPGRADE_SYSTEM, user, maxTokens: 400, temperature: 0 });
        // A model that answers without the JSON verdict is skipped, not guessed at.
        const parsed = extractJson<{ risk: string; summary: string }>(content);
        if (!(["high", "medium", "low", "none"] as const).includes(parsed.risk as any)) throw new Error(`no usable risk in reply from ${receipt.model}`);
        const r: TeeReview = { risk: parsed.risk as TeeReview["risk"], summary: String(parsed.summary ?? "").slice(0, 200), model: receipt.model, receipt };
        o.onReceipt?.(r);
        return { risk: r.risk, summary: r.summary, receipt_id: receipt.chat_id };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  };
}
