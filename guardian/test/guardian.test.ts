import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { codeHash } from "../../packages/core/src/index.ts";
import { prepareDelegateHatch, type Hatch } from "../../packages/hatch/src/index.ts";
import { fireRefusal, Guardian, shouldFire, type HatchDriver } from "../src/guardian.ts";
import { assessPending, type Assessment } from "../src/assess.ts";
import { Radar, type RadarEvent } from "../src/radar.ts";
import { newAccountIds, printableStrings } from "../src/tee.ts";
import { Chain, emptyTxApi, NOW, policy, upgradeRemote, V1, V2 } from "./chain.ts";

const KEY = KeyPair.fromRandom("ed25519");
/** A real signed delegate hatch (offline): verifyHatch passes, so the guardian may relay it. */
const signedHatch = (o: { venue?: string; deposit?: string; trigger?: Hatch["trigger"] } = {}) =>
  prepareDelegateHatch({
    network: "testnet",
    account: "alice.testnet",
    venue: o.venue ?? "vault.testnet",
    method: "withdraw_all",
    args: {},
    deposit: o.deposit ?? "1",
    gas: "50000000000000",
    keyPair: KEY,
    keyNonce: 1n,
    headHeight: 1000,
    ttlBlocks: 100_000,
    trigger: o.trigger ?? "stop",
    now: new Date(NOW),
  });
const HATCH = await signedHatch();

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
  replaced: null,
  verified: { reproducible: false, sourcescan: false, registry_review: null },
  summary: ["new methods: sweep"],
  grade: { verdict, flags: [], reasons: [], diff: null, fire: verdict === "STOP", headline: verdict },
  review: null,
  at: "2026-11-10T00:00:00.000Z",
});

const proposalEv = (state: string, approve = 0, required = 2, o: { id?: number; expires?: number; prev?: string } = {}): RadarEvent => ({
  kind: "proposal",
  target: "vault.testnet",
  dao: "dao.testnet",
  first: true,
  prev_live: o.prev ? { hash: o.prev, height: 900 } : null,
  proposal: { dao: "dao.testnet", id: o.id ?? 7, proposer: "a", description: "", kind: "UpgradeRemote", target: "vault.testnet", method: "upgrade", via: null, registers_release: false, code_hash: "P", hash_from: "proposal", status: state === "failed" ? "Failed" : "InProgress", state: state as any, submitted_at_ms: NOW - 1000, expires_at_ms: o.expires ?? 1, votes: { approve, reject: 0, remove: 0 }, required },
});

describe("shouldFire", () => {
  it("fires a stop hatch only on STOP for its own venue, while it can still matter", () => {
    const h = HATCH;
    expect(shouldFire(h, assessment("STOP"), proposalEv("pending"), NOW)).toBe(true);
    expect(shouldFire(h, assessment("CAUTION"), proposalEv("pending"), NOW)).toBe(false);
    expect(shouldFire(h, assessment("STOP", "other.testnet"), proposalEv("pending"), NOW)).toBe(false);
    expect(shouldFire(h, assessment("STOP"), proposalEv("expired"), NOW)).toBe(false);
    expect(shouldFire(h, assessment("STOP"), proposalEv("rejected"), NOW)).toBe(false);
    // Already executed: too late to beat the upgrade, maybe not too late to beat the drain.
    expect(shouldFire(h, assessment("STOP"), proposalEv("executed"), NOW)).toBe(true);
    expect(shouldFire(h, assessment("STOP"), { kind: "deployed", target: "vault.testnet", old_hash: "L", new_hash: "P", old_height: 1 }, NOW)).toBe(true);
  });
  it("manual never fires; any-upgrade fires on any pending change", () => {
    expect(shouldFire({ ...HATCH, trigger: "manual" }, assessment("STOP"), proposalEv("pending"), NOW)).toBe(false);
    expect(shouldFire({ ...HATCH, trigger: "any-upgrade" }, assessment("OK"), proposalEv("pending"), NOW)).toBe(true);
    expect(shouldFire({ ...HATCH, trigger: "any-upgrade" }, assessment("OK"), proposalEv("expired"), NOW)).toBe(false);
  });
  it("a Failed proposal inside its period can still execute (sputnikdao2 v3 Finalize): it matters (#6)", () => {
    expect(shouldFire(HATCH, assessment("STOP"), proposalEv("failed", 2, 2, { expires: NOW + 86400_000 }), NOW)).toBe(true);
    expect(shouldFire(HATCH, assessment("STOP"), proposalEv("failed", 2, 2, { expires: NOW - 1 }), NOW)).toBe(false);
  });
});

/** A radar double with the real contract: events not committed are reported again. */
function fakeRadar(batches: RadarEvent[][], current: (ev: RadarEvent) => RadarEvent | null = (ev) => ev) {
  let left = new Set<RadarEvent>();
  const commits: RadarEvent[] = [];
  const radar: any = {
    controllers: new Map(),
    watch: async () => ({}),
    current,
    scan: async () => {
      const events = [...left, ...(batches.shift() ?? [])];
      left = new Set(events);
      return { events, commitQuiet() {}, commit: (ev: RadarEvent) => (left.delete(ev), commits.push(ev)) };
    },
  };
  // The pre-scan() radar API (tick commits everything; forget re-reports one proposal), so these
  // tests also run, and fail on behaviour, against the earlier Guardian.
  let requeue: RadarEvent[] = [];
  let lastTick: RadarEvent[] = [];
  radar.tick = async () => {
    const s = await radar.scan();
    for (const ev of s.events) s.commit(ev);
    lastTick = [...requeue, ...s.events];
    requeue = [];
    return lastTick;
  };
  radar.forget = (_dao: string, id: number) => requeue.push(...lastTick.filter((e) => e.kind === "proposal" && e.proposal.id === id));
  return { radar, commits };
}

function guardianWith(
  events: RadarEvent[][],
  verdict: "OK" | "CAUTION" | "STOP",
  o: { health?: string; codeSource?: (call: number) => boolean; assessor?: (call: number, opts: any) => Promise<Assessment>; fire?: (n: number) => { tx: string | null; ok: boolean; error?: string }; hatches?: Hatch[]; clock?: { t: number }; maxDeposit?: bigint; current?: (ev: RadarEvent) => RadarEvent | null } = {},
) {
  const fires: string[] = [];
  const assessorCalls: any[] = [];
  const errors: unknown[] = [];
  const { radar, commits } = fakeRadar(events, o.current);
  const clock = o.clock ?? { t: NOW };
  const driver: HatchDriver = {
    health: async () => ({ state: o.health ?? "ARMED", reasons: (o.health ?? "ARMED") === "ARMED" ? [] : ["x"] }),
    fire: async (h) => (fires.push(h.id), o.fire ? o.fire(fires.length) : { tx: "FIRE_TX", ok: true }),
  };
  const g = new Guardian({
    rpc: {} as any,
    assess: {} as any,
    radar,
    hatches: () => o.hatches ?? [HATCH],
    driver,
    now: () => new Date(clock.t),
    maxDeposit: o.maxDeposit,
    unreadableRetry: { attempts: 3, baseMs: 1000, maxMs: 1000 },
    onError: (e) => errors.push(e),
    assessor: async (_deps, opts) => {
      assessorCalls.push(opts);
      if (o.assessor) return o.assessor(assessorCalls.length, opts);
      const a = assessment(verdict);
      return !o.codeSource || o.codeSource(assessorCalls.length) ? a : { ...a, code_source: null, grade: { ...a.grade, verdict: "CAUTION", fire: false, flags: ["PENDING_CODE_UNAVAILABLE"] } };
    },
  });
  return { g, fires, assessorCalls, commits, errors, clock };
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
    expect(fires).toEqual([HATCH.id]);
  });
  it("does not fire on CAUTION", async () => {
    const { g, fires } = guardianWith([[proposalEv("pending")]], "CAUTION");
    const [a] = await g.tick();
    expect(a.assessment?.grade.verdict).toBe("CAUTION");
    expect(fires).toEqual([]);
  });
  it("reports a hatch that is no longer ARMED instead of firing it", async () => {
    const { g, fires } = guardianWith([[proposalEv("pending")]], "STOP", { health: "USED" });
    const [a] = await g.tick();
    expect(fires).toEqual([]);
    expect(a.fired[0]).toMatchObject({ ok: false, tx: null });
    expect(a.fired[0].error).toMatch(/USED/);
  });

  it("an executed proposal first seen executed is graded against the code it replaced (#0)", async () => {
    const { g, assessorCalls } = guardianWith([[proposalEv("executed", 2, 2, { prev: "OLD" })]], "STOP");
    const [a] = await g.tick();
    expect(assessorCalls[0]).toMatchObject({ deployed: true, replaced: { hash: "OLD", height: 900 } });
    expect(a.fired).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("a deployed event reuses the pending-time assessment only if it was made against the replaced code (#0)", async () => {
    const dep = (old: string): RadarEvent => ({ kind: "deployed", target: "vault.testnet", old_hash: old, new_hash: "P", old_height: 950 });
    const { g, assessorCalls } = guardianWith([[proposalEv("pending")], [dep("L")], [dep("OTHER")]], "CAUTION");
    await g.tick();
    await g.tick();
    expect(assessorCalls).toHaveLength(1); // cached assessment was against "L", the replaced code
    await g.tick();
    expect(assessorCalls).toHaveLength(2);
    expect(assessorCalls[1]).toMatchObject({ deployed: true, replaced: { hash: "OTHER", height: 950 } });
  });

  it("a post-change NO_CHANGE never replaces a cached assessment made against other code (L2)", async () => {
    const noChange = (): Assessment => {
      const a = assessment("OK");
      return { ...a, live_hash: "P", code_source: { kind: "deployed" }, grade: { ...a.grade, flags: ["NO_CHANGE"] } };
    };
    const { g, assessorCalls } = guardianWith([[proposalEv("executed", 2, 2, { prev: "P" })]], "OK", { assessor: async () => noChange() });
    const before = assessment("CAUTION");
    const kept: Assessment = { ...before, live_hash: "unknown", code_source: { kind: "deployed" }, grade: { ...before.grade, flags: ["UNVERIFIED_PENDING_CODE", "REPLACED_CODE_UNAVAILABLE"] } };
    g.cache.set("vault.testnet:P", kept);
    await g.tick();
    expect(assessorCalls).toHaveLength(1);
    expect(g.cache.get("vault.testnet:P")).toBe(kept);
  });

  it("unreadable bytes: re-read with backoff, then keep the CAUTION; one alert, not one per tick (#4)", async () => {
    const clock = { t: NOW };
    const { g, assessorCalls, commits } = guardianWith([[proposalEv("pending")]], "STOP", { clock, codeSource: () => false });
    const alerts = [];
    for (let i = 0; i < 8; i++) {
      alerts.push(...(await g.tick()));
      clock.t += 600; // backoff 1000 ms: every second tick re-reads
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].assessment?.grade.flags).toEqual(["PENDING_CODE_UNAVAILABLE"]);
    expect(assessorCalls).toHaveLength(3); // the retry budget
    expect(commits).toHaveLength(1); // then committed: the radar stops re-reporting it
    // Later events for the same proposal reuse the kept assessment.
  });

  it("unreadable bytes that become readable: a new alert with the real grade, and the hatch fires (#4)", async () => {
    const clock = { t: NOW };
    const { g, fires } = guardianWith([[proposalEv("pending")]], "STOP", { clock, codeSource: (n) => n >= 2 });
    const a1 = await g.tick();
    clock.t += 1500;
    const a2 = await g.tick();
    expect(a1[0].assessment?.grade.verdict).toBe("CAUTION");
    expect(a2[0].assessment?.grade.verdict).toBe("STOP");
    expect(fires).toEqual([HATCH.id]);
  });

  it("a throw while handling one event does not drop the others, and the failed one is reported again (#2)", async () => {
    const e1 = proposalEv("pending", 0, 2, { id: 1 });
    const e2 = proposalEv("pending", 0, 2, { id: 2 });
    const { g, errors, commits, clock } = guardianWith([[e1, e2]], "CAUTION", {
      assessor: async (n) => {
        if (n === 1) throw new Error("txApi gave up");
        return assessment("CAUTION");
      },
    });
    const t1 = await g.tick();
    expect(t1.map((a) => a.proposal_id)).toEqual([2]);
    expect(errors).toHaveLength(1);
    expect(commits).toEqual([e2]);
    clock.t += 3_000; // the first retry is due after DEFAULT_FAILURE_RETRY.baseMs
    const t2 = await g.tick();
    expect(t2.map((a) => a.proposal_id)).toEqual([1]);
  });

  it("an event whose handling always throws is retried with backoff, then reported once as CAUTION / ASSESSMENT_FAILED and committed (L1)", async () => {
    const batches: RadarEvent[][] = [[proposalEv("pending", 0, 2)]];
    const { g, errors, commits, assessorCalls, clock } = guardianWith(batches, "STOP", {
      assessor: async () => {
        throw new Error("unexpected end");
      },
    });
    const alerts = [];
    for (let i = 0; i < 200; i++) {
      alerts.push(...(await g.tick())); // every 3 s for 10 minutes
      clock.t += 3_000;
    }
    // DEFAULT_FAILURE_RETRY: 3 s doubling to 60 s within 5 minutes: attempts at 0, 3, 9, 21, 45, 93,
    // 153, 213, 273 s; the next one (333 s) is past the window, so the 9th failure gives up.
    expect(assessorCalls).toHaveLength(9);
    expect(errors).toHaveLength(9);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].error).toBe("unexpected end");
    expect(alerts[0].fired).toEqual([]); // a stop hatch does not fire on CAUTION
    expect(alerts[0].assessment?.grade).toMatchObject({ verdict: "CAUTION", flags: ["ASSESSMENT_FAILED"], fire: false });
    expect(alerts[0].assessment?.grade.headline).toMatch(/could not be assessed \(unexpected end\)/);
    expect(alerts[0].assessment?.grade.reasons[0].text).toMatch(/9 attempts over 5 min/);
    expect(commits).toHaveLength(1);
    // A later vote on the same proposal: a new alert, but no new round of assessment.
    batches.push([proposalEv("pending", 1, 2)]);
    const later = await g.tick();
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ votes_to_execute: 1, error: "unexpected end" });
    expect(later[0].assessment?.grade.flags).toEqual(["ASSESSMENT_FAILED"]);
    expect(assessorCalls).toHaveLength(9);
  });

  it("a Failed proposal that can still be re-executed is assessed and fires a stop hatch (#6)", async () => {
    const { g, fires, assessorCalls } = guardianWith([[proposalEv("failed", 2, 2, { expires: NOW + 86400_000 })]], "STOP");
    const [a] = await g.tick();
    expect(assessorCalls[0].deployed).toBeFalsy(); // not yet executed: compared with the live code
    expect(a.assessment?.grade.verdict).toBe("STOP");
    expect(fires).toEqual([HATCH.id]);
  });

  it("a failed relay is retried on later ticks while the trigger holds, bounded, never after the hatch is used (#7)", async () => {
    const { g, fires, clock } = guardianWith([[proposalEv("pending")]], "STOP", { fire: (n) => (n === 1 ? { tx: null, ok: false, error: "relayer RPC timeout" } : { tx: "FIRE_TX", ok: true }) });
    const [a1] = await g.tick();
    expect(a1.fired[0]).toMatchObject({ ok: false, error: "relayer RPC timeout" });
    expect(await g.tick()).toEqual([]); // backing off: the retry is due 3 s later
    clock.t += 3_000;
    const t2 = await g.tick(); // no new radar event
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ retry: 2, fired: [expect.objectContaining({ ok: true, tx: "FIRE_TX" })] });
    expect(await g.tick()).toEqual([]);
    expect(fires).toEqual([HATCH.id, HATCH.id]);
    expect(g.fired.has(HATCH.id)).toBe(true);
  });

  it("a relay that keeps failing for 10 minutes (relayer out of gas) is still retried, with backoff, and fires once it works (L3)", async () => {
    const clock = { t: NOW };
    const t = guardianWith([[{ kind: "deployed", target: "vault.testnet", old_hash: "L", new_hash: "P", old_height: 1 }]], "STOP", {
      clock,
      fire: () => (clock.t < NOW + 10 * 60_000 ? { tx: null, ok: false, error: "relayer has not enough balance" } : { tx: "FIRE_TX", ok: true }),
    });
    for (let i = 0; i < 300; i++) {
      await t.g.tick(); // every 3 s for 15 minutes; a deployed event is reported once
      clock.t += 3_000;
    }
    expect(t.g.fired.has(HATCH.id)).toBe(true);
    // Backoff 3 s doubling to 60 s: far fewer relays than ticks, none after it worked.
    expect(t.fires.length).toBeGreaterThan(5);
    expect(t.fires.length).toBeLessThan(20);
  });

  it("retries end after the fire-retry window (default 30 minutes), and stop when the trigger no longer holds (L3, #7)", async () => {
    const clock = { t: NOW };
    const at: number[] = [];
    const always = guardianWith([[proposalEv("pending")]], "STOP", { clock, fire: () => (at.push(clock.t - NOW), { tx: null, ok: false, error: "x" }) });
    for (let i = 0; i < 800; i++) {
      await always.g.tick(); // every 3 s for 40 minutes
      clock.t += 3_000;
    }
    // Attempts at 0, 3, 9, 21, 45, 93 s, then every 60 s up to 1773 s; 1833 s is past 30 minutes.
    expect(at.slice(0, 7)).toEqual([0, 3_000, 9_000, 21_000, 45_000, 93_000, 153_000]);
    expect(at).toHaveLength(34);
    expect(at.at(-1)).toBe(1_773_000);
    const short = guardianWith([[proposalEv("pending")]], "STOP", { clock: { t: NOW }, fire: () => ({ tx: null, ok: false, error: "x" }) });
    (short.g.o as any).fireRetry = { baseMs: 1_000, maxMs: 1_000, windowMs: 2_500 };
    for (let i = 0; i < 10; i++) {
      await short.g.tick();
      short.clock.t += 1_000;
    }
    expect(short.fires).toHaveLength(3); // 0, 1, 2 s
    const gone = guardianWith([[proposalEv("pending")]], "STOP", { fire: () => ({ tx: null, ok: false, error: "x" }), current: (ev) => (ev.kind === "proposal" ? { ...ev, proposal: { ...ev.proposal, state: "rejected", status: "Rejected" } } : ev) });
    for (let i = 0; i < 4; i++) {
      await gone.g.tick();
      gone.clock.t += 60_000;
    }
    expect(gone.fires).toHaveLength(1);
  });

  it("a retry finds the hatch USED (its nonce landed): it is not fired again (#7)", async () => {
    let health = "ARMED";
    const t = guardianWith([[proposalEv("pending")]], "STOP", { fire: () => ((health = "USED"), { tx: "T", ok: false, error: "outcome failed" }) });
    (t.g.o.driver as any).health = async () => ({ state: health, reasons: [] });
    await t.g.tick();
    t.clock.t += 3_000;
    const [a] = await t.g.tick();
    expect(a.fired[0].error).toMatch(/USED/);
    expect(t.fires).toHaveLength(1);
    expect(await t.g.tick()).toEqual([]);
  });

  it("refuses to relay a hatch whose signed bytes do not match the record, or whose deposit is over the cap (#22)", async () => {
    const forged = { ...HATCH, venue: "other-vault.testnet" }; // record says other-vault, bytes say vault.testnet
    expect(fireRefusal(forged)).toMatch(/does not match its signed bytes/);
    expect(fireRefusal(HATCH)).toBeNull();
    const big = await signedHatch({ deposit: "5000000000000000000000000" });
    expect(fireRefusal(big)).toMatch(/above the relay cap of 1 yoctoNEAR/);
    expect(fireRefusal(big, 5_000_000_000_000_000_000_000_000n)).toBeNull();

    // The hatch of the recorded testnet run (data/guardian-run.json, read only) passes the checks.
    const run = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../data/guardian-run.json"), "utf8"));
    expect(fireRefusal(run.hatch)).toBeNull();

    // Record names the watched venue; the signed bytes go to another contract.
    const otherBytes = await signedHatch({ venue: "sink.testnet" });
    const swapped = { ...HATCH, signed_delegate: otherBytes.signed_delegate };
    const { g, fires } = guardianWith([[proposalEv("pending")]], "STOP", { hatches: [swapped, big] });
    const [a] = await g.tick();
    expect(fires).toEqual([]);
    expect(a.fired.map((f) => f.ok)).toEqual([false, false]);
    expect(a.fired.every((f) => /refused/.test(f.error ?? ""))).toBe(true);
    const capped = guardianWith([[proposalEv("pending")]], "STOP", { hatches: [big], maxDeposit: 5_000_000_000_000_000_000_000_000n });
    await capped.g.tick();
    expect(capped.fires).toEqual([big.id]);
  });
});

describe("Guardian on a mock chain, real radar and assessor", () => {
  it("an upgrade proposed and executed between two ticks (1-of-1 DAO) is STOP against the replaced code and fires (#0)", async () => {
    const c = new Chain();
    const VAULT = "vault.testnet";
    const DAO = "dao.testnet";
    c.setCode(VAULT, V1);
    c.daos[DAO] = { policy: policy([1, 2]), proposals: [] };
    const rpc = c.rpc();
    const radar = new Radar(rpc, "testnet", undefined, { nowMs: () => NOW, resolve: async (t) => ({ target: t, daos: [DAO], upgradable: false }) });
    const fires: string[] = [];
    const g = new Guardian({
      rpc,
      assess: { rpc, api: emptyTxApi },
      radar,
      hatches: () => [HATCH],
      driver: { health: async () => ({ state: "ARMED", reasons: [] }), fire: async (h) => (fires.push(h.id), { tx: "T", ok: true }) },
      now: () => new Date(NOW),
    });
    expect(await g.tick()).toEqual([]); // baseline
    c.advance(3);
    // Proposed, approved and executed between two ticks.
    c.daos[DAO].proposals.push(upgradeRemote(0, VAULT, await codeHash(V2), "Approved", 1));
    c.setCode(VAULT, V2);
    const alerts = await g.tick();
    expect(alerts.map((a) => a.event)).toEqual(["proposal", "deployed"]);
    for (const a of alerts) {
      expect(a.assessment?.grade.verdict).toBe("STOP");
      expect(a.assessment?.live_hash).toBe(await codeHash(V1));
    }
    expect(fires).toEqual([HATCH.id]);
  });

  /** v1 live, a 1-of-1 DAO; `setup` runs a real radar and assessor over it. */
  async function chainGuardian(o: { assessor?: typeof assessPending } = {}) {
    const c = new Chain();
    const VAULT = "vault.testnet";
    const DAO = "dao.testnet";
    c.setCode(VAULT, V1);
    c.daos[DAO] = { policy: policy([1, 2]), proposals: [] };
    const rpc = c.rpc();
    const clock = { t: NOW };
    const radar = new Radar(rpc, "testnet", undefined, { nowMs: () => clock.t, resolve: async (t) => ({ target: t, daos: [DAO], upgradable: false }) });
    const fires: string[] = [];
    const g = new Guardian({
      rpc,
      assess: { rpc, api: emptyTxApi },
      radar,
      hatches: () => [HATCH],
      driver: { health: async () => ({ state: "ARMED", reasons: [] }), fire: async (h) => (fires.push(h.id), { tx: "T", ok: true }) },
      now: () => new Date(clock.t),
      assessor: o.assessor,
    });
    const h1 = await codeHash(V1);
    const h2 = await codeHash(V2);
    // The upgrade is proposed, approved and executed between two ticks.
    const upgrade = () => {
      c.advance(3);
      c.daos[DAO].proposals.push(upgradeRemote(0, VAULT, h2, "Approved", 1));
      c.setCode(VAULT, V2);
    };
    return { c, g, fires, clock, h1, h2, upgrade, DAO };
  }

  it("an executed proposal handled after its deployed event (DAO unreadable that pass) reuses the grade against the replaced code, not OK NO_CHANGE (L2a)", async () => {
    const { c, g, fires, clock, h1, h2, upgrade, DAO } = await chainGuardian();
    expect(await g.tick()).toEqual([]);
    upgrade();
    let failOnce = true;
    c.fail = (p) => (p.account_id === DAO && p.method_name === "get_proposals" && failOnce ? ((failOnce = false), 503) : null);
    const t2 = await g.tick();
    expect(t2.map((a) => a.event)).toEqual(["deployed", "unreadable"]);
    expect(t2[0].assessment?.grade.verdict).toBe("STOP");
    clock.t += 3_000;
    const t3 = await g.tick();
    expect(t3.map((a) => a.event)).toEqual(["proposal"]);
    const a = t3[0].assessment!;
    expect(a.grade.flags).not.toContain("NO_CHANGE");
    expect(a.grade.verdict).toBe("STOP");
    expect(a.live_hash).toBe(h1);
    expect(g.cache.get(`vault.testnet:${h2}`)?.live_hash).toBe(h1);
    expect(g.cache.get(`vault.testnet:${h2}`)?.grade.verdict).toBe("STOP");
    expect(fires).toEqual([HATCH.id]);
  });

  it("an executed proposal whose handling threw once, while its deployed event succeeded, is graded against the replaced code on the retry (L2b)", async () => {
    let threw = false;
    const { g, clock, h1, h2, upgrade } = await chainGuardian({
      assessor: async (deps, o) => {
        if (o.proposal && !threw) {
          threw = true;
          throw new Error("tx API timeout");
        }
        return assessPending(deps, o);
      },
    });
    expect(await g.tick()).toEqual([]);
    upgrade();
    const t2 = await g.tick();
    expect(t2.map((a) => a.event)).toEqual(["deployed"]);
    expect(t2[0].assessment?.grade.verdict).toBe("STOP");
    clock.t += 3_000;
    const t3 = await g.tick();
    expect(t3.map((a) => a.event)).toEqual(["proposal"]);
    expect(t3[0].assessment?.grade.verdict).toBe("STOP");
    expect(t3[0].assessment?.live_hash).toBe(h1);
    expect(g.cache.get(`vault.testnet:${h2}`)?.grade.flags).not.toContain("NO_CHANGE");
  });

  it("an executed proposal whose code was already live before it (a no-op upgrade) is still OK NO_CHANGE (L2)", async () => {
    const { c, g, h1, DAO } = await chainGuardian();
    expect(await g.tick()).toEqual([]);
    c.advance(3);
    c.daos[DAO].proposals.push(upgradeRemote(0, "vault.testnet", h1, "Approved", 1));
    const [a] = await g.tick();
    expect(a.event).toBe("proposal");
    expect(a.assessment?.grade.flags).toContain("NO_CHANGE");
    expect(a.assessment?.grade.verdict).toBe("OK");
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
