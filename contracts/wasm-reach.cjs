"use strict";
// Call-graph reachability for NEAR contract wasm: which exported functions can reach a given
// imported host function. contracts/test.sh uses it to prove that, in every guarded-vault build,
// `upgrade` is the only export that can reach a code-changing host call.
//
// Plain node (no npm dependencies), because the contracts CI job runs without `npm ci`.
// packages/core/src/wasm.ts has the fuller analyzer the app uses; this one only has to answer one
// question soundly, so it over-approximates wherever the code could go somewhere it cannot see:
//   - `call_indirect` may land on any function placed in a table (element segments) or taken with
//     `ref.func`, whose signature matches the call's type;
//   - a `start` function runs on every instantiation, so it is reported as the pseudo-export
//     "(start)";
//   - any opcode or section encoding it does not understand throws, so it fails closed.
// Reachability is the backward closure from the target import over the call graph, so cycles and
// evaluation order cannot hide a path (an earlier memoised depth-first walk could).
//
// Usage: const { analyze } = require("./wasm-reach.cjs"); analyze(bytes).exportsReaching(name)

function analyze(bytes) {
  let p = 0;
  const need = (n) => { if (p + n > bytes.length) throw new Error("truncated wasm at offset " + p); };
  const u8 = () => { need(1); return bytes[p++]; };
  function leb() { // unsigned LEB128 (u32)
    let r = 0n, s = 0n, b;
    do { b = u8(); r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
    return Number(r);
  }
  function sleb() { // signed LEB128 (value unused; only skipped)
    let b;
    do { b = u8(); } while (b & 0x80);
  }
  function name() { const n = leb(); need(n); const s = Buffer.from(bytes.slice(p, p + n)).toString("utf8"); p += n; return s; }
  function valtype() {
    const t = u8();
    // i32 i64 f32 f64 v128 funcref externref. Anything else (GC / typed refs) is outside what NEAR
    // accepts today; refuse rather than misparse.
    if (![0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(t)) throw new Error("unknown valtype 0x" + t.toString(16));
    return t;
  }
  function limits() { const f = u8(); leb(); if (f & 1) leb(); }

  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not wasm");
  p = 8;

  const types = [];          // typeidx -> canonical signature string
  const funcType = [];       // funcidx -> typeidx (imports first, then defined functions)
  const importFuncNames = []; // imported funcidx -> host function name
  const exports = {};        // export name -> funcidx (function exports only)
  const indirectTargets = new Set(); // funcidx placed in a table or taken by ref.func
  let startFunc = null;
  let codeSection = null;

  // A constant expression (offsets, global inits, element items): collect `ref.func` targets.
  function constExpr() {
    for (;;) {
      const op = u8();
      if (op === 0x0b) return;
      if (op === 0x41 || op === 0x42) sleb();
      else if (op === 0x43) { need(4); p += 4; }
      else if (op === 0x44) { need(8); p += 8; }
      else if (op === 0x23) leb(); // global.get
      else if (op === 0xd0) u8(); // ref.null t
      else if (op === 0xd2) indirectTargets.add(leb()); // ref.func
      else throw new Error("unknown const-expr opcode 0x" + op.toString(16));
    }
  }

  while (p < bytes.length) {
    const id = u8();
    const size = leb();
    const end = p + size;
    need(size);
    if (id === 1) { // type
      const count = leb();
      for (let i = 0; i < count; i++) {
        const form = u8();
        if (form !== 0x60) throw new Error("unknown type form 0x" + form.toString(16));
        const params = []; for (let n = leb(); n > 0; n--) params.push(valtype());
        const results = []; for (let n = leb(); n > 0; n--) results.push(valtype());
        types.push(params.join(",") + "->" + results.join(","));
      }
    } else if (id === 2) { // import
      const count = leb();
      for (let i = 0; i < count; i++) {
        name(); // module
        const nm = name(); // field
        const kind = u8();
        if (kind === 0x00) { funcType.push(leb()); importFuncNames.push(nm); }
        else if (kind === 0x01) { valtype(); limits(); }
        else if (kind === 0x02) limits();
        else if (kind === 0x03) { valtype(); u8(); }
        else throw new Error("unknown import kind " + kind);
      }
    } else if (id === 3) { // function: typeidx of each defined function
      for (let n = leb(); n > 0; n--) funcType.push(leb());
    } else if (id === 6) { // global: init expressions may hold ref.func
      for (let n = leb(); n > 0; n--) { valtype(); u8(); constExpr(); }
    } else if (id === 7) { // export
      for (let n = leb(); n > 0; n--) {
        const nm = name();
        const kind = u8();
        const idx = leb();
        if (kind === 0x00) exports[nm] = idx;
      }
    } else if (id === 8) { // start
      startFunc = leb();
    } else if (id === 9) { // element segments: every listed function is an indirect-call target
      for (let n = leb(); n > 0; n--) {
        const flags = leb();
        if (flags > 7) throw new Error("unknown element segment flags " + flags);
        if ((flags & 3) === 2) leb(); // explicit table index
        if (!(flags & 1)) constExpr(); // active: offset expression
        const exprs = (flags & 4) !== 0;
        if (flags & 3) { if (exprs) valtype(); else if (u8() !== 0x00) throw new Error("unknown elemkind"); }
        for (let k = leb(); k > 0; k--) { if (exprs) constExpr(); else indirectTargets.add(leb()); }
      }
    } else if (id === 10) { // code
      codeSection = { start: p, end };
    }
    p = end;
  }

  const nImports = importFuncNames.length;
  const callees = []; // funcidx -> Set of funcidx it may call
  for (let f = 0; f < funcType.length; f++) callees.push(new Set());
  const indirectCalls = []; // [caller funcidx, typeidx]
  if (codeSection) {
    p = codeSection.start;
    const bodies = leb();
    if (bodies !== funcType.length - nImports) throw new Error("code/function section mismatch");
    for (let i = 0; i < bodies; i++) {
      const bodySize = leb();
      const bodyEnd = p + bodySize;
      need(bodySize);
      for (let n = leb(); n > 0; n--) { leb(); valtype(); } // local declarations
      decodeExpr(bodyEnd, nImports + i);
      if (p !== bodyEnd) throw new Error("function body overran at offset " + p);
    }
  }

  function decodeExpr(stop, self) {
    const calls = callees[self];
    while (p < stop) {
      const op = u8();
      switch (op) {
        case 0x00: case 0x01: break; // unreachable, nop
        case 0x02: case 0x03: case 0x04: sleb(); break; // block/loop/if blocktype (s33)
        case 0x05: case 0x0b: case 0x0f: break; // else, end, return
        case 0x0c: case 0x0d: leb(); break; // br, br_if
        case 0x0e: { for (let n = leb(); n > 0; n--) leb(); leb(); break; } // br_table
        case 0x10: calls.add(leb()); break; // call
        case 0x11: indirectCalls.push([self, leb()]); leb(); break; // call_indirect typeidx tableidx
        case 0x1a: case 0x1b: break; // drop, select
        case 0x1c: { for (let n = leb(); n > 0; n--) valtype(); break; } // select t*
        case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: leb(); break; // local/global get/set/tee
        case 0x25: case 0x26: leb(); break; // table.get/set
        case 0x3f: case 0x40: u8(); break; // memory.size / memory.grow
        case 0x41: case 0x42: sleb(); break; // i32.const / i64.const
        case 0x43: need(4); p += 4; break; // f32.const
        case 0x44: need(8); p += 8; break; // f64.const
        case 0xd0: u8(); break; // ref.null t
        case 0xd1: break; // ref.is_null
        case 0xd2: indirectTargets.add(leb()); break; // ref.func: the function escapes into a value
        case 0xfc: { // bulk memory, table ops, saturating truncation
          const sub = leb();
          if (sub <= 7) break; // trunc_sat
          if (sub === 8) { leb(); u8(); } // memory.init
          else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) leb(); // data.drop elem.drop table.grow/size/fill
          else if (sub === 10) { u8(); u8(); } // memory.copy
          else if (sub === 11) u8(); // memory.fill
          else if (sub === 12 || sub === 14) { leb(); leb(); } // table.init / table.copy
          else throw new Error("unknown opcode 0xfc " + sub);
          break;
        }
        default:
          if (op >= 0x28 && op <= 0x3e) { leb(); leb(); break; } // loads/stores: memarg align, offset
          if (op >= 0x45 && op <= 0xc4) break; // numeric, comparison, conversion, sign-extension
          // Includes return_call (0x12/0x13), exceptions, SIMD (0xfd), threads (0xfe): refuse.
          throw new Error("unknown opcode 0x" + op.toString(16) + " at offset " + (p - 1));
      }
    }
  }

  // call_indirect of type t may land on any indirect target whose signature equals t's.
  for (const [caller, t] of indirectCalls) {
    for (const target of indirectTargets) {
      if (types[funcType[target]] === types[t]) callees[caller].add(target);
    }
  }
  const callers = callees.map(() => []);
  callees.forEach((set, f) => set.forEach((c) => { if (c < callers.length) callers[c].push(f); }));

  /** Every function from which `target` (a funcidx) is reachable, the target included. */
  function reachersOf(target) {
    const seen = new Set([target]);
    const queue = [target];
    while (queue.length) for (const c of callers[queue.pop()]) if (!seen.has(c)) { seen.add(c); queue.push(c); }
    return seen;
  }

  return {
    importFuncNames,
    exports,
    exportsReaching(importName) {
      const imp = importFuncNames.indexOf(importName);
      if (imp < 0) return [];
      const r = reachersOf(imp);
      const out = Object.keys(exports).filter((nm) => r.has(exports[nm]));
      if (startFunc !== null && r.has(startFunc)) out.push("(start)");
      return out.sort();
    },
  };
}

module.exports = { analyze };

// CLI: node wasm-reach.cjs <file.wasm>... prints, per file, which exports reach each code-changing
// import (deploy / global-contract host calls).
if (require.main === module) {
  const fs = require("fs");
  for (const file of process.argv.slice(2)) {
    const a = analyze(fs.readFileSync(file));
    console.log(file);
    for (const imp of a.importFuncNames.filter((n) => /deploy|use_global_contract/.test(n))) {
      console.log("  " + imp + ": " + (a.exportsReaching(imp).join(" ") || "(none)"));
    }
  }
}
