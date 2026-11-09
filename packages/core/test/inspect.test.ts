// Full inspect() against recorded mainnet RPC answers (npm run fixtures:record). Offline.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { inspect, fixtureTransport, Rpc } from "../src/index.ts";

const DIR = path.join(import.meta.dirname, "fixtures");
const load = (f: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))).toString("utf8"));

async function run(file: string) {
  const fx = load(file);
  const transport = fixtureTransport(fx.fixtures);
  const r = await inspect(fx.account, { transport, history: fx.history, registry: { rpc: new Rpc({ network: "testnet", transport, retries: 0 }) }, checkRepo: false, sourceRoles: false, nowMs: fx.nowMs });
  return { fx, r };
}

describe("inspect() on recorded mainnet data", () => {
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".json.gz"))) {
    it(`${file}: grade matches the recorded expectation`, async () => {
      const { fx, r } = await run(file);
      expect({ class: r.grade.class, verdict: r.grade.verdict, flags: r.grade.flags }).toEqual(fx.expected);
      if (r.code) expect(r.code.hashMatchesBytes).toBe(true);
      for (const reason of r.grade.reasons) expect(reason.text.length).toBeGreaterThan(10);
    });
  }

  it("usdt.tether-token.near: upgrade gated by a 2-of-3 multisig; only `upgrade` reaches deploy specifically", async () => {
    const { r } = await run("usdt.tether-token.near.json.gz");
    expect(r.grade.class).toBe("GOVERNED");
    expect(r.owners[0].account).toBe("tether.multisafe.near");
    expect(r.owners[0].actor?.multisig).toEqual({ required: 2, members: 3 });
    expect(r.wasm?.codeChangeEntrypoints).toEqual(["upgrade"]);
    expect(["found", "unchanged-since"]).toContain(r.lastChange?.status);
  });

  it("native USDC: one full-access key on the contract account → CUSTODIAL", async () => {
    const { r } = await run("17208628f84f5d6a.json.gz");
    expect(r.keys.fullAccess.length).toBe(1);
    expect(r.paths[0].via).toBe("full-access-key");
    expect(r.grade.class).toBe("CUSTODIAL");
  });

  it("wrap.near: deploy host function linked, no method found → UNRESOLVED, never IMMUTABLE", async () => {
    const { r } = await run("wrap.near.json.gz");
    expect(r.wasm?.capabilities.deploy_contract).toBeTruthy();
    expect(r.grade.class).toBe("UNRESOLVED");
  });

  it("stader NearX: the Everyone role does not make the DAO single-key", async () => {
    const { r } = await run("v2-nearx.stader-labs.near.json.gz");
    expect(r.grade.class).toBe("GOVERNED");
  });

  it("token.sweat: governed by a DAO and SourceScan-verified → OK", async () => {
    const { r } = await run("token.sweat.json.gz");
    expect(r.grade.verdict).toBe("OK");
    expect(r.sourcescan?.status).toBe("verified");
    expect(r.nep330?.hasBuildInfo).toBe(true);
  });
});
