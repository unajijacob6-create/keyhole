// inspect(accountId): collect every signal from public RPC (no Keyhole server involved) and grade it.
import { Rpc, RpcAnswerError, type Network, type Transport, type AccessKeyInfo } from "./rpc.ts";
import { EMPTY_CODE_HASH, codeHash as computeCodeHash } from "./hash.ts";
import { analyzeWasm, type WasmAnalysis } from "./wasm.ts";
import { discoverOwners, resolveActor, type ActorInfo, type OwnerCandidate } from "./controller.ts";
import { nep330, sourcescan, type Nep330Signal, type SourceScanSignal, type SourceOptions } from "./sources.ts";
import { registryLookup, registryRpc, KEYHOLE_REGISTRY, type RegistrySignal } from "./registry.ts";
import { lastCodeChange, type CodeChange } from "./history.ts";
import { grade, type Grade, type UpgradePath, type GradeInput } from "./grade.ts";
import { ev, type Evidence } from "./evidence.ts";

export interface InspectOptions {
  network?: Network;
  rpcUrl?: string;
  transport?: Transport;
  /** Search archival RPC for the last code change (default true; ~25 extra calls). */
  history?: boolean;
  archivalUrl?: string;
  /** Query the Keyhole registry (default true). Pass an Rpc to use a custom endpoint/transport. */
  registry?: boolean | { rpc?: Rpc; account?: string };
  checkRepo?: SourceOptions["checkRepo"];
  nowMs?: number;
  /** Resolved code (e.g. from a block stream) to avoid a second view_code. */
  rpc?: Rpc;
}

export interface KeyholeReport {
  schema: "keyhole.report/1";
  account: string;
  network: Network;
  at: { height: number; time: string };
  exists: boolean;
  code: null | {
    hash: string;
    size: number;
    source: "local" | "global-by-hash" | "global-by-account";
    globalAccount?: string;
    hashMatchesBytes: boolean;
  };
  keys: { fullAccess: string[]; functionCall: { publicKey: string; receiver: string; methods: string[]; allowance: string | null }[] };
  wasm: null | Omit<WasmAnalysis, "capabilities"> & { capabilities: WasmAnalysis["capabilities"] };
  owners: (OwnerCandidate & { actor: ActorInfo | null; note?: string })[];
  globalPublisher: ActorInfo | null;
  paths: UpgradePath[];
  nep330: Nep330Signal | null;
  sourcescan: SourceScanSignal | null;
  registry: RegistrySignal | null;
  lastChange: CodeChange | null;
  grade: Grade;
  rpcCalls: number;
  disclaimer: string;
}

export const DISCLAIMER =
  "Keyhole describes trust assumptions from public on-chain data. It is not a security audit; controller resolution is heuristic and marked as inferred.";

const PATH_CAPS = ["deploy_contract", "use_global_contract", "add_full_access_key"] as const;

export async function inspect(accountId: string, opts: InspectOptions = {}): Promise<KeyholeReport> {
  const network = opts.network ?? (accountId.endsWith(".testnet") ? "testnet" : "mainnet");
  const rpc = opts.rpc ?? new Rpc({ network, url: opts.rpcUrl, transport: opts.transport });
  const nowMs = opts.nowMs ?? Date.now();
  const head = await rpc.block({ finality: "final" });
  const at = { height: head.header.height as number, time: new Date(Number(BigInt(head.header.timestamp_nanosec) / 1_000_000n)).toISOString() };

  let acct;
  try {
    acct = await rpc.viewAccount(accountId);
  } catch (e) {
    if (e instanceof RpcAnswerError) {
      const g = grade({ hasCode: false, paths: [], immutabilityFacts: [], verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] }, nep330: { present: false, hasBuildInfo: false, repoStatus: "none", evidence: [] }, globalByAccount: null, lastChange: null, fullAccessKeyAdded: [], nowMs });
      g.headline = "Account does not exist.";
      g.reasons = [{ code: "NO_ACCOUNT", severity: "info", text: `${accountId} does not exist on ${network}.`, evidence: [ev.account(network, accountId)] }];
      return { schema: "keyhole.report/1", account: accountId, network, at, exists: false, code: null, keys: { fullAccess: [], functionCall: [] }, wasm: null, owners: [], globalPublisher: null, paths: [], nep330: null, sourcescan: null, registry: null, lastChange: null, grade: g, rpcCalls: rpc.calls, disclaimer: DISCLAIMER };
    }
    throw e;
  }

  const keyList: AccessKeyInfo[] = await rpc.viewAccessKeys(accountId);
  const keys = {
    fullAccess: keyList.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key),
    functionCall: keyList.flatMap((k) =>
      k.access_key.permission === "FullAccess"
        ? []
        : [{ publicKey: k.public_key, receiver: k.access_key.permission.FunctionCall.receiver_id, methods: k.access_key.permission.FunctionCall.method_names, allowance: k.access_key.permission.FunctionCall.allowance }],
    ),
  };
  const paths: UpgradePath[] = [];
  if (keys.fullAccess.length) {
    paths.push({
      via: "full-access-key",
      control: "single-key",
      text: `${keys.fullAccess.length} full-access key${keys.fullAccess.length === 1 ? "" : "s"} on ${accountId}. Any one of them can deploy new code.`,
      evidence: [ev.keys(network, accountId)],
    });
  }

  const hasCode = acct.code_hash !== EMPTY_CODE_HASH || Boolean(acct.global_contract_hash || acct.global_contract_account_id);
  const registryOpt = opts.registry ?? true;
  const regRpc = typeof registryOpt === "object" && registryOpt.rpc ? registryOpt.rpc : registryRpc();
  const regAccount = typeof registryOpt === "object" && registryOpt.account ? registryOpt.account : KEYHOLE_REGISTRY.account;

  if (!hasCode) {
    const registry = registryOpt ? await registryLookup(regRpc, accountId, EMPTY_CODE_HASH, regAccount) : null;
    const g = grade({
      hasCode: false,
      paths,
      immutabilityFacts: [],
      verification: { sourcescan: "none", reproducibleBuildMatch: null, aiReviewed: false, evidence: [] },
      nep330: { present: false, hasBuildInfo: false, repoStatus: "none", evidence: [] },
      globalByAccount: null,
      lastChange: null,
      fullAccessKeyAdded: keyAddedEvents(registry),
      nowMs,
    });
    return { schema: "keyhole.report/1", account: accountId, network, at, exists: true, code: null, keys, wasm: null, owners: [], globalPublisher: null, paths, nep330: null, sourcescan: null, registry, lastChange: null, grade: g, rpcCalls: rpc.calls + regRpc.calls, disclaimer: DISCLAIMER };
  }

  // ── Code and wasm capabilities ──
  const { code: bytes, hash: servedHash } = await rpc.viewCode(accountId);
  const source = acct.global_contract_account_id ? "global-by-account" : acct.global_contract_hash ? "global-by-hash" : "local";
  const effHash = source === "local" ? acct.code_hash : (acct.global_contract_hash ?? servedHash);
  const computed = await computeCodeHash(bytes);
  const wasm = analyzeWasm(bytes);

  // ── Paths through the contract's own code ──
  const capImports = PATH_CAPS.filter((c) => wasm.capabilities[c]);
  const owners: KeyholeReport["owners"] = [];
  if (capImports.length) {
    const candidates = await discoverOwners(rpc, accountId, wasm.exports);
    for (const c of candidates) {
      if (c.account === accountId) {
        owners.push({ ...c, actor: null, note: "the contract names itself; it can only act through its own methods and keys" });
        continue;
      }
      owners.push({ ...c, actor: await resolveActor(rpc, c.account) });
    }
    // Methods tied to the path: specific call paths first; otherwise upgrade-like names that at
    // least reach a code-change capability through the shared action dispatcher.
    const specific = wasm.codeChangeEntrypoints ?? [];
    const methods = specific.length ? specific : wasm.upgradeLikeNames.filter((n) => wasm.codeChangeViaDispatcher === null || wasm.codeChangeViaDispatcher.includes(n));
    const tied = capImports.filter((c) => wasm.capabilities[c]?.reachableFrom?.some((m) => methods.includes(m)));
    const capText = (tied.length ? tied : capImports).map((c) => c.replace(/_/g, " ")).join(" / ");
    const external = owners.filter((o) => o.actor);
    const methodText = methods.length ? `method${methods.length === 1 ? "" : "s"} ${methods.map((m) => `\`${m}\``).join(", ")}` : "no recognised upgrade method";
    const codeEv = ev.code(network, accountId);
    if (!external.length) {
      paths.push({
        via: "contract-method",
        control: "unresolved",
        methods,
        text: methods.length
          ? `The contract can ${capText} through ${methodText}; the owner that gates it was not found (inferred).`
          : `The code links the ${capText} host function, but Keyhole found no method that uses it. Immutability cannot be proven.`,
        evidence: [codeEv],
      });
    } else {
      const ctl = external.map((o) => o.actor!.singleKey);
      const control = ctl.some((x) => x === true) ? "single-key" : ctl.some((x) => x === null || x === undefined) ? "unresolved" : external.every((o) => !o.actor!.exists) ? "unresolved" : "governed";
      const ownerText = external.map((o) => `${o.account} via ${o.source} — ${o.actor!.summary}`).join("; ");
      paths.push({ via: "contract-method", control, methods, text: `The contract can ${capText} through ${methodText}, gated by its owner (inferred): ${ownerText}.`, evidence: [codeEv, ...external.flatMap((o) => [o.evidence, ...o.actor!.evidence])] });
    }
  }

  // ── Global contract referenced by account: the publisher can change this account's code ──
  let globalPublisher: ActorInfo | null = null;
  if (acct.global_contract_account_id) {
    globalPublisher = await resolveActor(rpc, acct.global_contract_account_id);
    paths.push({
      via: "global-contract-publisher",
      control: globalPublisher.singleKey === true ? "single-key" : globalPublisher.singleKey === false && globalPublisher.exists ? "governed" : "unresolved",
      text: `Runs the global contract published by ${acct.global_contract_account_id}. When the publisher redeploys, this account's code changes too. ${globalPublisher.summary}.`,
      evidence: [ev.account(network, accountId), ...globalPublisher.evidence],
    });
  }

  // ── Verification, registry, history (independent; run in parallel) ──
  const [nep, ss, registry, lastChange] = await Promise.all([
    nep330(rpc, accountId, wasm.exports, { checkRepo: opts.checkRepo }),
    sourcescan(rpc, accountId, effHash),
    registryOpt ? registryLookup(regRpc, accountId, effHash, regAccount) : Promise.resolve(null),
    opts.history === false ? Promise.resolve(null) : lastCodeChange(rpc, accountId, effHash, at.height, { archivalUrl: opts.archivalUrl, transport: opts.transport }),
  ]);

  const immutabilityFacts = [
    "no full-access keys",
    `the code does not import ${PATH_CAPS.map((c) => c.replace(/_/g, " ")).join(" / ")} host functions`,
    source === "global-by-account" ? "" : "it is not a global contract referenced by account",
  ].filter(Boolean);

  const builds = registry?.forHash.filter((r) => r.attestation.kind === "ReproducibleBuild") ?? [];
  const reproducibleBuildMatch = builds.length ? builds.some((r) => (r.attestation as any).matches === true) : null;
  const aiReviewed = registry?.forHash.some((r) => r.attestation.kind === "AiReview") ?? false;

  // Last change: prefer the archival search; fall back to the registry's ChangeObserved record.
  let lc: GradeInput["lastChange"] = null;
  if (lastChange?.status === "found" && lastChange.timestamp) lc = { timestampMs: Date.parse(lastChange.timestamp), source: `block ${lastChange.height}`, evidence: lastChange.evidence };
  const obs = registry?.latestChange;
  if (obs && (obs.attestation as any).new_hash === effHash && (!lc || obs.timestamp_ms > (lc.timestampMs ?? 0))) {
    lc = { timestampMs: obs.timestamp_ms, source: `observed by ${obs.attester} at block ${(obs.attestation as any).block_height}`, evidence: registry!.evidence };
  }

  const g = grade({
    hasCode: true,
    paths,
    immutabilityFacts,
    verification: { sourcescan: ss.status, reproducibleBuildMatch, aiReviewed, evidence: [...ss.evidence, ...(registry?.evidence.slice(0, 1) ?? [])] },
    nep330: { present: nep.present, hasBuildInfo: nep.hasBuildInfo, repoStatus: nep.repoStatus, evidence: nep.evidence },
    globalByAccount: acct.global_contract_account_id ?? null,
    lastChange: lc,
    fullAccessKeyAdded: keyAddedEvents(registry),
    nowMs,
  });

  return {
    schema: "keyhole.report/1",
    account: accountId,
    network,
    at,
    exists: true,
    code: { hash: effHash, size: bytes.length, source, globalAccount: acct.global_contract_account_id, hashMatchesBytes: computed === servedHash },
    keys,
    wasm,
    owners,
    globalPublisher,
    paths,
    nep330: nep,
    sourcescan: ss,
    registry,
    lastChange,
    grade: g,
    rpcCalls: rpc.calls + regRpc.calls,
    disclaimer: DISCLAIMER,
  };
}

function keyAddedEvents(registry: RegistrySignal | null): GradeInput["fullAccessKeyAdded"] {
  return (registry?.keyEvents ?? [])
    .filter((r) => r.attestation.kind === "KeyAdded")
    .map((r) => ({ timestampMs: r.timestamp_ms, publicKey: (r.attestation as any).public_key, evidence: registry!.evidence }));
}

export type { Evidence };
