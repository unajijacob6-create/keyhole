// Grade a pending code change before it lands: fetch the exact bytes being voted on (or staged),
// diff them against the live code, look up verification for the new hash, and run the
// deterministic upgrade rules. Optional: a private TEE review of the diff summary.
import {
  analyzeWasm,
  base64ToBytes,
  codeHash,
  effectiveHash,
  fetchPendingCode,
  gradeUpgrade,
  registryLookup,
  RpcAnswerError,
  sourcescan,
  type Rpc,
  type StagedUpgrade,
  type TxApi,
  type UpgradeGrade,
  type UpgradeProposal,
  type WasmAnalysis,
} from "../../packages/core/src/index.ts";

export type CodeSource =
  | { kind: "store_blob"; tx: string; signer: string; height: number }
  | { kind: "up_staged_code" }
  | { kind: "deployed" }
  | null;

export interface Assessment {
  schema: "keyhole.assessment/1";
  target: string;
  dao: string | null;
  proposal: UpgradeProposal | null;
  staged: StagedUpgrade | null;
  live_hash: string;
  pending_hash: string | null;
  code_source: CodeSource;
  pending_size: number | null;
  verified: { reproducible: boolean | null; sourcescan: boolean | null; registry_review: string | null };
  /** New exports and the capabilities newly reachable, in words, for alerts and the TEE prompt. */
  summary: string[];
  grade: UpgradeGrade;
  review: { risk: "high" | "medium" | "low" | "none"; summary: string; receipt_id?: string } | null;
  at: string;
}

export interface Reviewer {
  (input: { target: string; live_hash: string; pending_hash: string; summary: string[] }): Promise<{ risk: "high" | "medium" | "low" | "none"; summary: string; receipt_id?: string } | null>;
}

export interface AssessDeps {
  rpc: Rpc;
  api: TxApi;
  /** Testnet Keyhole registry client (ReproducibleBuild / AiReview attestations by code hash). */
  registry?: { rpc: Rpc; account: string } | null;
  reviewer?: Reviewer | null;
  now?: () => Date;
}

/** Fetch near-plugins staged code. The view returns Option<Vec<u8>> as a JSON byte array or base64. */
async function stagedCode(rpc: Rpc, target: string): Promise<Uint8Array | null> {
  try {
    const v = await rpc.view<unknown>(target, "up_staged_code");
    if (Array.isArray(v)) return new Uint8Array(v as number[]);
    if (typeof v === "string") return base64ToBytes(v);
    return null;
  } catch (e) {
    if (e instanceof RpcAnswerError) return null;
    throw e;
  }
}

export function describeDiff(g: UpgradeGrade): string[] {
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

export async function assessPending(
  deps: AssessDeps,
  o: { target: string; hash: string | null; dao?: string | null; proposal?: UpgradeProposal | null; staged?: StagedUpgrade | null; deployed?: boolean },
): Promise<Assessment> {
  const { rpc } = deps;
  const view = await rpc.viewAccount(o.target);
  const liveHash = effectiveHash(view);
  let live: WasmAnalysis | null = null;
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
    if (!pendingBytes && o.dao) {
      const blob = await fetchPendingCode({ api: deps.api, dao: o.dao, hash: o.hash });
      if (blob) {
        pendingBytes = blob.code;
        source = { kind: "store_blob", tx: blob.tx, signer: blob.signer, height: blob.height };
      }
    }
    if (!pendingBytes) {
      const staged = await stagedCode(rpc, o.target);
      if (staged && (await codeHash(staged)) === o.hash) {
        pendingBytes = staged;
        source = { kind: "up_staged_code" };
      }
    }
  }
  // When the change already happened, "live" in the diff must be the code it replaced.
  const before = o.deployed ? null : liveBytes;
  live = before ? analyzeWasm(before) : null;
  const pending = pendingBytes ? analyzeWasm(pendingBytes) : null;

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
    live_hash: liveHash,
    pending_hash: o.hash,
    live,
    pending,
    verified: { reproducible, sourcescan: sourcescanOk, registry_review: registryReview },
  };
  let grade = gradeUpgrade({ ...baseInput, review: null });
  let review: Assessment["review"] = null;
  const summary = describeDiff(grade);
  if (deps.reviewer && o.hash && pending) {
    try {
      review = await deps.reviewer({ target: o.target, live_hash: liveHash, pending_hash: o.hash, summary });
      if (review) grade = gradeUpgrade({ ...baseInput, review });
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
    live_hash: liveHash,
    pending_hash: o.hash,
    code_source: source,
    pending_size: pendingBytes?.length ?? null,
    verified: baseInput.verified,
    summary,
    grade,
    review,
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
}
