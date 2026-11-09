// Static analysis of a NEAR contract's wasm, without source.
//
// 1. Which NEAR host functions it imports (e.g. promise_batch_action_deploy_contract).
// 2. Which exported methods can reach each sensitive host function through the call graph.
//
// The call graph over-approximates: a `call_indirect` may target any function placed in a table
// (element segments or `ref.func`) whose signature matches. So "not reachable" is a proof for the
// code as deployed; "reachable" means "a path exists", not "anyone may call it" (access checks
// inside the method are invisible here). If the decoder meets an instruction it does not know, the
// reachability result is marked unavailable and callers fall back to import-level facts.

export type Capability =
  | "deploy_contract"
  | "deploy_global_contract"
  | "use_global_contract"
  | "add_full_access_key"
  | "add_function_call_key"
  | "delete_key"
  | "delete_account"
  | "transfer"
  | "function_call"
  | "stake"
  | "state_init";

/** Host function name → capability. Names from nearcore runtime/near-vm-runner/src/imports.rs. */
export const HOST_CAPABILITIES: Record<string, Capability> = {
  promise_batch_action_deploy_contract: "deploy_contract",
  promise_batch_action_deploy_global_contract: "deploy_global_contract",
  promise_batch_action_deploy_global_contract_by_account_id: "deploy_global_contract",
  promise_batch_action_use_global_contract: "use_global_contract",
  promise_batch_action_use_global_contract_by_account_id: "use_global_contract",
  promise_batch_action_add_key_with_full_access: "add_full_access_key",
  promise_batch_action_add_gas_key_with_full_access: "add_full_access_key",
  promise_batch_action_add_key_with_function_call: "add_function_call_key",
  promise_batch_action_add_gas_key_with_function_call: "add_function_call_key",
  promise_batch_action_delete_key: "delete_key",
  promise_batch_action_delete_account: "delete_account",
  promise_batch_action_transfer: "transfer",
  promise_batch_action_function_call: "function_call",
  promise_batch_action_function_call_weight: "function_call",
  promise_create: "function_call",
  promise_then: "function_call",
  promise_batch_action_stake: "stake",
  promise_batch_action_state_init: "state_init",
  promise_batch_action_state_init_by_account_id: "state_init",
};

/** Capabilities that can replace the code that runs on this account (directly or by adding a key). */
export const CODE_CHANGE_CAPABILITIES: Capability[] = ["deploy_contract", "use_global_contract", "add_full_access_key"];

export interface WasmAnalysis {
  size: number;
  imports: string[]; // host function names (module "env")
  exports: string[]; // exported function names
  /** reachableFrom: exported methods with a call path to the host function that avoids generic
   *  action dispatchers. viaDispatcherOnly: methods that reach it only through such a dispatcher
   *  (they create *some* promise action; the analysis cannot tell which). null = unavailable. */
  capabilities: Partial<Record<Capability, { imports: string[]; reachableFrom: string[] | null; viaDispatcherOnly: string[] | null }>>;
  /** Exported methods with a specific call path to a code-change capability (null = unavailable). */
  codeChangeEntrypoints: string[] | null;
  /** Exported methods that reach a code-change capability only through a generic action dispatcher. */
  codeChangeViaDispatcher: string[] | null;
  /** Number of generic action dispatchers found. */
  dispatchers: number;
  /** Names matching the usual upgrade naming, independent of reachability (a hint only). */
  upgradeLikeNames: string[];
  reachability: { available: boolean; reason?: string; functions: number; indirectTargets: number };
}

const DISPATCH_DEPTH = Number((globalThis as any).process?.env?.KEYHOLE_DISPATCH_DEPTH ?? 4);
export const UPGRADE_NAME = /upgrade|migrate|deploy|up_deploy_code|update_contract|set_code|propose_update|vote_update|stage_code/i;

class Reader {
  pos = 0;
  readonly b: Uint8Array;
  readonly end: number;
  constructor(b: Uint8Array, start = 0, end = b.length) {
    this.b = b;
    this.end = end;
    this.pos = start;
  }
  eof() {
    return this.pos >= this.end;
  }
  byte() {
    if (this.pos >= this.end) throw new Error("unexpected end");
    return this.b[this.pos++];
  }
  u32() {
    let result = 0,
      shift = 0,
      byte: number;
    do {
      byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  /** Signed LEB; value is not needed, only its length. */
  skipLeb() {
    while (this.byte() & 0x80);
  }
  skip(n: number) {
    this.pos += n;
    if (this.pos > this.end) throw new Error("unexpected end");
  }
  name() {
    const n = this.u32();
    const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

class UnknownOpcode extends Error {}

interface Body {
  calls: Set<number>;
  indirectTypes: Set<number>;
  refFuncs: Set<number>;
}

/** Decode one function body (or const expr) and collect call edges. Stops at the matching `end`
 *  for const exprs (depth 0) or at the body end. */
function scanInstructions(r: Reader, out: Body, constExpr = false) {
  let depth = 0;
  while (!r.eof()) {
    const op = r.byte();
    switch (op) {
      case 0x02:
      case 0x03:
      case 0x04: {
        // block type: 0x40 | valtype | s33 type index
        const bt = r.b[r.pos];
        if (bt === 0x40 || (bt >= 0x6f && bt <= 0x7f) || bt === 0x63 || bt === 0x64) r.pos++;
        else r.skipLeb();
        depth++;
        break;
      }
      case 0x05: // else
        break;
      case 0x0b: // end
        if (depth === 0) {
          if (constExpr) return;
          // function end; trailing bytes should not exist
          break;
        }
        depth--;
        break;
      case 0x0c:
      case 0x0d:
        r.u32();
        break;
      case 0x0e: {
        const n = r.u32();
        for (let i = 0; i <= n; i++) r.u32();
        break;
      }
      case 0x10:
      case 0x12:
        out.calls.add(r.u32());
        break;
      case 0x11:
      case 0x13:
        out.indirectTypes.add(r.u32());
        r.u32();
        break;
      case 0x1c: {
        const n = r.u32();
        r.skip(n);
        break;
      }
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26:
        r.u32();
        break;
      case 0x3f:
      case 0x40:
        r.u32();
        break;
      case 0x41:
      case 0x42:
        r.skipLeb();
        break;
      case 0x43:
        r.skip(4);
        break;
      case 0x44:
        r.skip(8);
        break;
      case 0xd0: {
        const t = r.b[r.pos];
        if (t >= 0x6a && t <= 0x74) r.pos++;
        else r.skipLeb();
        break;
      }
      case 0xd2:
        out.refFuncs.add(r.u32());
        break;
      case 0xfc: {
        const sub = r.u32();
        if (sub <= 7) break;
        if (sub === 8) (r.u32(), r.u32());
        else if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) r.u32();
        else if (sub === 10 || sub === 12 || sub === 14) (r.u32(), r.u32());
        else if (sub === 11) r.u32();
        else throw new UnknownOpcode(`0xfc ${sub}`);
        break;
      }
      default:
        if (op >= 0x28 && op <= 0x3e) {
          // memarg: align (bit 6 set → memory index follows), offset
          const align = r.u32();
          if (align & 0x40) r.u32();
          r.u32();
        } else if (op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xc4) || op === 0xd1) {
          // no immediates
        } else {
          throw new UnknownOpcode(`0x${op.toString(16)}`);
        }
    }
  }
}

export function analyzeWasm(bytes: Uint8Array): WasmAnalysis {
  const r = new Reader(bytes);
  if (bytes.length < 8 || r.b[0] !== 0x00 || r.b[1] !== 0x61 || r.b[2] !== 0x73 || r.b[3] !== 0x6d) throw new Error("not a wasm module");
  r.pos = 8;

  const types: string[] = []; // signature as string, for structural equality
  const importedFuncs: { name: string; type: number }[] = [];
  const funcTypes: number[] = []; // defined functions' type indices
  const exports: { name: string; func: number }[] = [];
  const indirectTargets = new Set<number>();
  const bodies: Body[] = [];
  let startFunc: number | null = null;
  let reachabilityError: string | undefined;

  while (!r.eof()) {
    const id = r.byte();
    const size = r.u32();
    const end = r.pos + size;
    const s = new Reader(bytes, r.pos, end);
    try {
      if (id === 1) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const form = s.byte();
          if (form !== 0x60) throw new Error(`unsupported type form 0x${form.toString(16)}`);
          const np = s.u32();
          const params = Array.from(bytes.subarray(s.pos, s.pos + np));
          s.skip(np);
          const nr = s.u32();
          const results = Array.from(bytes.subarray(s.pos, s.pos + nr));
          s.skip(nr);
          types.push(`${params.join(",")}->${results.join(",")}`);
        }
      } else if (id === 2) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          s.name(); // module
          const field = s.name();
          const kind = s.byte();
          if (kind === 0) importedFuncs.push({ name: field, type: s.u32() });
          else if (kind === 1) {
            s.byte();
            const flags = s.u32();
            s.u32();
            if (flags & 1) s.u32();
          } else if (kind === 2) {
            const flags = s.u32();
            s.u32();
            if (flags & 1) s.u32();
          } else if (kind === 3) (s.byte(), s.byte());
          else throw new Error(`import kind ${kind}`);
        }
      } else if (id === 3) {
        const n = s.u32();
        for (let i = 0; i < n; i++) funcTypes.push(s.u32());
      } else if (id === 6) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          s.byte();
          s.byte();
          const b: Body = { calls: new Set(), indirectTypes: new Set(), refFuncs: new Set() };
          scanInstructions(s, b, true);
          b.refFuncs.forEach((f) => indirectTargets.add(f));
        }
      } else if (id === 7) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const name = s.name();
          const kind = s.byte();
          const idx = s.u32();
          if (kind === 0) exports.push({ name, func: idx });
        }
      } else if (id === 8) {
        startFunc = s.u32();
      } else if (id === 9) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const flags = s.u32();
          const scratch: Body = { calls: new Set(), indirectTypes: new Set(), refFuncs: new Set() };
          if (flags & 2 && !(flags & 1)) s.u32(); // explicit table index (flags 2, 6)
          if (!(flags & 1)) scanInstructions(s, scratch, true); // active: offset expr
          if (flags & 4) {
            if (flags & 3) s.byte(); // reftype
            const m = s.u32();
            for (let j = 0; j < m; j++) scanInstructions(s, scratch, true);
          } else {
            if (flags & 3) s.byte(); // elemkind
            const m = s.u32();
            for (let j = 0; j < m; j++) indirectTargets.add(s.u32());
          }
          scratch.refFuncs.forEach((f) => indirectTargets.add(f));
        }
      } else if (id === 10) {
        const n = s.u32();
        for (let i = 0; i < n; i++) {
          const bodySize = s.u32();
          const bodyEnd = s.pos + bodySize;
          const br = new Reader(bytes, s.pos, bodyEnd);
          const locals = br.u32();
          for (let j = 0; j < locals; j++) (br.u32(), br.byte());
          const b: Body = { calls: new Set(), indirectTypes: new Set(), refFuncs: new Set() };
          if (!reachabilityError) {
            try {
              scanInstructions(br, b);
            } catch (e) {
              reachabilityError = e instanceof UnknownOpcode ? `unknown opcode ${e.message}` : String(e);
            }
          }
          b.refFuncs.forEach((f) => indirectTargets.add(f));
          bodies.push(b);
          s.pos = bodyEnd;
        }
      }
    } catch (e) {
      if (id === 2 || id === 7) throw e; // imports/exports are required
      reachabilityError ??= `section ${id}: ${String(e)}`;
    }
    r.pos = end;
  }

  const nImp = importedFuncs.length;
  const typeOf = (f: number) => (f < nImp ? importedFuncs[f].type : funcTypes[f - nImp]);
  const imports = importedFuncs.map((f) => f.name);
  const exportNames = exports.map((e) => e.name);

  // Reverse call graph: callee → callers.
  const callers = new Map<number, Set<number>>();
  const addEdge = (from: number, to: number) => {
    let set = callers.get(to);
    if (!set) callers.set(to, (set = new Set()));
    set.add(from);
  };
  const indirectByType = new Map<string, number[]>();
  for (const f of indirectTargets) {
    const sig = types[typeOf(f)];
    if (sig === undefined) continue;
    (indirectByType.get(sig) ?? indirectByType.set(sig, []).get(sig)!).push(f);
  }
  if (!reachabilityError && bodies.length !== funcTypes.length) reachabilityError = "code/function section mismatch";
  if (!reachabilityError) {
    bodies.forEach((b, i) => {
      const self = nImp + i;
      b.calls.forEach((c) => addEdge(self, c));
      b.indirectTypes.forEach((t) => (indirectByType.get(types[t]) ?? []).forEach((c) => addEdge(self, c)));
    });
  }
  const reachers = (targets: number[]): Set<number> => {
    const seen = new Set<number>(targets);
    const queue = [...targets];
    while (queue.length) {
      const f = queue.pop()!;
      callers.get(f)?.forEach((c) => {
        if (!seen.has(c)) (seen.add(c), queue.push(c));
      });
    }
    return seen;
  };
  const roots = [...exports.map((e) => ({ name: e.name, func: e.func })), ...(startFunc !== null ? [{ name: "(start)", func: startFunc }] : [])];

  // near-sdk routes every Promise action (transfer, function call, deploy, add key, ...) through one
  // generic dispatcher. A path through it proves only "this method creates *an* action". So we
  // find dispatchers (functions that reach >= 3 distinct action host functions within two direct
  // calls) and split reachability into paths that avoid them (specific) and paths that need them.
  const callees = (f: number) => (f >= nImp ? bodies[f - nImp]?.calls : undefined) ?? new Set<number>();
  const actionImportIdx = new Set(importedFuncs.map((f, i) => (f.name.startsWith("promise_batch_action_") ? i : -1)).filter((i) => i >= 0));
  const dispatchers = new Set<number>();
  if (!reachabilityError) {
    // Forward adjacency including indirect targets, for a bounded-depth search.
    const fwd = (f: number): Iterable<number> => {
      const b = f >= nImp ? bodies[f - nImp] : undefined;
      if (!b) return [];
      const out = new Set<number>(b.calls);
      b.indirectTypes.forEach((t) => (indirectByType.get(types[t]) ?? []).forEach((c) => out.add(c)));
      return out;
    };
    for (let f = nImp; f < nImp + bodies.length; f++) {
      const hit = new Set<number>();
      let frontier = new Set<number>([f]);
      const seen = new Set<number>([f]);
      for (let d = 0; d < DISPATCH_DEPTH && hit.size < 3; d++) {
        const next = new Set<number>();
        frontier.forEach((g) => {
          for (const c of fwd(g)) {
            if (actionImportIdx.has(c)) hit.add(c);
            else if (!seen.has(c)) (seen.add(c), next.add(c));
          }
        });
        frontier = next;
      }
      if (hit.size >= 3) dispatchers.add(f);
    }
  }
  const reachersAvoiding = (target: number): Set<number> => {
    const seen = new Set<number>([target]);
    const queue = [target];
    while (queue.length) {
      const f = queue.pop()!;
      callers.get(f)?.forEach((c) => {
        if (!seen.has(c) && !dispatchers.has(c)) (seen.add(c), queue.push(c));
      });
    }
    return seen;
  };

  const capabilities: WasmAnalysis["capabilities"] = {};
  importedFuncs.forEach((imp, idx) => {
    const cap = HOST_CAPABILITIES[imp.name];
    if (!cap) return;
    const entry = (capabilities[cap] ??= { imports: [], reachableFrom: reachabilityError ? null : [], viaDispatcherOnly: reachabilityError ? null : [] });
    entry.imports.push(imp.name);
    if (!reachabilityError) {
      const all = reachers([idx]);
      const specific = reachersAvoiding(idx);
      for (const root of roots) {
        if (specific.has(root.func)) entry.reachableFrom!.includes(root.name) || entry.reachableFrom!.push(root.name);
        else if (all.has(root.func)) entry.viaDispatcherOnly!.includes(root.name) || entry.viaDispatcherOnly!.push(root.name);
      }
    }
  });
  for (const c of Object.values(capabilities)) {
    c?.reachableFrom?.sort();
    if (c?.viaDispatcherOnly) c.viaDispatcherOnly = c.viaDispatcherOnly.filter((n) => !c.reachableFrom!.includes(n)).sort();
  }

  let codeChangeEntrypoints: string[] | null = null;
  let codeChangeViaDispatcher: string[] | null = null;
  if (!reachabilityError) {
    const specific = new Set<string>();
    const via = new Set<string>();
    for (const cap of CODE_CHANGE_CAPABILITIES) {
      capabilities[cap]?.reachableFrom?.forEach((n) => specific.add(n));
      capabilities[cap]?.viaDispatcherOnly?.forEach((n) => via.add(n));
    }
    codeChangeEntrypoints = [...specific].sort();
    codeChangeViaDispatcher = [...via].filter((n) => !specific.has(n)).sort();
  }

  return {
    size: bytes.length,
    imports,
    exports: exportNames,
    capabilities,
    codeChangeEntrypoints,
    codeChangeViaDispatcher,
    dispatchers: dispatchers.size,
    upgradeLikeNames: exportNames.filter((n) => UPGRADE_NAME.test(n)),
    reachability: { available: !reachabilityError, reason: reachabilityError, functions: nImp + funcTypes.length, indirectTargets: indirectTargets.size },
  };
}

/** Deterministic diff between two analyses: what the new code can do that the old could not. */
export interface ExportDiff {
  addedMethods: string[];
  removedMethods: string[];
  addedHostImports: string[];
  removedHostImports: string[];
  addedCapabilities: Capability[];
  removedCapabilities: Capability[];
  /** Capabilities present in both, but now reachable from more exported methods. */
  newlyReachable: { capability: Capability; methods: string[] }[];
}

export function exportDiff(before: WasmAnalysis, after: WasmAnalysis): ExportDiff {
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).sort();
  const capsBefore = Object.keys(before.capabilities) as Capability[];
  const capsAfter = Object.keys(after.capabilities) as Capability[];
  const newlyReachable: ExportDiff["newlyReachable"] = [];
  for (const cap of capsAfter) {
    const a = after.capabilities[cap]?.reachableFrom;
    const b = before.capabilities[cap]?.reachableFrom;
    if (a && b) {
      const added = minus(a, b);
      if (added.length) newlyReachable.push({ capability: cap, methods: added });
    }
  }
  return {
    addedMethods: minus(after.exports, before.exports),
    removedMethods: minus(before.exports, after.exports),
    addedHostImports: minus(after.imports, before.imports),
    removedHostImports: minus(before.imports, after.imports),
    addedCapabilities: minus(capsAfter, capsBefore) as Capability[],
    removedCapabilities: minus(capsBefore, capsAfter) as Capability[],
    newlyReachable,
  };
}
