// Reused from the same author's Standing Order repo (clerk/src/nearai.ts, written during NEAR HACKATHON
// 2026), disclosed in the README. Only the defaults below were changed for Keyhole.
// NEAR AI Cloud: confidential inference with verifiable attestation.
//
// Flow (per docs.near.ai → Cloud → Verification):
//  1. preflight: fetch the attestation report for the exact model with a fresh nonce; keep the
//     model TEE and gateway signing addresses (the nonce must be echoed back);
//  2. send the completion with the exact request bytes we hash; keep the exact response bytes;
//  3. fetch the signature for the completion id and recover the signer (EIP-191 / ecdsa);
//  4. the response is verified only if the signer matches a preflight address and the signed text
//     is `<model>:<sha256(request)>:<sha256(response)>` (model TEE) or `<req>:<res>` (gateway).
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

export const NEARAI_BASE_URL = process.env.NEARAI_CLOUD_BASE_URL ?? "https://cloud-api.near.ai";
export const DEFAULT_MODEL = process.env.NEARAI_MODEL ?? "Qwen/Qwen3.8-27B";
/** NEAR-operated TEE models to fall back to when the preferred one is unavailable (all return model attestations). */
export const FALLBACK_MODELS = (process.env.NEARAI_FALLBACK_MODELS ?? "z-ai/glm-5.3-flash,deepseek-ai/DeepSeek-V4.1-Flash-1017").split(",").filter(Boolean);

export interface Receipt {
  model: string;
  nonce: string;
  attestation: {
    model_signing_addresses: string[];
    gateway_signing_address: string | null;
    nonce_echoed: boolean;
    has_intel_quote: boolean;
    has_nvidia_payload: boolean;
  };
  chat_id: string;
  request_hash: string;
  response_hash: string;
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind: string } | null;
  recovered_signer: string | null;
  verified: boolean;
  signed_by: "provider_tee" | "gateway" | "none";
  checks: string[];
  usage?: unknown;
  at: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function headers(extra: Record<string, string> = {}) {
  // The key is injected by the environment (NEARAI_CLOUD_API_KEY) or by a proxy; never hard-code it.
  const key = process.env.NEARAI_CLOUD_API_KEY ?? "proxy-injected";
  return { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}`, ...extra };
}

export async function attest(model: string) {
  const nonce = randomBytes(32).toString("hex");
  const params = new URLSearchParams({ model, provider: "near", nonce, signing_algo: "ecdsa", include_tls_fingerprint: "false" });
  const r = await fetch(`${NEARAI_BASE_URL}/v1/attestation/report?${params}`, { headers: headers({ "x-no-aliasing": "true" }) });
  if (!r.ok) throw new Error(`attestation ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const report: any = await r.json();
  return { nonce, report, summary: summarizeReport(report, nonce) };
}

/** Pure summary of an attestation report for our nonce. A missing nonce is never "echoed", and an
 *  empty model_attestations list cannot echo anything (it would make `every` vacuously true). */
export function summarizeReport(report: any, nonce: string): Receipt["attestation"] {
  const models: any[] = Array.isArray(report?.model_attestations) ? report.model_attestations : [];
  const gw = report?.gateway_attestation;
  return {
    model_signing_addresses: models.map((m) => String(m.signing_address).toLowerCase()),
    gateway_signing_address: gw?.signing_address ? String(gw.signing_address).toLowerCase() : null,
    nonce_echoed: models.length > 0 && models.every((m) => typeof m.request_nonce === "string" && m.request_nonce === nonce) && (!gw || gw.request_nonce === nonce),
    has_intel_quote: models.some((m) => Boolean(m.intel_quote)),
    has_nvidia_payload: models.some((m) => Boolean(m.nvidia_payload)),
  };
}

/** Send one chat completion and return the parsed content plus a verification receipt.
 *  Retries transient gateway errors (5xx) and falls back to other NEAR TEE models. */
export async function verifiedCompletion(opts: { model?: string; system: string; user: string; maxTokens?: number; temperature?: number }) {
  const models = [opts.model ?? DEFAULT_MODEL, ...FALLBACK_MODELS.filter((m) => m !== (opts.model ?? DEFAULT_MODEL))];
  let lastErr: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await completeOnce(model, opts);
      } catch (e) {
        lastErr = e;
        const msg = String(e);
        const transient = /completion 5\d\d|fetch failed|ECONNRESET|timeout/i.test(msg);
        console.error(`[nearai] ${model} attempt ${attempt}: ${msg.slice(0, 120)}`);
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
}

async function completeOnce(model: string, opts: { system: string; user: string; maxTokens?: number; temperature?: number }) {
  const pre = await attest(model);
  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.1,
    // Hackathon-tier accounts reserve credit per request; ~1,200 output tokens is the practical ceiling.
    max_tokens: Math.min(opts.maxTokens ?? 1200, Number(process.env.NEARAI_MAX_TOKENS ?? 1200)),
    stream: false,
    // Qwen/GLM reasoning would otherwise consume the whole output budget before the JSON answer.
    chat_template_kwargs: { enable_thinking: false },
  });
  // The request body (which contains the reviewed source) is never written to disk.
  const res = await fetch(`${NEARAI_BASE_URL}/v1/chat/completions`, { method: "POST", headers: headers({ "x-no-aliasing": "true", "accept-encoding": "identity" }), body: requestBody });
  const responseText = await res.text();
  if (!res.ok) throw new Error(`completion ${res.status}: ${responseText.slice(0, 300)}`);
  const parsed = JSON.parse(responseText);
  const chatId: string = parsed.id;
  const content: string = parsed.choices?.[0]?.message?.content ?? "";
  const requestHash = sha256(requestBody);
  const responseHash = sha256(responseText);

  const checks: string[] = [];
  let signature: Receipt["signature"] = null;
  for (let attempt = 0; attempt < 6 && !signature; attempt++) {
    const sr = await fetch(`${NEARAI_BASE_URL}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: headers() });
    if (sr.ok) {
      const j: any = await sr.json();
      if (j.signature && j.text) signature = j;
      else checks.push(`signature unavailable: ${j.message ?? JSON.stringify(j).slice(0, 120)}`);
      if (!signature) break;
    } else if (sr.status === 404) {
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      checks.push(`signature endpoint ${sr.status}`);
      break;
    }
  }

  let recovered: string | null = null;
  let verified = false;
  let signedBy: Receipt["signed_by"] = "none";
  // A response is only verified against a report that attests at least one model TEE.
  const hasModelAttestation = pre.summary.model_signing_addresses.length > 0;
  if (!hasModelAttestation) checks.push("attestation report contains no model attestation");
  if (signature) {
    const kind = signature.signature_kind;
    const parts = signature.text.split(":");
    const expectedModelText = `${model}:${requestHash}:${responseHash}`;
    const expectedGatewayText = `${requestHash}:${responseHash}`;
    try {
      recovered = verifyMessage(signature.text, signature.signature).toLowerCase();
    } catch (e) {
      checks.push(`signature recovery failed: ${String(e).slice(0, 100)}`);
    }
    if (kind === "provider_tee") {
      const textOk = signature.text === expectedModelText && parts.length === 3;
      const signerOk = recovered !== null && pre.summary.model_signing_addresses.filter((a) => a === recovered).length === 1;
      checks.push(textOk ? "signed text = model:sha256(request):sha256(response)" : "signed text does not match our request/response bytes");
      checks.push(signerOk ? "signer matches exactly one attested model TEE" : "signer does not match the preflight model attestation");
      verified = textOk && signerOk && pre.summary.nonce_echoed && hasModelAttestation;
      signedBy = "provider_tee";
    } else if (kind === "gateway") {
      const textOk = signature.text === expectedGatewayText && parts.length === 2;
      const signerOk = recovered !== null && recovered === pre.summary.gateway_signing_address;
      checks.push(textOk ? "signed text = sha256(request):sha256(response)" : "signed text does not match our request/response bytes");
      checks.push(signerOk ? "signer matches the attested gateway TEE" : "signer does not match the gateway attestation");
      verified = textOk && signerOk && pre.summary.nonce_echoed && hasModelAttestation;
      signedBy = "gateway";
    } else {
      checks.push(`unknown signature_kind ${kind}`);
    }
  }
  checks.push(pre.summary.nonce_echoed ? "attestation nonce echoed (fresh report)" : "attestation nonce NOT echoed");
  const receipt: Receipt = {
    model,
    nonce: pre.nonce,
    attestation: pre.summary,
    chat_id: chatId,
    request_hash: requestHash,
    response_hash: responseHash,
    signature,
    recovered_signer: recovered,
    verified,
    signed_by: signedBy,
    checks,
    usage: parsed.usage,
    at: new Date().toISOString(),
  };
  return { content, receipt, raw: parsed, responseText };
}

/** Pull the first JSON object out of a model reply (models sometimes wrap JSON in prose or fences). */
export function extractJson<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON object in model reply");
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
