#!/usr/bin/env bash
# Build the Keyhole contracts, check their wasm, and run unit + sandbox tests.
# Usage: bash contracts/test.sh [extra args for the sandbox test binaries]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

command -v cargo-near >/dev/null || { echo "cargo-near is required: https://github.com/near/cargo-near" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required to inspect the wasm" >&2; exit 1; }

# 1. Build with cargo-near (runs wasm-opt, embeds the ABI and NEP-330 metadata).
mkdir -p out
build() { # crate dir, cargo-near output name, out name
  cargo near build non-reproducible-wasm --locked --manifest-path "$1/Cargo.toml"
  install -m 644 "target/near/$2/$2.wasm" "out/$3.wasm"
}
buildf() { # out name, feature (guarded-vault only; honest when empty)
  local feat_args=(--no-default-features)
  [ -n "$2" ] && feat_args+=(--features "$2")
  cargo near build non-reproducible-wasm --locked --manifest-path guarded-vault/Cargo.toml "${feat_args[@]}"
  install -m 644 "target/near/guarded_vault/guarded_vault.wasm" "out/$1.wasm"
}
build registry keyhole_registry registry
build demo-vault-v1 demo_vault_v1 demo_vault_v1
build demo-vault-v2 demo_vault_v2 demo_vault_v2
# The guarded vault: honest default plus the five seeded variants, each a separate wasm.
buildf guarded_vault ""
buildf guarded_vault_benign_v2 "benign-v2"
buildf guarded_vault_evil_sweep "evil-sweep"
buildf guarded_vault_evil_addkey "evil-addkey"
buildf guarded_vault_evil_owner "evil-owner"
buildf guarded_vault_evil_fee "evil-fee"

# 2. Inspect exports and imports. Every contract must export NEP-330 `contract_source_metadata`.
#    - registry / demo vaults: must NOT import any host function that deploys or switches code.
#    - guarded_vault*: deploy IS imported (its `upgrade` deploys), so instead of the import ban we
#      require the `upgrade` export and assert, by call-graph reachability, that `upgrade` is the
#      ONLY export that can reach the deploy host call. The analyzer decodes the code section and
#      fails closed on any opcode it does not understand, so it cannot silently miss a path.
node - out/registry.wasm out/demo_vault_v1.wasm out/demo_vault_v2.wasm \
       out/guarded_vault.wasm out/guarded_vault_benign_v2.wasm out/guarded_vault_evil_sweep.wasm \
       out/guarded_vault_evil_addkey.wasm out/guarded_vault_evil_owner.wasm out/guarded_vault_evil_fee.wasm <<'EOF'
"use strict";
// Reachability analyzer: which exported functions can reach a given imported host function.
// Decodes the WASM code section well enough to collect `call` edges; fails closed on any opcode
// it does not understand, so it can never silently miss a path to the deploy import.
const fs = require("fs");

function analyze(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  function leb() { // unsigned LEB128
    let r = 0n, s = 0n, b;
    do { b = bytes[p++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
    return Number(r);
  }
  function sleb() { // signed LEB128
    let r = 0n, s = 0n, b;
    do { b = bytes[p++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
    if (s < 64n && (b & 0x40)) r |= -(1n << s);
    return r;
  }
  function name() { const n = leb(); const s = Buffer.from(bytes.slice(p, p + n)).toString("utf8"); p += n; return s; }

  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not wasm");
  p = 8;

  let importedFuncCount = 0;
  const importFuncNames = []; // per imported function, its name
  const exports = {};         // name -> funcidx
  let codeSection = null;     // {start, end}

  while (p < bytes.length) {
    const id = u8();
    const size = leb();
    const end = p + size;
    if (id === 2) { // import
      const count = leb();
      for (let i = 0; i < count; i++) {
        name(); // module
        const nm = name(); // field
        const kind = u8();
        if (kind === 0x00) { leb(); importFuncNames.push(nm); importedFuncCount++; } // func: typeidx
        else if (kind === 0x01) { u8(); const f = u8(); if (f) leb(); leb(); } // table: reftype, limits
        else if (kind === 0x02) { const f = u8(); leb(); if (f) leb(); } // mem: limits
        else if (kind === 0x03) { u8(); u8(); } // global: valtype, mut
        else throw new Error("bad import kind " + kind);
      }
    } else if (id === 7) { // export
      const count = leb();
      for (let i = 0; i < count; i++) {
        const nm = name();
        const kind = u8();
        const idx = leb();
        if (kind === 0x00) exports[nm] = idx;
      }
    } else if (id === 10) { // code
      codeSection = { start: p, end };
    }
    p = end;
  }

  // Parse the code section: for each defined function collect the set of called function indices.
  const edges = []; // defined-function i -> array of callee funcidx
  if (!codeSection) throw new Error("no code section");
  p = codeSection.start;
  const bodyCount = leb();
  for (let i = 0; i < bodyCount; i++) {
    const bodySize = leb();
    const bodyEnd = p + bodySize;
    const localDecls = leb();
    for (let l = 0; l < localDecls; l++) { leb(); u8(); } // count, valtype
    const calls = [];
    decodeExpr(bodyEnd, calls);
    edges.push(calls);
    p = bodyEnd;
  }

  function decodeExpr(stop, calls) {
    while (p < stop) {
      const op = u8();
      switch (op) {
        case 0x00: case 0x01: break; // unreachable, nop
        case 0x02: case 0x03: case 0x04: sleb(); break; // block/loop/if blocktype
        case 0x05: break; // else
        case 0x0b: break; // end
        case 0x0c: case 0x0d: leb(); break; // br, br_if
        case 0x0e: { const n = leb(); for (let k = 0; k < n; k++) leb(); leb(); break; } // br_table
        case 0x0f: break; // return
        case 0x10: calls.push(leb()); break; // call
        case 0x11: leb(); leb(); break; // call_indirect: typeidx, tableidx
        case 0x1a: case 0x1b: break; // drop, select
        case 0x1c: { const n = leb(); for (let k = 0; k < n; k++) u8(); break; } // select t*
        case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: leb(); break; // local/global get/set/tee
        case 0x25: case 0x26: leb(); break; // table.get/set
        case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d: case 0x2e: case 0x2f:
        case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37:
        case 0x38: case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e:
          leb(); leb(); break; // memory load/store memarg (align, offset)
        case 0x3f: case 0x40: u8(); break; // memory.size / memory.grow
        case 0x41: sleb(); break; // i32.const
        case 0x42: sleb(); break; // i64.const
        case 0x43: p += 4; break; // f32.const
        case 0x44: p += 8; break; // f64.const
        case 0xd0: u8(); break; // ref.null t
        case 0xd1: break;       // ref.is_null
        case 0xd2: leb(); break; // ref.func x
        case 0xfc: { // bulk memory + saturating truncation
          const sub = leb();
          if (sub <= 7) break; // i32/i64 trunc_sat_f32/64_s/u
          switch (sub) {
            case 8: leb(); u8(); break;      // memory.init dataidx, 0x00
            case 9: leb(); break;            // data.drop
            case 10: u8(); u8(); break;      // memory.copy 0x00 0x00
            case 11: u8(); break;            // memory.fill 0x00
            case 12: leb(); leb(); break;    // table.init
            case 13: leb(); break;           // elem.drop
            case 14: leb(); leb(); break;    // table.copy
            case 15: leb(); break;           // table.grow
            case 16: leb(); break;           // table.size
            case 17: leb(); break;           // table.fill
            default: throw new Error("unknown 0xFC subop " + sub);
          }
          break;
        }
        default:
          // 0x45..0xC4 comparison/arithmetic, 0xC0..0xC5 sign-extension: no immediates.
          if ((op >= 0x45 && op <= 0xc4) || (op >= 0xc0 && op <= 0xc5)) break;
          throw new Error("unknown opcode 0x" + op.toString(16) + " at offset " + (p - 1));
      }
    }
  }

  // funcidx < importedFuncCount is an import (a leaf); funcidx >= importedFuncCount is a defined
  // function, whose callees are edges[funcidx - importedFuncCount].
  const memo = new Map();
  function reaches(funcidx, targetImport, stack) {
    if (funcidx === targetImport) return true;
    if (funcidx < importedFuncCount) return false;
    const key = funcidx + ":" + targetImport;
    if (memo.has(key)) return memo.get(key);
    if (stack.has(funcidx)) return false; // recursion guard
    stack.add(funcidx);
    let r = false;
    for (const callee of edges[funcidx - importedFuncCount]) {
      if (reaches(callee, targetImport, stack)) { r = true; break; }
    }
    stack.delete(funcidx);
    memo.set(key, r);
    return r;
  }

  return {
    importFuncNames, exports,
    exportsReaching(importName) {
      const imp = importFuncNames.indexOf(importName);
      if (imp < 0) return [];
      memo.clear();
      return Object.keys(exports).filter((nm) => reaches(exports[nm], imp, new Set())).sort();
    },
  };
}

const DEPLOY = "promise_batch_action_deploy_contract";
let failed = false;
for (const file of process.argv.slice(2)) {
  const bytes = fs.readFileSync(file);
  const a = analyze(bytes);
  const funcExports = Object.keys(a.exports).sort();
  const guarded = /(^|\/)guarded_vault[^/]*\.wasm$/.test(file);
  console.log(`${file} (${bytes.length} bytes)\n  exports: ${funcExports.join(" ")}`);
  if (a.exports.contract_source_metadata === undefined) { console.error("  FAIL: no contract_source_metadata export"); failed = true; }
  if (guarded) {
    if (a.exports.upgrade === undefined) { console.error("  FAIL: guarded_vault must export upgrade"); failed = true; }
    if (!a.importFuncNames.includes(DEPLOY)) { console.error("  FAIL: guarded_vault must import " + DEPLOY + " (upgrade deploys)"); failed = true; }
    const reaching = a.exportsReaching(DEPLOY);
    console.log("  exports reaching deploy: " + (reaching.join(" ") || "(none)"));
    if (reaching.join(",") !== "upgrade") { console.error("  FAIL: only 'upgrade' may reach deploy, got: " + (reaching.join(" ") || "(none)")); failed = true; }
  } else {
    const codeChanging = a.importFuncNames.filter((n) => /deploy|use_global_contract/.test(n));
    if (codeChanging.length) { console.error("  FAIL: code-changing imports: " + codeChanging.join(" ")); failed = true; }
  }
}
process.exit(failed ? 1 : 0);
EOF

# 3. Unit tests. The workspace lib pass covers each crate's default build; the loop then runs the
#    guarded-vault variant unit tests (each is a separate --features build).
cargo test --locked --workspace --lib
for f in benign-v2 evil-sweep evil-addkey evil-owner evil-fee; do
  echo "== guarded-vault unit tests: $f =="
  cargo test --locked -p guarded-vault --lib --no-default-features --features "$f"
done

# 4. Sandbox tests. The sandbox node wants 65535 open files; on capped containers preload the
#    shim that clamps that one request (see sandbox-rlimit-shim.c).
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt 65535 ]; then
  mkdir -p target
  [ -f target/librlimit_shim.so ] || cc -shared -fPIC -O2 -o target/librlimit_shim.so sandbox-rlimit-shim.c -ldl
  export LD_PRELOAD="$DIR/target/librlimit_shim.so"
fi
cargo test --locked --workspace --test '*' -- --test-threads=2 --nocapture "$@"
echo "contracts: all checks passed"
