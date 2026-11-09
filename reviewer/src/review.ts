// Private AI review in a NEAR AI Cloud TEE, with a receipt anyone can re-verify.
//
// - The source goes to the model only inside the request; it is never written to disk here.
// - What is kept: sha256(source bundle), sha256(request), sha256(response), the TEE signature over
//   `<model>:<sha256(request)>:<sha256(response)>`, the attested signing address, and a short
//   summary ("<risk>: <text>", ≤ 280 chars) that goes on-chain as an AiReview attestation.
// - Honest claim: "source with sha256 X was reviewed by model M inside an attested TEE". It is
//   bound to a deployed code hash only when a reproducible build of that source matches; otherwise
//   the binding is labelled owner-claimed.
import { createHash } from "node:crypto";
import { verifyMessage } from "ethers";
import { verifiedCompletion, extractJson, DEFAULT_MODEL, type Receipt } from "./nearai.ts";

export type Risk = "high" | "medium" | "low" | "none";
export interface Finding {
  severity: "high" | "medium" | "low";
  category: "drain" | "authority" | "check-removed" | "fee" | "code-change" | "other";
  title: string;
  location?: string;
  rationale?: string;
}
export interface ReviewResult {
  risk: Risk;
  summary: string;
  findings: Finding[];
}
export interface ReviewRecord {
  schema: "keyhole.review/1";
  label: string;
  model: string;
  code_hash: string | null;
  binding: "reproducible-build" | "owner-claimed" | "none";
  source_sha256: string;
  base_source_sha256: string | null;
  result: ReviewResult;
  verdict_summary: string; // what goes on-chain
  receipt: Receipt;
  /** Only when the caller opts in (public source): lets anyone re-hash the exact response. */
  response_body?: string;
  at: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical hash of a set of files: sha256 of JSON with sorted paths. */
export function bundleHash(files: Record<string, string>): string {
  return sha256(JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]])));
}

/** Remove Rust comments and the #[cfg(test)] module: the model judges code, not narration. */
export function stripRust(src: string): string {
  const noTests = src.replace(/#\[cfg\(test\)\][\s\S]*$/, "");
  let out = "";
  let inStr = false;
  for (let i = 0; i < noTests.length; i++) {
    const c = noTests[i];
    if (!inStr && c === "/" && noTests[i + 1] === "/") {
      while (i < noTests.length && noTests[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (!inStr && c === "/" && noTests[i + 1] === "*") {
      i += 2;
      while (i < noTests.length && !(noTests[i] === "*" && noTests[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === '"' && noTests[i - 1] !== "\\") inStr = !inStr;
    out += c;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export const SYSTEM = `You review NEAR smart contracts written in Rust (near-sdk) for a wallet's pre-sign check.
Judge only the code shown. When a previous version is given, focus on what changed.
Report anything that lets some party: move or take user funds (category "drain"); change who controls
the contract or skip an authorization check (category "authority"); remove or weaken a check that
protects users (category "check-removed"); change fees or where money goes (category "fee"); deploy or
replace code (category "code-change").
Answer with one JSON object and nothing else:
{"risk":"high|medium|low|none","summary":"<= 200 characters, plain words","findings":[{"severity":"high|medium|low","category":"drain|authority|check-removed|fee|code-change|other","title":"...","location":"function name","rationale":"one sentence"}]}
If nothing affects funds, authority, checks, fees or code, use risk "none" and an empty findings list.`;

export function buildUserPrompt(files: Record<string, string>, base?: Record<string, string>): string {
  const fmt = (fs: Record<string, string>) => Object.keys(fs).sort().map((p) => `--- ${p}\n${fs[p]}`).join("\n");
  return base ? `PREVIOUS VERSION:\n${fmt(base)}\n\nNEW VERSION (deployed now):\n${fmt(files)}` : `CONTRACT SOURCE:\n${fmt(files)}`;
}

export async function review(opts: {
  label: string;
  files: Record<string, string>;
  base?: Record<string, string>;
  codeHash?: string;
  binding?: ReviewRecord["binding"];
  model?: string;
  publishResponse?: boolean;
}): Promise<ReviewRecord> {
  const { content, receipt, responseText } = await verifiedCompletion({ model: opts.model ?? DEFAULT_MODEL, system: SYSTEM, user: buildUserPrompt(opts.files, opts.base), maxTokens: 1000, temperature: 0 });
  const parsed = extractJson<ReviewResult>(content);
  const risk: Risk = (["high", "medium", "low", "none"] as const).includes(parsed.risk) ? parsed.risk : "high";
  const result: ReviewResult = { risk, summary: String(parsed.summary ?? "").slice(0, 200), findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 10) : [] };
  const verdict_summary = `${risk}: ${result.summary}`.slice(0, 280);
  return {
    schema: "keyhole.review/1",
    label: opts.label,
    model: receipt.model,
    code_hash: opts.codeHash ?? null,
    binding: opts.binding ?? (opts.codeHash ? "owner-claimed" : "none"),
    source_sha256: bundleHash(opts.files),
    base_source_sha256: opts.base ? bundleHash(opts.base) : null,
    result,
    verdict_summary,
    receipt,
    ...(opts.publishResponse ? { response_body: responseText } : {}),
    at: new Date().toISOString(),
  };
}

/** Offline re-verification of a stored receipt: the signature recovers to the attested TEE signing
 *  address, and the signed text names the model and the request/response hashes. When the response
 *  body was published, it must hash to the signed response hash. Needs no network. */
export function verifyReceiptOffline(rec: Pick<ReviewRecord, "receipt" | "response_body">): { ok: boolean; checks: string[] } {
  const r = rec.receipt;
  const checks: string[] = [];
  if (!r.signature) return { ok: false, checks: ["no signature in receipt"] };
  let recovered = "";
  try {
    recovered = verifyMessage(r.signature.text, r.signature.signature).toLowerCase();
  } catch (e) {
    return { ok: false, checks: [`signature does not parse: ${String(e).slice(0, 80)}`] };
  }
  const textOk = r.signature.text === `${r.model}:${r.request_hash}:${r.response_hash}` || r.signature.text === `${r.request_hash}:${r.response_hash}`;
  checks.push(textOk ? "signed text = model:sha256(request):sha256(response)" : "signed text does not match the receipt's hashes");
  const signerOk = recovered === r.recovered_signer && (r.attestation.model_signing_addresses.includes(recovered) || r.attestation.gateway_signing_address === recovered);
  checks.push(signerOk ? `EIP-191 signature recovers to attested TEE address ${recovered}` : `recovered ${recovered}, which is not an attested address`);
  checks.push(r.attestation.nonce_echoed ? "attestation report echoed our fresh 32-byte nonce" : "attestation nonce was not echoed");
  let bodyOk = true;
  if (rec.response_body !== undefined) {
    bodyOk = sha256(rec.response_body) === r.response_hash;
    checks.push(bodyOk ? "published response body hashes to the signed response hash" : "published response body does NOT match the signed hash");
  }
  return { ok: textOk && signerOk && r.attestation.nonce_echoed && bodyOk, checks };
}
