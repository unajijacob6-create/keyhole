// Run a constant view method of a NEAR contract's wasm locally, in a stub host environment.
//
// Purpose: read NEP-330 `contract_source_metadata` from code that is NOT deployed yet (bytes a DAO
// stored for an upgrade proposal, or near-plugins staged code), so the declared repository, commit
// and build image of a pending upgrade are known before the vote.
//
// The stub implements only what a constant getter needs (registers, input, value_return, a zero
// attached deposit, logs, panics). Any other host call (storage, promises, block info, ...) traps,
// so a method that depends on state simply fails here instead of returning something misleading.
// The answer is what the bytes *claim*; it proves nothing about the source until a reproducible
// build of that source yields the same hash.
import type { SourceMetadata } from "./sources.ts";

export class WasmViewError extends Error {}

const MAX_MEMORY_PAGES = 2048; // 128 MiB
const MAX_RETURN = 64 * 1024;

export async function runConstantView(bytes: Uint8Array, method: string): Promise<string | null> {
  const mod = await WebAssembly.compile(bytes as BufferSource);
  if (!WebAssembly.Module.exports(mod).some((e) => e.kind === "function" && e.name === method)) return null;
  let mem: WebAssembly.Memory | null = null;
  const regs = new Map<bigint, Uint8Array>();
  let ret: Uint8Array | null = null;
  const u8 = () => new Uint8Array(mem!.buffer);
  const dv = () => new DataView(mem!.buffer);
  const str = (len: bigint, ptr: bigint) => new TextDecoder().decode(u8().slice(Number(ptr), Number(ptr + len)));
  const host: Record<string, (...a: any[]) => any> = {
    read_register: (id: bigint, ptr: bigint) => {
      const d = regs.get(id);
      if (d) u8().set(d, Number(ptr));
    },
    register_len: (id: bigint) => (regs.has(id) ? BigInt(regs.get(id)!.length) : 0xffffffffffffffffn),
    write_register: (id: bigint, len: bigint, ptr: bigint) => void regs.set(id, u8().slice(Number(ptr), Number(ptr + len))),
    input: (id: bigint) => void regs.set(id, new Uint8Array()),
    value_return: (len: bigint, ptr: bigint) => {
      if (len > BigInt(MAX_RETURN)) throw new WasmViewError("return value too large");
      ret = u8().slice(Number(ptr), Number(ptr + len));
    },
    attached_deposit: (ptr: bigint) => {
      dv().setBigUint64(Number(ptr), 0n, true);
      dv().setBigUint64(Number(ptr) + 8, 0n, true);
    },
    log_utf8: () => {},
    log_utf16: () => {},
    panic: () => {
      throw new WasmViewError("contract panicked");
    },
    panic_utf8: (len: bigint, ptr: bigint) => {
      throw new WasmViewError(`contract panicked: ${str(len, ptr).slice(0, 200)}`);
    },
    abort: () => {
      throw new WasmViewError("contract aborted");
    },
  };
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ??= {};
    if (imp.kind === "function") {
      imports[imp.module][imp.name] =
        host[imp.name] ??
        (() => {
          throw new WasmViewError(`host function ${imp.name} is not available to a constant view`);
        });
    } else if (imp.kind === "memory") {
      mem = new WebAssembly.Memory({ initial: 17, maximum: MAX_MEMORY_PAGES });
      imports[imp.module][imp.name] = mem;
    }
  }
  const inst = await WebAssembly.instantiate(mod, imports as WebAssembly.Imports);
  if (!mem) mem = inst.exports.memory as WebAssembly.Memory;
  try {
    (inst.exports[method] as () => void)();
  } catch (e) {
    if (e instanceof WasmViewError) throw e;
    throw new WasmViewError(`wasm trap: ${String((e as Error).message).slice(0, 120)}`);
  }
  return ret ? new TextDecoder().decode(ret) : null;
}

/** NEP-330 metadata embedded in wasm bytes, or null if the code does not export it or it fails. */
export async function sourceMetadataFromWasm(bytes: Uint8Array): Promise<SourceMetadata | null> {
  try {
    const text = await runConstantView(bytes, "contract_source_metadata");
    return text ? (JSON.parse(text) as SourceMetadata) : null;
  } catch {
    return null;
  }
}
