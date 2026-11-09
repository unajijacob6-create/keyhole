// Every claim Keyhole makes carries the request that re-checks it.
import type { Network } from "./rpc.ts";
import { DEFAULT_RPC, ARCHIVAL_RPC } from "./rpc.ts";
import { bytesToBase64 } from "./hash.ts";

export type Evidence =
  | { kind: "rpc"; network: Network; method: string; params: Record<string, unknown>; archival?: boolean; note?: string }
  | { kind: "url"; url: string; note?: string };

export const ev = {
  account: (network: Network, account_id: string, block_id?: number): Evidence => ({
    kind: "rpc",
    network,
    method: "query",
    params: { request_type: "view_account", account_id, ...(block_id ? { block_id } : { finality: "final" }) },
    archival: Boolean(block_id),
  }),
  keys: (network: Network, account_id: string): Evidence => ({ kind: "rpc", network, method: "query", params: { request_type: "view_access_key_list", account_id, finality: "final" } }),
  code: (network: Network, account_id: string): Evidence => ({ kind: "rpc", network, method: "query", params: { request_type: "view_code", account_id, finality: "final" }, note: "decode code_base64, then list WebAssembly.Module imports/exports" }),
  view: (network: Network, account_id: string, method_name: string, args: unknown = {}): Evidence => ({
    kind: "rpc",
    network,
    method: "query",
    params: { request_type: "call_function", account_id, method_name, args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))), finality: "final" },
    note: `${method_name}(${JSON.stringify(args)})`,
  }),
  url: (url: string, note?: string): Evidence => ({ kind: "url", url, note }),
};

/** A copy-pasteable command that re-checks the evidence. */
export function recheckCommand(e: Evidence): string {
  if (e.kind === "url") return `curl -s '${e.url}'`;
  const url = e.archival ? ARCHIVAL_RPC[e.network] : DEFAULT_RPC[e.network];
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: e.method, params: e.params });
  return `curl -s ${url} -H 'content-type: application/json' -d '${body}'`;
}

export function explorerAccount(network: Network, accountId: string) {
  return `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${accountId}`;
}
export function explorerTx(network: Network, hash: string) {
  return `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;
}
