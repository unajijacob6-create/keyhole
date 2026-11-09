"use strict";
// Tests for contracts/wasm-reach.cjs, the call-graph check test.sh runs on the guarded-vault wasm.
// Run: node --test contracts/wasm-reach.test.cjs (test.sh does). Each case hand-assembles a tiny
// wasm module, so the shapes that once made the check miss a path (a cycle evaluated in an unlucky
// order, a call_indirect through the table) are pinned down without a Rust build.
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("./wasm-reach.cjs");

const DEPLOY = "promise_batch_action_deploy_contract";

// --- A minimal wasm assembler (MVP encoding; enough for these cases). ---
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const vec = (items) => [...leb(items.length), ...items.flat()];
const str = (s) => vec([...Buffer.from(s)].map((b) => [b]));
const section = (id, body) => [id, ...leb(body.length), ...body];
const op = { call: (f) => [0x10, ...leb(f)], callIndirect: (t) => [0x11, ...leb(t), 0x00], drop: [0x1a], i32: (n) => [0x41, ...leb(n)], end: [0x0b] };

/**
 * types: [[params], [results]] with valtype bytes; imports: [{ name, type }] (module "env");
 * funcs: [{ type, body: [...instr bytes] }]; exports: { name: funcidx }; table: funcidx[] placed
 * at offset 0 by an active element segment; start: funcidx; extra: raw section bytes appended.
 */
function wasm({ types, imports = [], funcs, exports = {}, table = null, start = null, extra = [] }) {
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  out.push(...section(1, vec(types.map(([p, r]) => [0x60, ...vec(p.map((t) => [t])), ...vec(r.map((t) => [t]))]))));
  out.push(...section(2, vec(imports.map((i) => [...str("env"), ...str(i.name), 0x00, ...leb(i.type)]))));
  out.push(...section(3, vec(funcs.map((f) => leb(f.type)))));
  if (table) out.push(...section(4, vec([[0x70, 0x00, ...leb(table.length)]])));
  out.push(...section(7, vec(Object.entries(exports).map(([n, f]) => [...str(n), 0x00, ...leb(f)]))));
  if (start !== null) out.push(...section(8, leb(start)));
  if (table) out.push(...section(9, vec([[0x00, ...op.i32(0), ...op.end, ...vec(table.map((f) => leb(f)))]])));
  out.push(...section(10, vec(funcs.map((f) => { const body = [0x00, ...f.body, ...op.end]; return [...leb(body.length), ...body]; }))));
  out.push(...extra);
  return new Uint8Array(out);
}
const VOID = [[], []]; // () -> ()
const I32 = [[0x7f], []]; // (i32) -> ()

test("direct call chain reaches deploy", () => {
  // f0 = import deploy; f1 = upgrade -> f2 -> f0; f2 helper; f3 = view, calls nothing.
  const m = wasm({
    types: [VOID],
    imports: [{ name: DEPLOY, type: 0 }],
    funcs: [{ type: 0, body: op.call(2) }, { type: 0, body: op.call(0) }, { type: 0, body: [] }],
    exports: { upgrade: 1, view: 3 },
  });
  assert.deepEqual(analyze(m).exportsReaching(DEPLOY), ["upgrade"]);
});

test("a cycle evaluated first does not hide a later export's path (memoised-false bug)", () => {
  // f1 (A) calls f2 then deploy; f2 (B) calls f1. Export "first" = A, "second" = f3 -> B.
  // A depth-first walk from A visits B while A is on the stack, sees A as "in progress", and must
  // not record B as "cannot reach deploy": B reaches deploy through A, so "second" reaches it too.
  const m = wasm({
    types: [VOID],
    imports: [{ name: DEPLOY, type: 0 }],
    funcs: [
      { type: 0, body: [...op.call(2), ...op.call(0)] }, // f1 = A
      { type: 0, body: op.call(1) }, // f2 = B
      { type: 0, body: op.call(2) }, // f3 -> B
    ],
    exports: { first: 1, second: 3 },
  });
  assert.deepEqual(analyze(m).exportsReaching(DEPLOY), ["first", "second"]);
});

test("call_indirect through the table counts as a path to every table entry of that type", () => {
  // f1 calls deploy and sits in the table; f2 does call_indirect of f1's type; f3 does
  // call_indirect of a different type, which can never land on f1 (the runtime traps on mismatch).
  const m = wasm({
    types: [VOID, I32],
    imports: [{ name: DEPLOY, type: 0 }],
    funcs: [
      { type: 0, body: op.call(0) }, // f1, in table
      { type: 0, body: [...op.i32(0), ...op.callIndirect(0)] }, // f2: dispatch () -> ()
      { type: 0, body: [...op.i32(7), ...op.i32(0), ...op.callIndirect(1)] }, // f3: dispatch (i32) -> ()
    ],
    exports: { dispatch: 2, other: 3 },
    table: [1],
  });
  assert.deepEqual(analyze(m).exportsReaching(DEPLOY), ["dispatch"]);
});

test("a start function that reaches deploy is reported (it runs on every call)", () => {
  const m = wasm({
    types: [VOID],
    imports: [{ name: DEPLOY, type: 0 }],
    funcs: [{ type: 0, body: op.call(0) }, { type: 0, body: [] }],
    exports: { view: 2 },
    start: 1,
  });
  assert.deepEqual(analyze(m).exportsReaching(DEPLOY), ["(start)"]);
});

test("an import that is never called is reached by nothing", () => {
  const m = wasm({ types: [VOID], imports: [{ name: DEPLOY, type: 0 }], funcs: [{ type: 0, body: [] }], exports: { view: 1 } });
  assert.deepEqual(analyze(m).exportsReaching(DEPLOY), []);
  assert.deepEqual(analyze(m).exportsReaching("not_imported"), []);
});

test("fails closed on an opcode it does not know", () => {
  // 0xfd is the SIMD prefix, which the decoder does not handle: it must throw, not guess.
  const m = wasm({ types: [VOID], funcs: [{ type: 0, body: [0xfd, 0x0c] }], exports: { f: 0 } });
  assert.throws(() => analyze(m), /unknown opcode/);
});

test("fails closed on a truncated module", () => {
  const m = wasm({ types: [VOID], imports: [{ name: DEPLOY, type: 0 }], funcs: [{ type: 0, body: op.call(0) }], exports: { f: 1 } });
  assert.throws(() => analyze(m.slice(0, m.length - 3)));
});
