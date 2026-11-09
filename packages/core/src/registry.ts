// Client for the Keyhole registry contract (attestations keyed by code hash). Attestations are
// signed claims by named attesters, not facts; each kind says how to re-check it.
import { Rpc, type Network } from "./rpc.ts";
import { ev, type Evidence } from "./evidence.ts";

export const KEYHOLE_REGISTRY = { network: "testnet" as Network, account: "registry.keyhole.testnet" };

export type Attestation =
  | { kind: "ChangeObserved"; account: string; old_hash: string; new_hash: string; block_height: number }
  | { kind: "ReproducibleBuild"; account: string | null; repo: string; rev: string; image_digest: string; matches: boolean }
  | { kind: "AiReview"; model: string; request_sha256: string; response_sha256: string; signer: string; chat_id: string; verdict_summary: string }
  | { kind: "KeyAdded"; account: string; public_key: string; block_height: number };

export interface AttestationRecord {
  id: number;
  code_hash: string;
  attestation: Attestation;
  attester: string;
  block_height: number;
  timestamp_ms: number;
}

export interface RegistrySignal {
  available: boolean;
  registry: string;
  forHash: AttestationRecord[];
  latestChange: AttestationRecord | null;
  keyEvents: AttestationRecord[];
  evidence: Evidence[];
  error?: string;
}

export function registryRpc(opts: { url?: string } = {}) {
  return new Rpc({ network: KEYHOLE_REGISTRY.network, url: opts.url });
}

/** Normalise the registry's JSON (enum may be externally tagged {"ChangeObserved": {...}} or {"kind": ...}). */
export function normaliseRecord(r: any): AttestationRecord {
  let a = r.attestation;
  if (a && !a.kind) {
    const [kind] = Object.keys(a);
    a = { kind, ...a[kind] };
  }
  return { ...r, attestation: a };
}

export async function registryLookup(rpc: Rpc, account: string, codeHash: string, registry = KEYHOLE_REGISTRY.account): Promise<RegistrySignal> {
  const n = rpc.network;
  const evidence = [ev.view(n, registry, "get_attestations", { code_hash: codeHash }), ev.view(n, registry, "get_latest", { account_id: account })];
  try {
    const [forHash, latest, keys] = await Promise.all([
      rpc.view<any[]>(registry, "get_attestations", { code_hash: codeHash, from_index: 0, limit: 50 }),
      rpc.view<any | null>(registry, "get_latest", { account_id: account }),
      rpc.tryView<any[]>(registry, "get_key_events", { account_id: account, from_index: 0, limit: 50 }),
    ]);
    return {
      available: true,
      registry,
      forHash: (forHash ?? []).map(normaliseRecord),
      latestChange: latest ? normaliseRecord(latest) : null,
      keyEvents: (keys ?? []).map(normaliseRecord),
      evidence,
    };
  } catch (e) {
    const msg = String((e as Error).message);
    const error = /UNKNOWN_ACCOUNT|does not exist/.test(msg) ? `${registry} not found on ${n}` : /MethodNotFound|CodeDoesNotExist|NO_CONTRACT_CODE/.test(msg) ? `${registry} has no registry code` : msg.slice(0, 120);
    return { available: false, registry, forHash: [], latestChange: null, keyEvents: [], evidence, error };
  }
}
