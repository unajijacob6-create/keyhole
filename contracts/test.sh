#!/usr/bin/env bash
# Build the three Keyhole contracts, check their wasm, and run unit + sandbox tests.
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
build registry keyhole_registry registry
build demo-vault-v1 demo_vault_v1 demo_vault_v1
build demo-vault-v2 demo_vault_v2 demo_vault_v2

# 2. Inspect exports and imports. Every contract must export NEP-330 `contract_source_metadata`,
#    and none may import a host function that deploys or switches code.
node - out/registry.wasm out/demo_vault_v1.wasm out/demo_vault_v2.wasm <<'EOF'
const fs = require("fs");
let failed = false;
for (const file of process.argv.slice(2)) {
  const bytes = fs.readFileSync(file);
  const mod = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(mod).filter((e) => e.kind === "function").map((e) => e.name);
  const imports = WebAssembly.Module.imports(mod).map((i) => i.name);
  const codeChanging = imports.filter((n) => /deploy|use_global_contract/.test(n));
  console.log(`${file} (${bytes.length} bytes)\n  exports: ${exports.join(" ")}`);
  if (!exports.includes("contract_source_metadata")) { console.error("  FAIL: no contract_source_metadata export"); failed = true; }
  if (codeChanging.length) { console.error(`  FAIL: code-changing imports: ${codeChanging.join(" ")}`); failed = true; }
}
process.exit(failed ? 1 : 0);
EOF

# 3. Unit tests.
cargo test --locked --workspace --lib

# 4. Sandbox tests. The sandbox node wants 65535 open files; on capped containers preload the
#    shim that clamps that one request (see sandbox-rlimit-shim.c).
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt 65535 ]; then
  mkdir -p target
  [ -f target/librlimit_shim.so ] || cc -shared -fPIC -O2 -o target/librlimit_shim.so sandbox-rlimit-shim.c -ldl
  export LD_PRELOAD="$DIR/target/librlimit_shim.so"
fi
cargo test --locked --workspace --test '*' -- --test-threads=2 --nocapture "$@"
echo "contracts: all checks passed"
