// "Is the code running now the code that was built and verified?" signals: NEP-330 metadata,
// SourceScan verification at the current hash, and whether the declared source repo resolves.
import type { Network, Rpc } from "./rpc.ts";
import { ev, type Evidence } from "./evidence.ts";

export interface BuildInfo {
  build_environment?: string;
  build_command?: string[];
  source_code_snapshot?: string;
  contract_path?: string;
  output_wasm_path?: string;
}
export interface SourceMetadata {
  version?: string;
  link?: string;
  standards?: { standard: string; version: string }[];
  build_info?: BuildInfo;
}

export interface Nep330Signal {
  present: boolean;
  metadata: SourceMetadata | null;
  hasBuildInfo: boolean;
  /** owner/repo on GitHub, if the link or snapshot points there. */
  github: { owner: string; repo: string; rev: string | null } | null;
  repoStatus: "reachable" | "unreachable" | "unknown" | "not-github" | "none";
  evidence: Evidence[];
}

const GH = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i;

export function parseGithub(meta: SourceMetadata | null): Nep330Signal["github"] {
  const snap = meta?.build_info?.source_code_snapshot ?? "";
  const m = snap.match(GH) ?? (meta?.link ?? "").match(GH);
  if (!m) return null;
  const rev = snap.match(/[?&]rev=([0-9a-f]{7,40})/i)?.[1] ?? (meta?.link ?? "").match(/\/(?:tree|commit)\/([0-9a-f]{7,40})/i)?.[1] ?? null;
  return { owner: m[1], repo: m[2], rev };
}

export interface SourceOptions {
  /** Check that the GitHub repo exists. Defaults to fetch against api.github.com (CORS-enabled). */
  checkRepo?: false | ((owner: string, repo: string) => Promise<"reachable" | "unreachable" | "unknown">);
}

export async function githubRepoStatus(owner: string, repo: string): Promise<"reachable" | "unreachable" | "unknown"> {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: "application/vnd.github+json" } });
    if (r.ok) return "reachable";
    // 404 is a definitive "not public"; 403/429 are rate limits or blocked access, which prove nothing.
    if (r.status === 404 || r.status === 451) return "unreachable";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function nep330(rpc: Rpc, account: string, exports: string[], opts: SourceOptions = {}): Promise<Nep330Signal> {
  const evidence = [ev.view(rpc.network, account, "contract_source_metadata")];
  if (!exports.includes("contract_source_metadata")) {
    return { present: false, metadata: null, hasBuildInfo: false, github: null, repoStatus: "none", evidence };
  }
  const metadata = await rpc.tryView<SourceMetadata>(account, "contract_source_metadata");
  const github = parseGithub(metadata);
  let repoStatus: Nep330Signal["repoStatus"] = metadata?.link || metadata?.build_info?.source_code_snapshot ? "not-github" : "none";
  if (github) {
    const check = opts.checkRepo === undefined ? githubRepoStatus : opts.checkRepo;
    repoStatus = check ? await check(github.owner, github.repo) : "unknown";
    evidence.push(ev.url(`https://api.github.com/repos/${github.owner}/${github.repo}`, "repository exists and is public"));
  }
  return { present: Boolean(metadata), metadata, hasBuildInfo: Boolean(metadata?.build_info), github, repoStatus, evidence };
}

export const SOURCESCAN: Record<Network, string> = { mainnet: "v2-verifier.sourcescan.near", testnet: "v2-verifier.sourcescan.testnet" };

export interface SourceScanSignal {
  /** verified: this exact code hash is verified (for this account or another one with the same code).
   *  stale: this account was verified, at a different code hash. none: no entry. */
  status: "verified" | "stale" | "none" | "unknown";
  accountEntry: { code_hash: string; block_height: number; lang?: string; cid?: string } | null;
  sameCodeAccounts: string[];
  evidence: Evidence[];
}

export async function sourcescan(rpc: Rpc, account: string, codeHash: string): Promise<SourceScanSignal> {
  const registry = SOURCESCAN[rpc.network];
  const evidence = [ev.view(rpc.network, registry, "get_contract", { account_id: account }), ev.view(rpc.network, registry, "get_contracts_by_code_hash", { code_hash: codeHash })];
  try {
    const [entry, byHash] = await Promise.all([
      rpc.tryView<any>(registry, "get_contract", { account_id: account }),
      rpc.tryView<[string, any][]>(registry, "get_contracts_by_code_hash", { code_hash: codeHash }),
    ]);
    const sameCodeAccounts = (byHash ?? []).map(([a]) => a);
    const accountEntry = entry ? { code_hash: entry.code_hash, block_height: entry.block_height, lang: entry.lang, cid: entry.cid } : null;
    const status = sameCodeAccounts.length > 0 || accountEntry?.code_hash === codeHash ? "verified" : accountEntry ? "stale" : "none";
    return { status, accountEntry, sameCodeAccounts, evidence };
  } catch {
    return { status: "unknown", accountEntry: null, sameCodeAccounts: [], evidence };
  }
}
