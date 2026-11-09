import { describe, it, expect } from "vitest";
import { grade, type GradeInput, type UpgradePath } from "../src/grade.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3600_000;
const base = (over: Partial<GradeInput> = {}): GradeInput => ({
  hasCode: true,
  paths: [],
  immutabilityFacts: ["no full-access keys", "no deploy host functions"],
  verification: { sourcescan: "verified", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] },
  nep330: { present: true, hasBuildInfo: true, repoStatus: "reachable", evidence: [] },
  globalByAccount: null,
  lastChange: null,
  fullAccessKeyAdded: [],
  nowMs: NOW,
  ...over,
});
const path = (control: UpgradePath["control"], via: UpgradePath["via"] = "contract-method", text = "x"): UpgradePath => ({ via, control, text, evidence: [] });

describe("grade: control class", () => {
  it("no paths → IMMUTABLE; verified → OK", () => {
    const g = grade(base());
    expect(g.class).toBe("IMMUTABLE");
    expect(g.verdict).toBe("OK");
  });
  it("a single-key path dominates every other path → CUSTODIAL", () => {
    const g = grade(base({ paths: [path("governed"), path("single-key", "full-access-key")] }));
    expect(g.class).toBe("CUSTODIAL");
    expect(g.verdict).toBe("CAUTION");
  });
  it("unresolved beats governed, but not single-key", () => {
    expect(grade(base({ paths: [path("governed"), path("unresolved")] })).class).toBe("UNRESOLVED");
    expect(grade(base({ paths: [path("unresolved"), path("single-key")] })).class).toBe("CUSTODIAL");
  });
  it("blocked paths do not count", () => {
    expect(grade(base({ paths: [path("blocked")] })).class).toBe("IMMUTABLE");
  });
  it("GOVERNED + verified → OK; GOVERNED + unverified → CAUTION", () => {
    expect(grade(base({ paths: [path("governed", "contract-method", "DAO: 3 of 5")] })).verdict).toBe("OK");
    const g = grade(base({ paths: [path("governed")], verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] } }));
    expect(g.verdict).toBe("CAUTION");
    expect(g.flags).toContain("UNVERIFIED_CODE");
  });
  it("headline names the approval threshold", () => {
    expect(grade(base({ paths: [path("governed", "contract-method", "DAO x: 3 of 5 members")] })).headline).toContain("3 of 5");
  });
});

describe("grade: verification and change flags", () => {
  it("stale SourceScan entry → STALE_VERIFICATION + UNVERIFIED_CODE", () => {
    const g = grade(base({ verification: { sourcescan: "stale", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] } }));
    expect(g.flags).toEqual(expect.arrayContaining(["STALE_VERIFICATION", "UNVERIFIED_CODE"]));
  });
  it("a matching reproducible build counts as verified", () => {
    const g = grade(base({ verification: { sourcescan: "none", reproducibleBuildMatch: true, aiReviewed: false, evidence: [] } }));
    expect(g.flags).not.toContain("UNVERIFIED_CODE");
  });
  it("code changed 2 h ago and unverified + unreviewed → STOP", () => {
    const g = grade(base({ paths: [path("single-key")], verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] }, lastChange: { timestampMs: NOW - 2 * HOUR, source: "t", evidence: [] } }));
    expect(g.verdict).toBe("STOP");
    expect(g.flags).toContain("CHANGED_24H");
    expect(g.reasons[0].severity).toBe("stop");
  });
  it("code changed 2 h ago but verified → CAUTION, not STOP", () => {
    const g = grade(base({ lastChange: { timestampMs: NOW - 2 * HOUR, source: "t", evidence: [] } }));
    expect(g.verdict).toBe("CAUTION");
  });
  it("code changed 2 h ago, unverified but AI-reviewed → CAUTION", () => {
    const g = grade(base({ verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: true, evidence: [] }, lastChange: { timestampMs: NOW - 2 * HOUR, source: "t", evidence: [] } }));
    expect(g.verdict).toBe("CAUTION");
  });
  it("change 3 days ago → no CHANGED_24H", () => {
    expect(grade(base({ lastChange: { timestampMs: NOW - 72 * HOUR, source: "t", evidence: [] } })).flags).not.toContain("CHANGED_24H");
  });
  it("full-access key added 1 h ago → STOP even when everything else is fine", () => {
    const g = grade(base({ fullAccessKeyAdded: [{ timestampMs: NOW - HOUR, publicKey: "ed25519:abc", evidence: [] }] }));
    expect(g.verdict).toBe("STOP");
    expect(g.flags).toContain("FULL_ACCESS_KEY_ADDED_24H");
  });
  it("missing NEP-330, missing build_info, unreachable repo, global-by-account flags", () => {
    expect(grade(base({ nep330: { present: false, hasBuildInfo: false, repoStatus: "none", evidence: [] } })).flags).toContain("NO_SOURCE_METADATA");
    expect(grade(base({ nep330: { present: true, hasBuildInfo: false, repoStatus: "none", evidence: [] } })).flags).toContain("NO_BUILD_INFO");
    expect(grade(base({ nep330: { present: true, hasBuildInfo: true, repoStatus: "unreachable", evidence: [] } })).flags).toContain("SOURCE_REPO_UNREACHABLE");
    expect(grade(base({ globalByAccount: "pub.near", paths: [path("governed", "global-contract-publisher")] })).flags).toContain("GLOBAL_BY_ACCOUNT");
  });
  it("no code → NO_CODE / OK, or STOP after a fresh full-access key", () => {
    expect(grade(base({ hasCode: false })).class).toBe("NO_CODE");
    expect(grade(base({ hasCode: false, fullAccessKeyAdded: [{ timestampMs: NOW - HOUR, publicKey: "ed25519:k", evidence: [] }] })).verdict).toBe("STOP");
  });
  it("is a pure function", () => {
    const input = base({ paths: [path("single-key")] });
    expect(grade(input)).toEqual(grade(structuredClone(input)));
  });
});

describe("grade: AI review risk", () => {
  const changed = { timestampMs: NOW - 2 * HOUR, source: "t", evidence: [] };
  it("a high-risk AI review keeps a recent unverified change at STOP", () => {
    const g = grade(base({ verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: false, aiRisk: [{ risk: "high", summary: "adds owner-only sweep" }], evidence: [] }, lastChange: changed }));
    expect(g.verdict).toBe("STOP");
    expect(g.flags).toContain("AI_REVIEW_RISK");
  });
  it("a high-risk AI review alone (no recent change) is CAUTION, never OK", () => {
    const g = grade(base({ verification: { sourcescan: "verified", reproducibleBuildMatch: null, aiReviewed: false, aiRisk: [{ risk: "high", summary: "x" }], evidence: [] } }));
    expect(g.verdict).toBe("CAUTION");
  });
});
