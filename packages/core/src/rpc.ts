// Minimal NEAR JSON-RPC client. Works in Node and browsers, retries transient failures, and can
// record or replay responses so unit tests are deterministic and offline.
import { base64ToBytes, bytesToBase64 } from "./hash.ts";

export type Network = "mainnet" | "testnet";

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
};
export const ARCHIVAL_RPC: Record<Network, string> = {
  mainnet: "https://archival-rpc.mainnet.fastnear.com",
  testnet: "https://archival-rpc.testnet.fastnear.com",
};

/** A deterministic answer from the chain (unknown account, method missing, contract panic). It is
 *  an answer, not an outage, so callers may treat it as "absent". Everything else is retried. */
export class RpcAnswerError extends Error {
  readonly kind: string;
  readonly data: unknown;
  constructor(message: string, kind: string, data: unknown) {
    super(message);
    this.kind = kind;
    this.data = data;
  }
}
const DETERMINISTIC =
  /UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CodeDoesNotExist|MethodResolveError|MethodNotFound|FunctionCallError|CompilationError|WasmTrap|HostError|TOO_LARGE_CONTRACT_STATE|UNKNOWN_ACCESS_KEY|UNKNOWN_BLOCK|GARBAGE_COLLECTED_BLOCK|does not exist|ProhibitedInView|Smart contract panicked|ExecutionError/;

export interface Transport {
  (url: string, body: string): Promise<{ status: number; json: unknown }>;
}
export const fetchTransport: Transport = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (proxy error page); treated as transient below */
  }
  return { status: r.status, json };
};

export interface RpcOptions {
  url?: string;
  network?: Network;
  transport?: Transport;
  retries?: number;
  /** Share identical requests within this client (default true). A one-shot inspect wants this; a
   *  long-running watcher must pass false, or it will keep reading its first answer. */
  cache?: boolean;
  /** Called for every request (method, params) and its result or error. Used to record fixtures. */
  onExchange?: (key: string, result: unknown, error: unknown) => void;
}

export function requestKey(method: string, params: unknown): string {
  return `${method} ${JSON.stringify(params)}`;
}

export class Rpc {
  readonly url: string;
  readonly network: Network;
  calls = 0;
  private transport: Transport;
  private retries: number;
  private onExchange?: RpcOptions["onExchange"];
  private cache = new Map<string, Promise<unknown>>();
  private useCache: boolean;

  constructor(opts: RpcOptions = {}) {
    this.network = opts.network ?? "mainnet";
    this.url = opts.url ?? DEFAULT_RPC[this.network];
    this.transport = opts.transport ?? fetchTransport;
    this.retries = opts.retries ?? 5;
    this.onExchange = opts.onExchange;
    this.useCache = opts.cache ?? true;
  }

  /** Same request within one Rpc instance is fetched once (finality-pinned reads are cheap to share). */
  call<T = any>(method: string, params: unknown): Promise<T> {
    const key = requestKey(method, params);
    // Only reads pinned to "final"/"optimistic" go stale; block-pinned reads never change.
    if (!this.useCache && /"finality"/.test(key)) return this.send(method, params, key) as Promise<T>;
    let p = this.cache.get(key);
    if (!p) {
      p = this.send(method, params, key);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p as Promise<T>;
  }

  private async send(method: string, params: unknown, key: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(250 * 2 ** attempt, 4000));
      this.calls++;
      let res: { status: number; json: any };
      try {
        res = (await this.transport(this.url, JSON.stringify({ jsonrpc: "2.0", id: "keyhole", method, params }))) as any;
      } catch (e) {
        lastErr = e;
        continue;
      }
      const j = res.json;
      if (!j || res.status === 429 || res.status >= 500) {
        lastErr = new Error(`RPC HTTP ${res.status}`);
        continue;
      }
      if (j.error) {
        const text = JSON.stringify(j.error);
        if (DETERMINISTIC.test(text)) {
          const err = new RpcAnswerError(text.slice(0, 300), j.error?.cause?.name ?? j.error?.name ?? "error", j.error);
          this.onExchange?.(key, undefined, j.error);
          throw err;
        }
        lastErr = new Error(`RPC error: ${text.slice(0, 300)}`);
        continue;
      }
      // Older nodes report contract execution errors inside result.error.
      if (j.result && typeof j.result === "object" && "error" in j.result && method === "query") {
        this.onExchange?.(key, undefined, { result_error: j.result.error });
        throw new RpcAnswerError(String(j.result.error).slice(0, 300), "ContractError", j.result.error);
      }
      this.onExchange?.(key, j.result, undefined);
      return j.result;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  block(ref: { finality: "final" | "optimistic" } | { block_id: number | string } = { finality: "final" }) {
    return this.call<any>("block", ref);
  }

  viewAccount(accountId: string, blockId?: number) {
    return this.call<AccountView>("query", { request_type: "view_account", account_id: accountId, ...ref(blockId) });
  }
  async viewAccessKeys(accountId: string, blockId?: number): Promise<AccessKeyInfo[]> {
    const r = await this.call<{ keys: AccessKeyInfo[] }>("query", { request_type: "view_access_key_list", account_id: accountId, ...ref(blockId) });
    return r.keys;
  }
  async viewCode(accountId: string, blockId?: number): Promise<{ hash: string; code: Uint8Array }> {
    const r = await this.call<{ hash: string; code_base64: string }>("query", { request_type: "view_code", account_id: accountId, ...ref(blockId) });
    return { hash: r.hash, code: base64ToBytes(r.code_base64) };
  }
  async viewGlobalCode(by: { codeHash: string } | { accountId: string }): Promise<{ hash: string; code: Uint8Array }> {
    const params =
      "codeHash" in by
        ? { request_type: "view_global_contract_code", code_hash: by.codeHash, finality: "final" }
        : { request_type: "view_global_contract_code_by_account_id", account_id: by.accountId, finality: "final" };
    const r = await this.call<{ hash: string; code_base64: string }>("query", params);
    return { hash: r.hash, code: base64ToBytes(r.code_base64) };
  }
  async view<T = unknown>(accountId: string, method: string, args: unknown = {}, blockId?: number): Promise<T> {
    const r = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      account_id: accountId,
      method_name: method,
      args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))),
      ...ref(blockId),
    });
    const text = new TextDecoder().decode(new Uint8Array(r.result));
    return (text.length ? JSON.parse(text) : null) as T;
  }
  /** View that returns null only when the chain deterministically says "no" (missing method, panic). */
  async tryView<T = unknown>(accountId: string, method: string, args: unknown = {}): Promise<T | null> {
    try {
      return await this.view<T>(accountId, method, args);
    } catch (e) {
      if (e instanceof RpcAnswerError || e instanceof SyntaxError) return null;
      throw e;
    }
  }
}

function ref(blockId?: number) {
  return blockId === undefined ? { finality: "final" } : { block_id: blockId };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  block_height: number;
  block_hash: string;
  global_contract_hash?: string;
  global_contract_account_id?: string;
}
export interface AccessKeyInfo {
  public_key: string;
  access_key: {
    nonce: number;
    permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

/** Replays recorded responses. Unknown requests fail loudly so tests never hit the network. */
export function fixtureTransport(fixtures: Record<string, { result?: unknown; error?: unknown }>): Transport {
  return async (_url, body) => {
    const { method, params } = JSON.parse(body);
    const f = fixtures[requestKey(method, params)];
    if (!f) throw new Error(`no fixture for ${requestKey(method, params).slice(0, 200)}`);
    if (f.error && (f.error as any).result_error) return { status: 200, json: { jsonrpc: "2.0", id: "keyhole", result: { error: (f.error as any).result_error, logs: [] } } };
    return { status: 200, json: f.error ? { jsonrpc: "2.0", id: "keyhole", error: f.error } : { jsonrpc: "2.0", id: "keyhole", result: f.result } };
  };
}

/** Wraps a transport and stores every answered request, for writing fixtures. */
export function recordingTransport(store: Record<string, { result?: unknown; error?: unknown }>, inner: Transport = fetchTransport): Transport {
  return async (url, body) => {
    const res = await inner(url, body);
    const { method, params } = JSON.parse(body);
    const j = res.json as any;
    if (j && res.status === 200) {
      if (j.error) store[requestKey(method, params)] = { error: j.error };
      else if (j.result && typeof j.result === "object" && "error" in j.result && method === "query") store[requestKey(method, params)] = { error: { result_error: j.result.error } };
      else store[requestKey(method, params)] = { result: j.result };
    }
    return res;
  };
}
