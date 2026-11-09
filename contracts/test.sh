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
#      require the `upgrade` export and assert, by call-graph reachability (wasm-reach.cjs), that
#      `upgrade` is the ONLY export that can reach any code-changing host call. The analyzer
#      over-approximates indirect calls (any table entry of a matching type), reports a start
#      function, and fails closed on any opcode it does not understand. Its own tests run first.
node --test wasm-reach.test.cjs
node - out/registry.wasm out/demo_vault_v1.wasm out/demo_vault_v2.wasm \
       out/guarded_vault.wasm out/guarded_vault_benign_v2.wasm out/guarded_vault_evil_sweep.wasm \
       out/guarded_vault_evil_addkey.wasm out/guarded_vault_evil_owner.wasm out/guarded_vault_evil_fee.wasm <<'EOF'
"use strict";
const fs = require("fs");
const { analyze } = require("./wasm-reach.cjs");
const DEPLOY = "promise_batch_action_deploy_contract";
const CODE_CHANGING = /deploy|use_global_contract/;
let failed = false;
for (const file of process.argv.slice(2)) {
  const bytes = fs.readFileSync(file);
  const a = analyze(bytes);
  const funcExports = Object.keys(a.exports).sort();
  const guarded = /(^|\/)guarded_vault[^/]*\.wasm$/.test(file);
  const codeChanging = a.importFuncNames.filter((n) => CODE_CHANGING.test(n));
  console.log(`${file} (${bytes.length} bytes)\n  exports: ${funcExports.join(" ")}`);
  if (a.exports.contract_source_metadata === undefined) { console.error("  FAIL: no contract_source_metadata export"); failed = true; }
  if (guarded) {
    if (a.exports.upgrade === undefined) { console.error("  FAIL: guarded_vault must export upgrade"); failed = true; }
    if (!codeChanging.includes(DEPLOY)) { console.error("  FAIL: guarded_vault must import " + DEPLOY + " (upgrade deploys)"); failed = true; }
    // Every code-changing import (deploy, and the global-contract deploy/use calls if one ever
    // appears), not just the expected one: only `upgrade` may reach deploy, and nothing may reach
    // the others.
    for (const imp of codeChanging) {
      const reaching = a.exportsReaching(imp);
      console.log(`  exports reaching ${imp}: ` + (reaching.join(" ") || "(none)"));
      const allowed = imp === DEPLOY ? "upgrade" : "";
      if (reaching.join(",") !== allowed) { console.error(`  FAIL: ${imp}: only ${allowed ? "'upgrade'" : "nothing"} may reach it, got: ` + (reaching.join(" ") || "(none)")); failed = true; }
    }
  } else if (codeChanging.length) {
    console.error("  FAIL: code-changing imports: " + codeChanging.join(" ")); failed = true;
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
