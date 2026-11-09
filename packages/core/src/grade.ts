// The grade is a pure function of the collected signals. AI never sets it. Rules: docs/GRADING.md.
import type { Evidence } from "./evidence.ts";

export type ControlClass = "IMMUTABLE" | "GOVERNED" | "CUSTODIAL" | "UNRESOLVED" | "NO_CODE";
export type Verdict = "OK" | "CAUTION" | "STOP";
export type Flag =
  | "UNVERIFIED_CODE"
  | "STALE_VERIFICATION"
  | "CHANGED_24H"
  | "FULL_ACCESS_KEY_ADDED_24H"
  | "NO_SOURCE_METADATA"
  | "NO_BUILD_INFO"
  | "SOURCE_REPO_UNREACHABLE"
  | "GLOBAL_BY_ACCOUNT"
  | "AI_REVIEW_RISK";

export type PathControl = "single-key" | "governed" | "unresolved" | "blocked";

/** One way the code on this account can be replaced, and who holds it. */
export interface UpgradePath {
  via: "full-access-key" | "contract-method" | "global-contract-publisher";
  control: PathControl;
  text: string;
  /** e.g. ["upgrade"]: exported methods tied to this path (specific call path or name match). */
  methods?: string[];
  evidence: Evidence[];
}

export interface GradeInput {
  hasCode: boolean;
  paths: UpgradePath[];
  /** Proof facts used for IMMUTABLE. */
  immutabilityFacts: string[];
  verification: {
    sourcescan: "verified" | "stale" | "none" | "unknown";
    reproducibleBuildMatch: boolean | null; // from the Keyhole registry
    /** An attested AI review of this exact code found nothing above low risk. */
    aiReviewed: boolean;
    /** Attested AI reviews of this code hash that report medium or high risk ("high: …"). */
    aiRisk?: { risk: "high" | "medium"; summary: string }[];
    evidence: Evidence[];
  };
  nep330: { present: boolean; hasBuildInfo: boolean; repoStatus: string; evidence: Evidence[] };
  globalByAccount: string | null;
  lastChange: { timestampMs: number | null; source: string; evidence: Evidence[] } | null;
  fullAccessKeyAdded: { timestampMs: number; publicKey: string; evidence: Evidence[] }[];
  nowMs: number;
}

export interface Reason {
  code: string;
  severity: "stop" | "caution" | "info" | "ok";
  text: string;
  evidence: Evidence[];
}

export interface Grade {
  class: ControlClass;
  verdict: Verdict;
  flags: Flag[];
  reasons: Reason[];
  /** One-line, neutral summary for headers and agents. */
  headline: string;
}

const DAY = 24 * 60 * 60 * 1000;

export function grade(s: GradeInput): Grade {
  const reasons: Reason[] = [];
  const flags: Flag[] = [];

  if (!s.hasCode) {
    const recentKey = s.fullAccessKeyAdded.find((k) => s.nowMs - k.timestampMs < DAY);
    if (recentKey) flags.push("FULL_ACCESS_KEY_ADDED_24H");
    reasons.push({ code: "NO_CODE", severity: "info", text: "No contract code on this account: it is a plain account, nothing to upgrade.", evidence: [] });
    for (const p of s.paths.filter((p) => p.via === "full-access-key")) reasons.push({ code: "KEYS", severity: "info", text: p.text, evidence: p.evidence });
    if (recentKey) reasons.unshift({ code: "FULL_ACCESS_KEY_ADDED_24H", severity: "stop", text: `A full-access key (${short(recentKey.publicKey)}) was added in the last 24 hours.`, evidence: recentKey.evidence });
    return { class: "NO_CODE", verdict: recentKey ? "STOP" : "OK", flags, reasons, headline: "Not a contract (no code)." };
  }

  // ── Who can change it? ──
  const live = s.paths.filter((p) => p.control !== "blocked");
  let cls: ControlClass;
  if (live.length === 0) cls = "IMMUTABLE";
  else if (live.some((p) => p.control === "single-key")) cls = "CUSTODIAL";
  else if (live.some((p) => p.control === "unresolved")) cls = "UNRESOLVED";
  else cls = "GOVERNED";

  for (const p of s.paths) {
    const severity = p.control === "single-key" ? "caution" : p.control === "unresolved" ? "caution" : "info";
    reasons.push({ code: `PATH_${p.via.toUpperCase().replace(/-/g, "_")}`, severity, text: p.text, evidence: p.evidence });
  }
  if (cls === "IMMUTABLE") {
    reasons.push({ code: "IMMUTABLE", severity: "ok", text: `Nobody can change this code: ${s.immutabilityFacts.join("; ")}.`, evidence: [] });
  }
  if (s.globalByAccount) flags.push("GLOBAL_BY_ACCOUNT");

  // ── Is it the reviewed code? ──
  const v = s.verification;
  const verified = v.sourcescan === "verified" || v.reproducibleBuildMatch === true;
  if (!verified) {
    flags.push("UNVERIFIED_CODE");
    if (v.sourcescan === "stale") flags.push("STALE_VERIFICATION");
    const why =
      v.sourcescan === "stale"
        ? "SourceScan verified this account at an older code hash; the code running now is not verified."
        : v.reproducibleBuildMatch === false
          ? "A reproducible rebuild of the declared source did not match the deployed code."
          : v.sourcescan === "unknown"
            ? "Verification status could not be fetched."
            : "The code running now is not source-verified (no SourceScan entry or matching reproducible build for this hash).";
    reasons.push({ code: v.sourcescan === "stale" ? "STALE_VERIFICATION" : "UNVERIFIED_CODE", severity: "caution", text: why, evidence: v.evidence });
  } else {
    reasons.push({
      code: "VERIFIED",
      severity: "ok",
      text: v.reproducibleBuildMatch ? "A reproducible rebuild matches the deployed code hash." : "SourceScan has verified source for this exact code hash.",
      evidence: v.evidence,
    });
  }
  if (!s.nep330.present) {
    flags.push("NO_SOURCE_METADATA");
    reasons.push({ code: "NO_SOURCE_METADATA", severity: "info", text: "The contract does not publish NEP-330 source metadata.", evidence: s.nep330.evidence });
  } else if (!s.nep330.hasBuildInfo) {
    flags.push("NO_BUILD_INFO");
    reasons.push({ code: "NO_BUILD_INFO", severity: "info", text: "NEP-330 metadata has no build_info, so the build cannot be reproduced from it.", evidence: s.nep330.evidence });
  }
  if (s.nep330.repoStatus === "unreachable") {
    flags.push("SOURCE_REPO_UNREACHABLE");
    reasons.push({ code: "SOURCE_REPO_UNREACHABLE", severity: "caution", text: "The source repository named in NEP-330 metadata is not publicly reachable.", evidence: s.nep330.evidence });
  }
  if (v.aiReviewed) reasons.push({ code: "AI_REVIEWED", severity: "info", text: "An attested AI review of this code hash found no medium or high risk (evidence, not a guarantee).", evidence: v.evidence });

  // ── What changed? ──
  const changedRecently = s.lastChange?.timestampMs != null && s.nowMs - s.lastChange.timestampMs < DAY;
  if (changedRecently) {
    flags.push("CHANGED_24H");
    reasons.push({ code: "CHANGED_24H", severity: verified || v.aiReviewed ? "caution" : "stop", text: `The code changed ${ago(s.nowMs - (s.lastChange!.timestampMs ?? s.nowMs))} ago (${s.lastChange!.source}).`, evidence: s.lastChange!.evidence });
  }
  const recentKey = s.fullAccessKeyAdded.find((k) => s.nowMs - k.timestampMs < DAY);
  if (recentKey) {
    flags.push("FULL_ACCESS_KEY_ADDED_24H");
    reasons.push({ code: "FULL_ACCESS_KEY_ADDED_24H", severity: "stop", text: `A full-access key (${short(recentKey.publicKey)}) was added ${ago(s.nowMs - recentKey.timestampMs)} ago.`, evidence: recentKey.evidence });
  }

  // AI opinions come after the deterministic facts, so the first STOP reason is always a fact.
  for (const r of v.aiRisk ?? []) {
    if (!flags.includes("AI_REVIEW_RISK")) flags.push("AI_REVIEW_RISK");
    reasons.push({ code: "AI_REVIEW_RISK", severity: r.risk === "high" ? "stop" : "caution", text: `An attested AI review of this code reports ${r.risk} risk: ${r.summary}`, evidence: v.evidence });
  }

  // ── Verdict ──
  let verdict: Verdict;
  const highRisk = (v.aiRisk ?? []).some((r) => r.risk === "high");
  if ((changedRecently && !verified && !v.aiReviewed) || recentKey || (highRisk && changedRecently)) verdict = "STOP";
  else if (highRisk) verdict = "CAUTION";
  else if ((cls === "IMMUTABLE" || cls === "GOVERNED") && verified && !changedRecently) verdict = "OK";
  else verdict = "CAUTION";

  const order = { stop: 0, caution: 1, info: 2, ok: 3 } as const;
  reasons.sort((a, b) => order[a.severity] - order[b.severity]);
  return { class: cls, verdict, flags, reasons, headline: headline(cls, live, verified, changedRecently) };
}

function headline(cls: ControlClass, live: UpgradePath[], verified: boolean, changed: boolean): string {
  const who =
    cls === "IMMUTABLE"
      ? "Code cannot be changed."
      : cls === "CUSTODIAL"
        ? "Code can be replaced by a single key."
        : cls === "GOVERNED"
          ? `Code can be replaced only with multiple approvals (${live.map((p) => p.text.match(/\d+ of \d+/)?.[0]).filter(Boolean).join(", ") || "multisig"}).`
          : "Code can be replaced; who controls that was not resolved.";
  return `${who} ${verified ? "Current code is source-verified." : "Current code is not source-verified."}${changed ? " Code changed in the last 24 h." : ""}`;
}

function ago(ms: number) {
  if (ms < 60000) return "less than a minute";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
const short = (k: string) => (k.length > 20 ? `${k.slice(0, 14)}…${k.slice(-4)}` : k);
