import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runConstantView, sourceMetadataFromWasm, WasmViewError } from "../src/wasmview.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const wasm = (f: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro", f)));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/repro/manifest.json"), "utf8"));

describe("sourceMetadataFromWasm", () => {
  it("reads NEP-330 metadata from bytes, with no chain involved", async () => {
    const m = await sourceMetadataFromWasm(wasm("demo_vault_v1.wasm"));
    expect(m?.link).toBe(`https://github.com/unajijacob6-create/keyhole/tree/${manifest.rev}`);
    expect(m?.build_info?.contract_path).toBe("contracts/demo-vault-v1");
    expect(m?.build_info?.build_environment).toBe(manifest.image);
    expect(m?.standards?.some((s) => s.standard === "nep330")).toBe(true);
  });
  it("returns null for a method that is not exported", async () => {
    expect(await runConstantView(wasm("demo_vault_v1.wasm"), "no_such_method")).toBeNull();
  });
  it("refuses methods that need chain state instead of answering", async () => {
    // get_total reads storage: the stub host traps rather than inventing an answer.
    await expect(runConstantView(wasm("demo_vault_v1.wasm"), "get_total")).rejects.toBeInstanceOf(WasmViewError);
  });
  it("returns null for bytes that are not a contract", async () => {
    expect(await sourceMetadataFromWasm(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });
});
