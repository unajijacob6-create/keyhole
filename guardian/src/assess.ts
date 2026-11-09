// Grade a pending code change before it lands: fetch the exact bytes being voted on (or staged),
// diff them against the live code, look up verification for the new hash, and run the
// deterministic upgrade rules. Optional: a private TEE review of the diff summary.
//
// After the change (a "deployed" event, or an executed proposal) the comparison base is the code
// that was REPLACED, read at a block where it was still live. If that code cannot be read, the
// assessment says so (REPLACED_CODE_UNAVAILABLE, CAUTION): it never compares against the code that
// is live now (that would say "no change") nor against nothing (every capability would look new).
//
// Pending bytes that do not parse as wasm (store_blob and up_stage_code accept any bytes) are a
// CAUTION with PENDING_CODE_INVALID_WASM, not an error: there is nothing to diff, and that is the news.
import {
  analyzeWasm,
  codeHash,
  effectiveHash,
  EMPTY_CODE_HASH,
  fetchPendingCode,
  gradeUpgrade,
  proposalArgsCode,
  registryLookup,
  RpcAnswerError,
  sourcescan,
  stagedCode,
  type Rpc,
  type StagedUpgrade,
  type TxApi,
  type UpgradeFlag,
  type UpgradeGrade,
  type UpgradeProposal,
  type WasmAnalysis,
} from "../../packages/core/src/index.ts";

export type CodeSource =
  | { kind: "store_blob"; tx: string; signer: string; height: number }
  | { kind: "up_staged_code" }
  | { kind: "deployed" }
  | { kind: "proposal_args"; dao: string; id: number }
  | null;

/** Guardian-level flags on top of the core upgrade flags. */
export type AssessmentFlag =
  | UpgradeFlag
  | "REPLACED_CODE_UNAVAILABLE"
  /** The pending bytes were read (their hash matches) but do not parse as wasm. */
  | "PENDING_CODE_INVALID_WASM"
  /** Set by the guardian when assessing an event kept failing (the alert carries the error). */
  | "ASSESSMENT_FAILED";
export type AssessmentGrade = Omit<UpgradeGrade, "flags"> & { flags: AssessmentFlag[] };

/** The code a change replaced, as the radar last saw it live. */
export interface ReplacedCode {
  hash: string;
  /** A block at which `hash` was live; null if unknown. */
  height: number | null;
}

export interface Assessment {
  schema: "keyhole.assessment/1";
  target: string;
  dao: string | null;
  proposal: UpgradeProposal | null;
  staged: StagedUpgrade | null;
  /** The code the pending code is compared against: the live code, or, after the change, the code
   *  it replaced ("unknown" if the radar never saw it). */
  live_hash: string;
  pending_hash: string | null;
  code_source: CodeSource;
  pending_size: number | null;
  /** After the change only: where the replaced code was read, or that it could not be. */
  replaced: { hash: string | null; height: number | null; readable: boolean } | null;
  verified: { reproducible: boolean | null; sourcescan: boolean | null; registry_review: string | null };
  /** New exports and the capabilities newly reachable, in words, for alerts and the TEE prompt. */
  summary: string[];
  grade: AssessmentGrade;
  review: { risk: "high" | "medium" | "low" | "none"; summary: string; receipt_id?: string } | null;
  at: string;
}

export interface Reviewer {
  (input: { target: string; live_hash: string; pending_hash: string; summary: string[]; live_bytes: Uint8Array | null; pending_bytes: Uint8Array }): Promise<{ risk: "high" | "medium" | "low" | "none"; summary: string; receipt_id?: string } | null>;
}

export interface AssessDeps {
  rpc: Rpc;
  api: TxApi;
  /** Archival RPC, to read replaced code at a block the regular RPC no longer serves. */
  archival?: Rpc | null;
  /** Testnet Keyhole registry client (ReproducibleBuild / AiReview attestations by code hash). */
  registry?: { rpc: Rpc; account: string } | null;
  reviewer?: Reviewer | null;
  now?: () => Date;
}

export function describeDiff(g: Pick<UpgradeGrade, "diff">): string[] {
  const d = g.diff;
  if (!d) return [];
  const out: string[] = [];
  if (d.addedMethods.length) out.push(`new methods: ${d.addedMethods.join(", ")}`);
  if (d.removedMethods.length) out.push(`removed methods: ${d.removedMethods.join(", ")}`);
  if (d.addedCapabilities.length) out.push(`new capabilities: ${d.addedCapabilities.join(", ")}`);
  for (const n of d.newlyReachable) out.push(`${n.capability} now reachable from: ${n.methods.join(", ")}`);
  if (d.addedHostImports.length) out.push(`new host imports: ${d.addedHostImports.join(", ")}`);
  return out;
}

const short = (h: string) => (h.length > 12 ? `${h.slice(0, 8)}…` : h);

/** The bytes of `r.hash` on `target` at `r.height`, from the regular RPC, then the archival one.
 *  Only bytes that hash to `r.hash` are returned. */
async function readReplaced(deps: AssessDeps, target: string, r: ReplacedCode): Promise<Uint8Array | null> {
  if (r.height === null) return null;
  for (const rpc of [deps.rpc, deps.archival]) {
    if (!rpc) continue;
    try {
      const { code } = await rpc.viewCode(target, r.height);
      if ((await codeHash(code)) === r.hash) return code;
    } catch {
      // garbage-collected block on a regular node, or an outage: try the next source
    }
  }
  return null;
}

/** The grade when the code a change replaced could not be read: verification and any AI review
 *  still count, the diff does not (there is nothing honest to diff against). */
function gradeWithoutBase(i: Parameters<typeof gradeUpgrade>[0], havePending: boolean, replacedHash: string | null): AssessmentGrade {
  const g = gradeUpgrade({ ...i, live: null, pending: null });
  const aiHigh = g.flags.includes("AI_REVIEW_HIGH");
  const unverified = g.flags.includes("UNVERIFIED_PENDING_CODE");
  const flags: AssessmentFlag[] = g.flags.filter((f) => f === "UNVERIFIED_PENDING_CODE" || f === "AI_REVIEW_HIGH" || (!havePending && f === "PENDING_CODE_UNAVAILABLE"));
  flags.push("REPLACED_CODE_UNAVAILABLE");
  const reasons = g.reasons.filter((r) => havePending ? !/could not be fetched/.test(r.text) : true);
  reasons.push({
    severity: "caution",
    text: replacedHash
      ? `The code this change replaced on ${i.target} (${short(replacedHash)}) could not be read at a block where it was live, so the new code was not compared with it: what the change adds is unknown.`
      : `The radar never saw the code this change replaced on ${i.target}, so the new code was not compared with it: what the change adds is unknown.`,
  });
  const verdict = aiHigh ? "STOP" : "CAUTION";
  return {
    verdict,
    flags,
    reasons,
    diff: null,
    fire: verdict === "STOP",
    headline: aiHigh
      ? `STOP: an AI review of the new code for ${i.target} reports high risk.`
      : `CAUTION: the code this change replaced on ${i.target} could not be read, so the change was not compared with it${unverified ? "; the new code is not verified" : ""}.`,
  };
}

/** The analysis of `bytes`, or null when they are not a wasm module Keyhole can parse. */
function analyzeOrNull(bytes: Uint8Array): WasmAnalysis | null {
  try {
    return analyzeWasm(bytes);
  } catch {
    return null;
  }
}

/** The grade when the pending bytes were read but are not wasm: verification and an AI review
 *  still count; there is no diff. */
function gradeNotWasm(i: Parameters<typeof gradeUpgrade>[0], size: number, err: string): AssessmentGrade {
  const g = gradeUpgrade({ ...i, live: null, pending: null });
  if (g.flags.includes("NO_CHANGE")) return g;
  const aiHigh = g.flags.includes("AI_REVIEW_HIGH");
  const flags: AssessmentFlag[] = g.flags.map((f) => (f === "PENDING_CODE_UNAVAILABLE" ? "PENDING_CODE_INVALID_WASM" : f));
  const reasons = g.reasons.map((r) =>
    /could not be fetched/.test(r.text)
      ? { severity: "caution" as const, text: `The pending code${i.pending_hash ? ` ${short(i.pending_hash)}` : ""} (${size} bytes) was read, but it is not a valid wasm module (${err}), so what it can do cannot be analysed.` }
      : r,
  );
  const verdict = aiHigh ? "STOP" : "CAUTION";
  return {
    verdict,
    flags,
    reasons,
    diff: null,
    fire: verdict === "STOP",
    headline: aiHigh ? g.headline : `CAUTION: the pending code for ${i.target} is not a valid wasm module, so it could not be analysed.`,
  };
}

export async function assessPending(
  deps: AssessDeps,
  o: {
    target: string;
    hash: string | null;
    dao?: string | null;
    proposal?: UpgradeProposal | null;
    staged?: StagedUpgrade | null;
    /** The change already happened (deployed event, executed proposal). */
    deployed?: boolean;
    /** With deployed: the code it replaced (from the radar). Without it, the base is unknown. */
    replaced?: ReplacedCode | null;
  },
): Promise<Assessment> {
  const { rpc } = deps;
  const view = await rpc.viewAccount(o.target);
  const currentHash = effectiveHash(view);
  let liveBytes: Uint8Array | null = null;
  try {
    liveBytes = (await rpc.viewCode(o.target)).code;
  } catch (e) {
    if (!(e instanceof RpcAnswerError)) throw e;
  }

  let pendingBytes: Uint8Array | null = null;
  let source: CodeSource = null;
  if (o.hash) {
    if (o.deployed && liveBytes && (await codeHash(liveBytes)) === o.hash) {
      pendingBytes = liveBytes;
      source = { kind: "deployed" };
    }
    if (!source && o.proposal?.hash_from === "args-code" && o.dao) {
      const inline = await proposalArgsCode(rpc, o.dao, o.proposal.id, o.hash, o.proposal.method);
      if (inline) {
        pendingBytes = inline;
        source = { kind: "proposal_args", dao: o.dao, id: o.proposal.id };
      }
    }
    if (!source && o.dao) {
      const blob = await fetchPendingCode({ api: deps.api, dao: o.dao, hash: o.hash });
      if (blob) {
        pendingBytes = blob.code;
        source = { kind: "store_blob", tx: blob.tx, signer: blob.signer, height: blob.height };
      }
    }
    if (!source) {
      const staged = await stagedCode(rpc, o.target, o.hash);
      if (staged) {
        pendingBytes = staged;
        source = { kind: "up_staged_code" };
      }
    }
  }

  // The comparison base: the live code before the change, or the code the change replaced.
  let baseHash: string = currentHash;
  let before: Uint8Array | null = liveBytes;
  let replaced: Assessment["replaced"] = null;
  let baseKnown = true;
  if (o.deployed) {
    const r = o.replaced ?? null;
    baseHash = r?.hash ?? "unknown";
    before = null;
    if (!r) baseKnown = false;
    else if (r.hash === EMPTY_CODE_HASH || r.hash === o.hash) replaced = { hash: r.hash, height: r.height, readable: true };
    else if (liveBytes && r.hash === currentHash && (await codeHash(liveBytes)) === r.hash) {
      // The change has not reached the target yet (the upgrade receipt lands a block later).
      before = liveBytes;
      replaced = { hash: r.hash, height: view.block_height ?? null, readable: true };
    } else {
      before = await readReplaced(deps, o.target, r);
      replaced = { hash: r.hash, height: r.height, readable: before !== null };
      baseKnown = before !== null;
    }
  }
  // Live code that does not parse is graded like "no analysis of the live code".
  const live: WasmAnalysis | null = before ? analyzeOrNull(before) : null;
  let pending: WasmAnalysis | null = null;
  let notWasm: string | null = null;
  if (pendingBytes) {
    try {
      pending = analyzeWasm(pendingBytes);
    } catch (e) {
      notWasm = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }

  let sourcescanOk: boolean | null = null;
  let reproducible: boolean | null = null;
  let registryReview: string | null = null;
  if (o.hash) {
    try {
      const ss = await sourcescan(rpc, o.target, o.hash);
      sourcescanOk = ss.status === "verified" ? true : ss.status === "unknown" ? null : false;
    } catch {
      sourcescanOk = null;
    }
    if (deps.registry) {
      try {
        const r = await registryLookup(deps.registry.rpc, o.target, o.hash, deps.registry.account);
        if (r.available) {
          const builds = r.forHash.filter((x) => x.attestation.kind === "ReproducibleBuild");
          reproducible = builds.some((x) => x.attestation.kind === "ReproducibleBuild" && x.attestation.matches);
          const ai = r.forHash.filter((x) => x.attestation.kind === "AiReview").at(-1);
          registryReview = ai && ai.attestation.kind === "AiReview" ? ai.attestation.verdict_summary : null;
        }
      } catch {
        reproducible = null;
      }
    }
  }

  const baseInput = {
    target: o.target,
    live_hash: baseHash,
    pending_hash: o.hash,
    live,
    pending,
    verified: { reproducible, sourcescan: sourcescanOk, registry_review: registryReview },
  };
  const gradeOf = (review: Assessment["review"]): AssessmentGrade =>
    notWasm !== null
      ? gradeNotWasm({ ...baseInput, review }, pendingBytes!.length, notWasm)
      : baseKnown
        ? gradeUpgrade({ ...baseInput, review })
        : gradeWithoutBase({ ...baseInput, review }, pending !== null, o.replaced?.hash ?? null);
  let grade = gradeOf(null);
  let review: Assessment["review"] = null;
  const summary = describeDiff(grade);
  if (deps.reviewer && o.hash && pending) {
    try {
      review = await deps.reviewer({ target: o.target, live_hash: baseHash, pending_hash: o.hash, summary, live_bytes: before, pending_bytes: pendingBytes! });
      if (review) grade = gradeOf(review);
    } catch {
      review = null; // the deterministic grade stands on its own
    }
  }
  return {
    schema: "keyhole.assessment/1",
    target: o.target,
    dao: o.dao ?? null,
    proposal: o.proposal ?? null,
    staged: o.staged ?? null,
    live_hash: baseHash,
    pending_hash: o.hash,
    code_source: source,
    pending_size: pendingBytes?.length ?? null,
    replaced,
    verified: baseInput.verified,
    summary,
    grade,
    review,
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
}
