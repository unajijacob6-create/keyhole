import { describe, expect, it } from "vitest";
import { Guardian, shouldFire } from "../src/guardian.ts";
import type { Assessment } from "../src/assess.ts";
import type { RadarEvent } from "../src/radar.ts";
import { newAccountIds, printableStrings } from "../src/tee.ts";

const hatch = (o: Partial<any> = {}) => ({
  schema: "keyhole.hatch/1",
  id: "h1",
  network: "testnet",
  account: "alice.testnet",
  venue: "vault.testnet",
  method: "withdraw_all",
  args: {},
  deposit: "1",
  gas: "50000000000000",
  mode: "delegate",
  public_key: "ed25519:x",
  nonce: "2",
  max_block_height: "100",
  signed_delegate: "AA==",
  created_at: "2026-11-10T00:00:00.000Z",
  created_height: 1,
  trigger: "stop",
  ...o,
}) as any;

const assessment = (verdict: "OK" | "CAUTION" | "STOP", target = "vault.testnet"): Assessment => ({
  schema: "keyhole.assessment/1",
  target,
  dao: "dao.testnet",
  proposal: null,
  staged: null,
  live_hash: "L",
  pending_hash: "P",
  code_source: { kind: "store_blob", tx: "T", signer: "s", height: 1 },
  pending_size: 10,
  verified: { reproducible: false, sourcescan: false, registry_review: null },
  summary: ["new methods: sweep"],
  grade: { verdict, flags: [], reasons: [], diff: null, fire: verdict === "STOP", headline: verdict },
  review: null,
  at: "2026-11-10T00:00:00.000Z",
});

const proposalEv = (state: string, approve = 0, required = 2): RadarEvent => ({
  kind: "proposal",
  target: "vault.testnet",
  dao: "dao.testnet",
  first: true,
  proposal: { dao: "dao.testnet", id: 7, proposer: "a", description: "", kind: "UpgradeRemote", target: "vault.testnet", method: "upgrade", code_hash: "P", hash_from: "proposal", status: "InProgress", state: state as any, submitted_at_ms: 0, expires_at_ms: 1, votes: { approve, reject: 0, remove: 0 }, required },
});

describe("shouldFire", () => {
  it("fires a stop hatch only on STOP for its own venue, while it can still matter", () => {
    expect(shouldFire(hatch(), assessment("STOP"), proposalEv("pending"))).toBe(true);
    expect(shouldFire(hatch(), assessment("CAUTION"), proposalEv("pending"))).toBe(false);
    expect(shouldFire(hatch(), assessment("STOP", "other.testnet"), proposalEv("pending"))).toBe(false);
    expect(shouldFire(hatch(), assessment("STOP"), proposalEv("expired"))).toBe(false);
    expect(shouldFire(hatch(), assessment("STOP"), proposalEv("rejected"))).toBe(false);
    // Already executed: too late to beat the upgrade, maybe not too late to beat the drain.
    expect(shouldFire(hatch(), assessment("STOP"), proposalEv("executed"))).toBe(true);
    expect(shouldFire(hatch(), assessment("STOP"), { kind: "deployed", target: "vault.testnet", old_hash: "L", new_hash: "P" })).toBe(true);
  });
  it("manual never fires; any-upgrade fires on any pending change", () => {
    expect(shouldFire(hatch({ trigger: "manual" }), assessment("STOP"), proposalEv("pending"))).toBe(false);
    expect(shouldFire(hatch({ trigger: "any-upgrade" }), assessment("OK"), proposalEv("pending"))).toBe(true);
    expect(shouldFire(hatch({ trigger: "any-upgrade" }), assessment("OK"), proposalEv("expired"))).toBe(false);
  });
});

function guardianWith(events: RadarEvent[][], verdict: "OK" | "CAUTION" | "STOP", healthState = "ARMED", codeSource = true) {
  const fires: string[] = [];
  const forgotten: number[] = [];
  let calls = 0;
  const radar: any = {
    controllers: new Map(),
    watch: async () => ({}),
    tick: async () => events.shift() ?? [],
    forget: (_dao: string, id: number) => forgotten.push(id),
  };
  const g = new Guardian({
    rpc: {} as any,
    assess: {} as any,
    radar,
    hatches: () => [hatch()],
    driver: { health: async () => ({ state: healthState, reasons: healthState === "ARMED" ? [] : ["x"] }), fire: async (h) => (fires.push(h.id), { tx: "FIRE_TX", ok: true }) },
    assessor: async () => {
      calls++;
      const a = assessment(verdict);
      return codeSource ? a : { ...a, code_source: null };
    },
  });
  return { g, fires, forgotten, calls: () => calls };
}

describe("Guardian", () => {
  it("fires an ARMED hatch once on STOP and reports votes still needed", async () => {
    const { g, fires } = guardianWith([[proposalEv("pending", 0, 2)], [proposalEv("pending", 1, 2)]], "STOP");
    const [a1] = await g.tick();
    expect(a1.votes_to_execute).toBe(2);
    expect(a1.fired).toEqual([expect.objectContaining({ ok: true, tx: "FIRE_TX" })]);
    const [a2] = await g.tick();
    expect(a2.votes_to_execute).toBe(1);
    expect(a2.fired).toEqual([]); // already fired: never twice
    expect(fires).toEqual(["h1"]);
  });
  it("does not fire on CAUTION", async () => {
    const { g, fires } = guardianWith([[proposalEv("pending")]], "CAUTION");
    const [a] = await g.tick();
    expect(a.assessment?.grade.verdict).toBe("CAUTION");
    expect(fires).toEqual([]);
  });
  it("reports a hatch that is no longer ARMED instead of firing it", async () => {
    const { g, fires } = guardianWith([[proposalEv("pending")]], "STOP", "USED");
    const [a] = await g.tick();
    expect(fires).toEqual([]);
    expect(a.fired[0]).toMatchObject({ ok: false, tx: null });
    expect(a.fired[0].error).toMatch(/USED/);
  });
  it("re-grades a pending proposal whose bytes were not readable yet", async () => {
    const { g, forgotten, calls } = guardianWith([[proposalEv("pending")], [proposalEv("pending")]], "CAUTION", "ARMED", false);
    await g.tick();
    await g.tick();
    expect(forgotten).toEqual([7, 7]);
    expect(calls()).toBe(2); // not cached
  });
});

describe("string facts for the TEE prompt", () => {
  it("finds account ids new in the pending wasm", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const live = enc("\0\0withdraw_all\0deposit\0vault.testnet\0");
    const pending = enc("\0\0withdraw_all\0deposit\0vault.testnet\0sweep\0keyhole-attacker.testnet\0");
    expect(printableStrings(pending).has("keyhole-attacker.testnet")).toBe(true);
    expect(newAccountIds(live, pending)).toEqual(["keyhole-attacker.testnet"]);
  });
});
