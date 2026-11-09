// Wasm analysis on the repo's own contracts (contracts/out, built by contracts/test.sh).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyzeWasm, exportDiff, codeHash } from "../src/index.ts";

const OUT = path.join(import.meta.dirname, "../../../contracts/out");
const wasm = (n: string) => new Uint8Array(fs.readFileSync(path.join(OUT, n)));

describe("analyzeWasm", () => {
  it("demo-vault-v1: no code-change host functions → proof that methods cannot redeploy", () => {
    const a = analyzeWasm(wasm("demo_vault_v1.wasm"));
    expect(a.capabilities.deploy_contract).toBeUndefined();
    expect(a.capabilities.use_global_contract).toBeUndefined();
    expect(a.capabilities.add_full_access_key).toBeUndefined();
    expect(a.codeChangeEntrypoints).toEqual([]);
    expect(a.exports).toEqual(expect.arrayContaining(["deposit", "withdraw", "contract_source_metadata"]));
    expect(a.reachability.available).toBe(true);
  });
  it("registry: no code-change capability (immutable by design)", () => {
    const a = analyzeWasm(wasm("registry.wasm"));
    expect(Object.keys(a.capabilities).filter((c) => ["deploy_contract", "use_global_contract", "add_full_access_key"].includes(c))).toEqual([]);
  });
  it("rejects non-wasm input", () => {
    expect(() => analyzeWasm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });
});

describe("exportDiff", () => {
  it("v1 → v2 shows + sweep and nothing removed", () => {
    const d = exportDiff(analyzeWasm(wasm("demo_vault_v1.wasm")), analyzeWasm(wasm("demo_vault_v2.wasm")));
    expect(d.addedMethods).toEqual(["sweep"]);
    expect(d.removedMethods).toEqual([]);
  });
  it("identical code → empty diff", () => {
    const a = analyzeWasm(wasm("demo_vault_v1.wasm"));
    const d = exportDiff(a, a);
    expect(Object.values(d).every((v) => (v as unknown[]).length === 0)).toBe(true);
  });
});

describe("codeHash", () => {
  it("is base58(sha256(wasm)), 32 bytes", async () => {
    const h = await codeHash(wasm("demo_vault_v1.wasm"));
    expect(h).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });
});
