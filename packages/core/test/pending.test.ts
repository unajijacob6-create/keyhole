// Upgrade radar on recorded mainnet answers (test/fixtures/pending/record.ts). Offline.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import {
  Rpc,
  fixtureTransport,
  requestKey,
  bytesToBase64,
  codeHash,
  base58,
  decodeUpgradeProposal,
  listUpgradeProposals,
  hashFromArgs,
  normaliseHash,
  isLive,
  stagedUpgrade,
  stagedCode,
  fetchPendingCode,
  txApi,
  UPGRADE_METHODS,
  TX_API,
  type TxApi,
} from "../src/index.ts";

const FX = path.join(import.meta.dirname, "fixtures/pending");
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, "mainnet.json.gz"))).toString("utf8"));
const NOW: number = fx.nowMs;
const rpc = (extra: Record<string, { result?: unknown; error?: unknown }> = {}) => new Rpc({ network: "mainnet", transport: fixtureTransport({ ...fx.fixtures, ...extra }), retries: 0 });
const ROOT = path.join(import.meta.dirname, "../../..");
const v1 = new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro/demo_vault_v1.wasm")));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/repro/manifest.json"), "utf8"));
const b64json = (o: unknown) => bytesToBase64(new TextEncoder().encode(JSON.stringify(o)));
/** A view answer in the shape the RPC returns it, for hand-made fixtures. */
const viewKey = (account: string, method: string, args: unknown = {}) =>
  requestKey("query", { request_type: "call_function", account_id: account, method_name: method, args_base64: b64json(args), finality: "final" });
const viewResult = (v: unknown) => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [], block_height: 1, block_hash: "x" } });

async function page(dao: string, from: number, limit: number) {
  const r = rpc();
  return { policy: await r.view<any>(dao, "get_policy"), proposals: await r.view<any[]>(dao, "get_proposals", { from_index: from, limit }) };
}

describe("decodeUpgradeProposal: every kind", () => {
  it("UpgradeRemote (sweat #39 token.sweat up_stage_code): hash from the proposal, required from upgrade_remote policy", async () => {
    const { policy, proposals } = await page("sweat-multisig.sputnik-dao.near", 35, 11);
    const p = decodeUpgradeProposal("sweat-multisig.sputnik-dao.near", proposals.find((x) => x.id === 39), policy, NOW)!;
    expect(p).toMatchObject({ kind: "UpgradeRemote", target: "token.sweat", method: "up_stage_code", code_hash: "9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi", hash_from: "proposal", status: "Approved", state: "executed" });
    // sweat_contract_voters: 5 members, default threshold 59/100 → floor(5·59/100)+1 = 3. vote_counts are strings here.
    expect(p.required).toBe(3);
    expect(p.votes).toEqual({ approve: 3, reject: 0, remove: 0 });
  });

  it("FunctionCall up_deploy_code (sweat #40, pretty-printed JSON args) pairs with the staged hash of #39", async () => {
    const { policy, proposals } = await page("sweat-multisig.sputnik-dao.near", 35, 11);
    const p = decodeUpgradeProposal("sweat-multisig.sputnik-dao.near", proposals.find((x) => x.id === 40), policy, NOW)!;
    expect(p).toMatchObject({ kind: "FunctionCall", target: "token.sweat", method: "up_deploy_code", code_hash: "9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi", hash_from: "args-hash", required: 3 });
  });

  it("all of sweat #35–45: six UpgradeRemote/up_deploy_code pairs decode, ChangePolicy #41 is skipped, Failed #43 → failed", async () => {
    const { policy, proposals } = await page("sweat-multisig.sputnik-dao.near", 35, 11);
    const ds = proposals.map((r) => decodeUpgradeProposal("sweat-multisig.sputnik-dao.near", r, policy, NOW));
    expect(ds.filter(Boolean).length).toBe(10);
    expect(ds[proposals.findIndex((r) => r.id === 41)]).toBeNull();
    expect(ds.find((p) => p?.id === 43)?.state).toBe("failed");
    expect(ds.every((p) => !p || p.code_hash)).toBe(true);
  });

  it("FunctionCall add_release_info (intents #103): hex hash → base58, equal to intents.near's live code hash", async () => {
    const { policy, proposals } = await page("intents.sputnik-dao.near", 99, 5);
    const p = decodeUpgradeProposal("intents.sputnik-dao.near", proposals.find((x) => x.id === 103), policy, NOW)!;
    expect(p).toMatchObject({ kind: "FunctionCall", target: "ctl-intents.near", method: "add_release_info", hash_from: "args-hash" });
    const live = await rpc().viewAccount("intents.near");
    expect(p.code_hash).toBe(live.code_hash);
    // council: threshold Weight(3) for call.
    expect(p.required).toBe(3);
    // Non-upgrade FunctionCalls on the same page (pa_unpause_feature) are skipped.
    expect(decodeUpgradeProposal("intents.sputnik-dao.near", proposals.find((x) => x.id === 100), policy, NOW)).toBeNull();
  });

  it("FunctionCall with a base64 hash (rainbowbridge #219) and with malformed JSON args (#179 → no hash)", async () => {
    const r = rpc();
    const policy = await r.view<any>("rainbowbridge.sputnik-dao.near", "get_policy");
    const p219 = decodeUpgradeProposal("rainbowbridge.sputnik-dao.near", await r.view("rainbowbridge.sputnik-dao.near", "get_proposal", { id: 219 }), policy, NOW)!;
    expect(p219.code_hash).toBe(base58.encode(Uint8Array.from(atob("ZbhuuoQIqgiH1mwqC0PiQt25gha+sgrLEjlhRjobiHw="), (c) => c.charCodeAt(0))));
    const p179 = decodeUpgradeProposal("rainbowbridge.sputnik-dao.near", await r.view("rainbowbridge.sputnik-dao.near", "get_proposal", { id: 179 }), policy, NOW)!;
    expect(p179).toMatchObject({ method: "up_deploy_code", code_hash: null, hash_from: null });
  });

  it("UpgradeSelf: target is the DAO, no method; required from upgrade_self", async () => {
    const policy = await rpc().view<any>("rainbowbridge.sputnik-dao.near", "get_policy");
    const raw = { id: 7, proposer: "a.near", description: "self", kind: { UpgradeSelf: { hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP" } }, status: "InProgress", vote_counts: { council: [1, 0, 0] }, votes: {}, submission_time: String(BigInt(NOW - 3600_000) * 1_000_000n) };
    const p = decodeUpgradeProposal("rainbowbridge.sputnik-dao.near", raw, policy, NOW)!;
    expect(p).toMatchObject({ kind: "UpgradeSelf", target: "rainbowbridge.sputnik-dao.near", method: null, hash_from: "proposal", state: "pending", required: 3, votes: { approve: 1, reject: 0, remove: 0 } });
    expect(p.expires_at_ms - p.submitted_at_ms).toBe(7 * 24 * 3600 * 1000);
  });

  it("raw-wasm FunctionCall args: decode leaves the hash null (sync), listUpgradeProposals hashes the bytes", async () => {
    const policy = await rpc().view<any>("rainbowbridge.sputnik-dao.near", "get_policy");
    const raw = { id: 0, proposer: "a.near", description: "stage", kind: { FunctionCall: { receiver_id: "c.near", actions: [{ method_name: "up_stage_code", args: bytesToBase64(v1), deposit: "0", gas: "1" }] } }, status: "InProgress", vote_counts: {}, votes: {}, submission_time: String(BigInt(NOW) * 1_000_000n) };
    expect(decodeUpgradeProposal("d.near", raw, policy, NOW)?.code_hash).toBeNull();
    const extra = {
      [viewKey("d.near", "get_last_proposal_id")]: viewResult(1),
      [viewKey("d.near", "get_policy")]: viewResult(policy),
      [viewKey("d.near", "get_proposals", { from_index: 0, limit: 1 })]: viewResult([raw]),
    };
    const [p] = await listUpgradeProposals(rpc(extra), "d.near", { nowMs: NOW });
    expect(p).toMatchObject({ code_hash: manifest.wasm["demo_vault_v1.wasm"].code_hash, hash_from: "args-code" });
  });

  it("status mapping and anchored method names", () => {
    const policy = { roles: [{ name: "c", kind: { Group: ["a", "b"] }, permissions: ["*:*"], vote_policy: {} }], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] }, proposal_period: "1000000000" };
    const mkRaw = (status: string, method = "upgrade") => ({ id: 1, proposer: "a", description: "", kind: { FunctionCall: { receiver_id: "t", actions: [{ method_name: method, args: b64json({ code_hash: Array(32).fill(7) }), deposit: "0", gas: "1" }] } }, status, vote_counts: { c: [2, 0, 0] }, votes: {}, submission_time: "0" });
    const st = (s: string) => decodeUpgradeProposal("d", mkRaw(s), policy, 0)!.state;
    expect(["InProgress", "Approved", "Rejected", "Removed", "Expired", "Moved", "Failed"].map(st)).toEqual(["pending", "executed", "rejected", "removed", "expired", "moved", "failed"]);
    // 2 members, Ratio(1/2) → floor(2·1/2)+1 = 2.
    expect(decodeUpgradeProposal("d", mkRaw("InProgress"), policy, 0)).toMatchObject({ code_hash: base58.encode(new Uint8Array(32).fill(7)), required: 2 });
    for (const m of ["deploy_token", "deploy_native_token", "upgrade_fee", "migrate"]) {
      expect(UPGRADE_METHODS.test(m)).toBe(false);
      expect(decodeUpgradeProposal("d", mkRaw("InProgress", m), policy, 0)).toBeNull();
    }
    for (const m of ["upgrade", "up_deploy_code", "up_stage_code", "add_release_info", "unrestricted_upgrade", "set_code"]) expect(UPGRADE_METHODS.test(m)).toBe(true);
  });
});

describe("hashFromArgs / normaliseHash", () => {
  const H = "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP";
  const bytes = base58.decode(H);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  it("base58, hex, 0x-hex, byte array and base64 forms all give the same base58 hash", async () => {
    for (const v of [H, hex, "0x" + hex.toUpperCase(), [...bytes], bytesToBase64(bytes)]) expect(normaliseHash(v)).toBe(H);
    for (const field of ["hash", "code_hash", "codeHash", "new_code_hash"]) expect(await hashFromArgs(b64json({ [field]: hex }))).toEqual({ hash: H, from: "args-hash" });
  });
  it("raw wasm args → sha256 of the args (matches the manifest code hash)", async () => {
    expect(await hashFromArgs(bytesToBase64(v1))).toEqual({ hash: manifest.wasm["demo_vault_v1.wasm"].code_hash, from: "args-code" });
  });
  it("rejects what is not a 32-byte hash", async () => {
    for (const v of ["abc", "0x1234", Array(31).fill(1), [...Array(31).fill(1), 256], 42, null, "Zm9v"]) expect(normaliseHash(v)).toBeNull();
    expect(await hashFromArgs(b64json({ account_id: "x.near" }))).toBeNull();
    expect(await hashFromArgs(bytesToBase64(new Uint8Array([1, 2, 3, 0xff])))).toBeNull(); // borsh / binary args
    expect(await hashFromArgs("%%%not base64")).toBeNull();
  });
});

describe("listUpgradeProposals (recorded)", () => {
  it("rainbowbridge: newest first; #330 InProgress past its 7-day period → expired; #326 omni.bridge.near F2no…", async () => {
    const ps = await listUpgradeProposals(rpc(), "rainbowbridge.sputnik-dao.near", { last: 6, nowMs: NOW });
    expect(ps.map((p) => p.id)).toEqual([333, 331, 330, 329, 326, 324]);
    const p330 = ps.find((p) => p.id === 330)!;
    expect(p330).toMatchObject({ status: "InProgress", state: "expired", target: "zcash-client.bridge.near", votes: { approve: 0, reject: 0, remove: 0 }, required: 3 });
    expect(NOW).toBeGreaterThan(p330.expires_at_ms);
    expect(ps.find((p) => p.id === 326)).toMatchObject({ kind: "FunctionCall", target: "omni.bridge.near", method: "up_deploy_code", code_hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP", state: "executed" });
    // The same proposal one day after submission was still pending.
    const raw = await rpc().view<any>("rainbowbridge.sputnik-dao.near", "get_proposals", { from_index: 285, limit: 50 });
    const policy = await rpc().view<any>("rainbowbridge.sputnik-dao.near", "get_policy");
    expect(decodeUpgradeProposal("rainbowbridge.sputnik-dao.near", raw.find((r: any) => r.id === 330), policy, p330.submitted_at_ms + 86400_000)!.state).toBe("pending");
  });

  it("ref-finance: #1018 UpgradeRemote v2.ref-finance.near `upgrade` GZmkbf…, Approved, 3 of 3 required", async () => {
    const ps = await listUpgradeProposals(rpc(), "ref-finance.sputnik-dao.near", { last: 3, nowMs: NOW });
    expect(ps.map((p) => p.id)).toEqual([1022, 1018, 1016]);
    expect(ps[1]).toMatchObject({ kind: "UpgradeRemote", target: "v2.ref-finance.near", method: "upgrade", code_hash: "GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi", status: "Approved", state: "executed", required: 3, votes: { approve: 3, reject: 0, remove: 0 }, proposer: "refchef.near" });
  });

  it("target filter keeps only proposals that change that contract", async () => {
    const ps = await listUpgradeProposals(rpc(), "rainbowbridge.sputnik-dao.near", { last: 2, nowMs: NOW, target: "omni.bridge.near" });
    expect(ps.map((p) => [p.id, p.target])).toEqual([[326, "omni.bridge.near"], [324, "omni.bridge.near"]]);
  });
});

describe("stagedUpgrade (near-plugins)", () => {
  it("base58 string format (omni.bridge.near): staged == live → not pending; delay status read", async () => {
    const s = (await stagedUpgrade(rpc(), "omni.bridge.near"))!;
    expect(s).toMatchObject({ staged_hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP", live_hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP", pending: false, staging_duration_ms: null });
    expect(s.staging_timestamp_ms).toBe(1793136162705); // up_get_delay_status.staging_timestamp 1793136162705294087 ns
  });
  it("raw 32-byte array format (btc-client, factory from an older plugin version) normalises to base58", async () => {
    for (const c of ["btc-client.bridge.near", "factory.bridge.near"]) {
      const s = (await stagedUpgrade(rpc(), c))!;
      expect(s.staged_hash).toBe(s.live_hash);
      expect(s.pending).toBe(false);
    }
    expect((await stagedUpgrade(rpc(), "btc-client.bridge.near"))!.staged_hash).toBe("D33CUc5cPxYyfNbv1yXyEcKhDsvwCusqAjADvGJ9tPUg");
  });
  it("intents.near has no up_* methods → null", async () => {
    expect(await stagedUpgrade(rpc(), "intents.near")).toBeNull();
  });
  it("staged != live → pending, with staging duration in ms; nothing staged → not pending", async () => {
    const acct = { amount: "0", locked: "0", code_hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP", storage_usage: 1, block_height: 1, block_hash: "x" };
    const accKey = requestKey("query", { request_type: "view_account", account_id: "s.near", finality: "final" });
    const staged = [...base58.decode("9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi")];
    const s = (await stagedUpgrade(rpc({ [accKey]: { result: acct }, [viewKey("s.near", "up_staged_code_hash")]: viewResult(staged), [viewKey("s.near", "up_get_delay_status")]: viewResult({ staging_duration: 86400_000_000_000, staging_timestamp: 1793136162705294087 }) }), "s.near"))!;
    expect(s).toMatchObject({ staged_hash: "9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi", pending: true, staging_duration_ms: 86400_000 });
    const none = (await stagedUpgrade(rpc({ [accKey]: { result: acct }, [viewKey("s.near", "up_staged_code_hash")]: viewResult(null), [viewKey("s.near", "up_get_delay_status")]: viewResult({ staging_duration: null, staging_timestamp: null }) }), "s.near"))!;
    expect(none).toMatchObject({ staged_hash: null, pending: false, staging_timestamp_ms: null });
  });
});

describe("fetchPendingCode", () => {
  const realPage = JSON.parse(fs.readFileSync(path.join(FX, "fastnear-account-page.json"), "utf8"));
  const DAO = "ref-finance.sputnik-dao.near";
  // A tiny valid-looking wasm (magic + version + a custom section) stands in for the 897 KB blob.
  const blob = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x05, 0x04, 0x6b, 0x65, 0x79, 0x68]);
  const decoy = new Uint8Array([...blob.subarray(0, 14), 0x00]);
  const fc = (method: string, args: Uint8Array, receiver = DAO) => ({ receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, args: bytesToBase64(args), gas: 1, deposit: "0" } }] });

  /** Fake API: the real recorded page(s), and per-hash synthetic transactions (default: an act_proposal). */
  function fake(pages: any[], txs: Record<string, { signer?: string; body: any }>) {
    const calls: { path: string; body: any }[] = [];
    const api: TxApi = async (p, body: any) => {
      calls.push({ path: p, body });
      if (p === "/v0/account") return pages[body.resume_token === undefined ? 0 : pages.findIndex((x) => x.token_in === body.resume_token)] ?? { account_txs: [] };
      if (body.tx_hashes.length > 20) throw new Error("Limit is 20");
      return { transactions: body.tx_hashes.map((h: string) => ({ transaction: { hash: h, signer_id: txs[h]?.signer ?? "council.near", ...(txs[h]?.body ?? fc("act_proposal", new TextEncoder().encode('{"id":1,"action":"VoteApprove"}'))) } })) };
    };
    return { api, calls };
  }
  const hashOf = async (b: Uint8Array) => codeHash(b);

  it("finds the store_blob in the second /v0/transactions batch of a real page; returns height and signer; skips a newer decoy", async () => {
    const target = realPage.account_txs[25];
    const newer = realPage.account_txs[3];
    const { api, calls } = fake([realPage], { [target.transaction_hash]: { signer: "refchef.near", body: fc("store_blob", blob) }, [newer.transaction_hash]: { body: fc("store_blob", decoy) } });
    const r = await fetchPendingCode({ api, dao: DAO, hash: await hashOf(blob) });
    expect(r).toEqual({ code: blob, tx: target.transaction_hash, signer: "refchef.near", height: target.tx_block_height });
    expect(calls.map((c) => c.path)).toEqual(["/v0/account", "/v0/transactions", "/v0/transactions"]); // stopped early
    expect(calls[0].body).toEqual({ account_id: DAO, is_real_receiver: true });
    expect(calls.slice(1).every((c) => c.body.tx_hashes.length <= 20)).toBe(true);
  });

  it("pages with resume_token, and stops after maxPages", async () => {
    const page2 = { token_in: realPage.resume_token, account_txs: [{ transaction_hash: "Page2Tx", tx_block_height: 100, is_success: true }], resume_token: "2" };
    const page3 = { token_in: "2", account_txs: [{ transaction_hash: "Page3Tx", tx_block_height: 50, is_success: true }], resume_token: "3" };
    const { api, calls } = fake([realPage, page2, page3], { Page3Tx: { signer: "late.near", body: fc("store_blob", blob) } });
    expect(await fetchPendingCode({ api, dao: DAO, hash: await hashOf(blob), maxPages: 2 })).toBeNull();
    expect(calls.filter((c) => c.path === "/v0/account").map((c) => c.body.resume_token)).toEqual([undefined, realPage.resume_token]);
    const found = await fetchPendingCode({ api: fake([realPage, page2, page3], { Page3Tx: { signer: "late.near", body: fc("store_blob", blob) } }).api, dao: DAO, hash: await hashOf(blob) });
    expect(found).toMatchObject({ tx: "Page3Tx", signer: "late.near", height: 50 });
  });

  it("verifies sha256: bytes that do not hash to the requested hash are never returned", async () => {
    const t = realPage.account_txs[0].transaction_hash;
    const { api } = fake([{ ...realPage, resume_token: null }], { [t]: { body: fc("store_blob", decoy) } });
    expect(await fetchPendingCode({ api, dao: DAO, hash: await hashOf(blob) })).toBeNull();
  });

  it("accepts a borsh Vec<u8> stage call and a store_blob inside a delegate action; ignores failed txs and other receivers", async () => {
    const borsh = new Uint8Array([blob.length, 0, 0, 0, ...blob]);
    const [a, b, c, d] = ["A", "B", "C", "D"];
    const pg = { account_txs: [{ transaction_hash: a, tx_block_height: 4, is_success: false }, { transaction_hash: b, tx_block_height: 3 }, { transaction_hash: c, tx_block_height: 2 }, { transaction_hash: d, tx_block_height: 1 }], resume_token: null };
    const delegate = { receiver_id: "relayed.near", actions: [{ Delegate: { delegate_action: { receiver_id: DAO, actions: [{ FunctionCall: { method_name: "store_blob", args: bytesToBase64(blob), gas: 1, deposit: "0" } }] } } }] };
    const run = (txs: Record<string, any>) => fetchPendingCode({ api: fake([pg], txs).api, dao: DAO, hash: "" + hashCache });
    const hashCache = await hashOf(blob);
    expect(await run({ [a]: { body: fc("store_blob", blob) } })).toBeNull(); // failed tx
    expect(await run({ [b]: { body: fc("store_blob", blob, "other.near") } })).toBeNull(); // not sent to the DAO
    expect((await run({ [c]: { body: fc("up_stage_code", borsh) } }))?.code).toEqual(blob);
    expect((await run({ [d]: { body: delegate } }))?.tx).toBe(d);
    // DelegateV2 (nearcore ActionView::DelegateV2 { delegate_action: VersionedDelegateActionPayload::V2(..) },
    // externally tagged in JSON). Shape taken from nearcore source, not observed on mainnet.
    const v2 = { receiver_id: "relayed.near", actions: [{ DelegateV2: { delegate_action: { V2: delegate.actions[0].Delegate.delegate_action }, signature: "ed25519:x" } }] };
    expect((await run({ [d]: { body: v2 } }))?.tx).toBe(d);
  });

  it("rejects a hash that is not 32 bytes of base58", async () => {
    await expect(fetchPendingCode({ api: fake([realPage], {}).api, dao: DAO, hash: "abc" })).rejects.toThrow(/32-byte/);
  });
});

describe("txApi", () => {
  it("POSTs JSON to the network's FastNEAR tx host and retries 429", async () => {
    const seen: { url: string; body: string }[] = [];
    let n = 0;
    const f = (async (url: string, init: any) => {
      seen.push({ url, body: init.body });
      return n++ === 0 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify({ account_txs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = txApi("testnet", f);
    expect(await api("/v0/account", { account_id: "x.testnet" })).toEqual({ account_txs: [] });
    expect(seen.map((s) => s.url)).toEqual([TX_API.testnet + "/v0/account", TX_API.testnet + "/v0/account"]);
    expect(JSON.parse(seen[0].body)).toEqual({ account_id: "x.testnet" });
    expect(TX_API.mainnet).toBe("https://tx.main.fastnear.com");
  });
  it("a 400 is final (no retry)", async () => {
    let n = 0;
    const f = (async () => (n++, new Response('{"error":"Bad request"}', { status: 400 }))) as unknown as typeof fetch;
    await expect(txApi("mainnet", f)("/v0/transactions", { tx_hashes: [] })).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });
});

describe("keyhole pending (CLI, recorded)", () => {
  it("lists a DAO's upgrade proposals newest first with state, votes x/required, age and expiry", async () => {
    const { pendingCommand } = await import("../src/cli.ts");
    const r = await pendingCommand("rainbowbridge.sputnik-dao.near", { rpc: rpc(), nowMs: NOW, last: 6, api: async () => ({}) });
    const lines = r.text.split("\n");
    expect(lines[0]).toContain("Sputnik DAO; proposals expire after 7d; approvals needed: upgrade_remote 3, upgrade_self 3, call 3");
    expect(lines.findIndex((l) => /^\s+333\s/.test(l))).toBeLessThan(lines.findIndex((l) => /^\s+326\s/.test(l)));
    expect(lines.find((l) => /^\s+330\s/.test(l))).toMatch(/330\s+expired\s+FunctionCall\s+zcash-client\.bridge\.near\s+up_deploy_code\s+HFfccErR…\s+0\/3\s+\d+d\s+\d+d ago/);
    expect(lines.find((l) => /^\s+326\s/.test(l))).toMatch(/executed\s+FunctionCall\s+omni\.bridge\.near\s+up_deploy_code\s+F2no3vqr…\s+3\/3/);
    expect((r.json as any).proposals).toHaveLength(6);
    expect(r.verdict).toBeNull();
  });
});

// ── Review fixes: protocol details checked against near-plugins / nearcore sources and live RPC ──

const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

describe("stagedCode (near-plugins up_staged_code is #[result_serializer(borsh)])", () => {
  // Live shape (btc-client.bridge.near, 2026-11-09): 456,865 result bytes = tag 0x01, u32 LE length
  // 456,860, then the wasm, whose sha256 is up_staged_code_hash. Not JSON, so a JSON view cannot read it.
  const H = manifest.wasm["demo_vault_v1.wasm"].code_hash as string;
  const borshSome = (b: Uint8Array) => new Uint8Array([1, ...u32le(b.length), ...b]);
  const raw = (bytes: Uint8Array) => ({ [viewKey("s.near", "up_staged_code")]: { result: { result: [...bytes], logs: [], block_height: 1, block_hash: "x" } } });
  it("decodes borsh Some(code) and checks the hash", async () => {
    expect(await stagedCode(rpc(raw(borshSome(v1))), "s.near", H)).toEqual(v1);
    expect(await stagedCode(rpc(raw(borshSome(v1))), "s.near", "9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi")).toBeNull();
  });
  it("borsh None, a truncated answer and a missing account give null", async () => {
    expect(await stagedCode(rpc(raw(new Uint8Array([0]))), "s.near", H)).toBeNull();
    expect(await stagedCode(rpc(raw(borshSome(v1).subarray(0, 100))), "s.near", H)).toBeNull();
    expect(await stagedCode(rpc({ [viewKey("s.near", "up_staged_code")]: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } } }), "s.near", H)).toBeNull();
  });
  it("still accepts a JSON base64 string answer (non-borsh implementations)", async () => {
    expect(await stagedCode(rpc({ [viewKey("s.near", "up_staged_code")]: viewResult(bytesToBase64(v1)) }), "s.near", H)).toEqual(v1);
  });
});

describe("isLive: a Failed proposal inside its period can still execute (sputnikdao2 v3 Action::Finalize)", () => {
  // sputnikdao2 at 3d568f9 (v3.1, the version ref-finance.sputnik-dao.near runs per sputnik-dao.near
  // get_contracts_metadata): proposal_status accepts InProgress | Failed, and Finalize re-executes a
  // Failed proposal that still has its approvals. v2.0 (c2cf155) only lets Finalize expire it.
  const policy = { roles: [{ name: "c", kind: { Group: ["a", "b"] }, permissions: ["*:*"], vote_policy: {} }], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] }, proposal_period: String(7n * 86400n * 1_000_000_000n) };
  const raw = (status: string, ageMs: number) => ({ id: 5, proposer: "a", description: "", kind: { UpgradeSelf: { hash: "F2no3vqrFxm2c34mZqoMNawhRYYHbp22WuRqN6vEd3KP" } }, status, vote_counts: { c: [2, 0, 0] }, votes: {}, submission_time: String(BigInt(NOW - ageMs) * 1_000_000n) });
  const live = (status: string, ageMs: number) => isLive(decodeUpgradeProposal("d", raw(status, ageMs), policy, NOW)!, NOW);
  it("pending → live; Failed within the period → live; Failed after it, executed, expired → not", () => {
    expect(live("InProgress", 86400_000)).toBe(true);
    expect(live("Failed", 86400_000)).toBe(true);
    expect(live("Failed", 8 * 86400_000)).toBe(false);
    expect(live("Approved", 86400_000)).toBe(false);
    expect(live("InProgress", 8 * 86400_000)).toBe(false);
  });
  it("the CLI table shows when a Failed proposal stops being re-executable", async () => {
    const { formatProposals } = await import("../src/cli.ts");
    const row = formatProposals([decodeUpgradeProposal("d", raw("Failed", 86400_000), policy, NOW)!], NOW)[1];
    expect(row).toMatch(/failed .* in 6d \(Finalize can re-run it\)/);
  });
});

describe("hashFromArgs: borsh Vec<u8> wasm args (as fetchPendingCode accepts them)", () => {
  it("hashes the wasm inside a u32-length-prefixed argument", async () => {
    const borsh = new Uint8Array([...u32le(v1.length), ...v1]);
    expect(await hashFromArgs(bytesToBase64(borsh))).toEqual({ hash: manifest.wasm["demo_vault_v1.wasm"].code_hash, from: "args-code" });
  });
});

describe("keyhole pending --fetch-code (offline)", () => {
  const H1 = manifest.wasm["demo_vault_v1.wasm"].code_hash as string;
  const v2 = new Uint8Array(fs.readFileSync(path.join(ROOT, "contracts/repro/demo_vault_v2.wasm")));
  const policy = { roles: [{ name: "council", kind: { Group: ["a.near", "b.near"] }, permissions: ["*:*"], vote_policy: {} }], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] }, proposal_period: String(7n * 86400n * 1_000_000_000n) };
  const proposal = (status: string, hash: string, ageMs: number) => ({ id: 0, proposer: "a.near", description: "", kind: { UpgradeRemote: { receiver_id: "vault.near", method_name: "upgrade", hash } }, status, vote_counts: { council: [1, 0, 0] }, votes: { "a.near": "Approve" }, submission_time: String(BigInt(NOW - ageMs) * 1_000_000n) });
  const chain = (raw: unknown) => ({
    [viewKey("d.near", "get_policy")]: viewResult(policy),
    [viewKey("d.near", "get_last_proposal_id")]: viewResult(1),
    [viewKey("d.near", "get_proposals", { from_index: 0, limit: 1 })]: viewResult([raw]),
    [requestKey("query", { request_type: "view_account", account_id: "vault.near", finality: "final" })]: { result: { amount: "0", locked: "0", code_hash: H1, storage_usage: 1, block_height: 1, block_hash: "x" } },
    [requestKey("query", { request_type: "view_code", account_id: "vault.near", finality: "final" })]: { result: { hash: H1, code_base64: bytesToBase64(v1), block_height: 1, block_hash: "x" } },
  });
  // No registry or SourceScan fixtures: both lookups fail and count as "no attestation", offline.
  const registry = () => new Rpc({ network: "testnet", transport: fixtureTransport({}), retries: 0 });

  it("a *pending* proposal for the code already live is NO_CHANGE / OK, not graded against older code", async () => {
    const { pendingCommand } = await import("../src/cli.ts");
    const r = await pendingCommand("d.near", { rpc: rpc(chain(proposal("InProgress", H1, 3600_000))), registry: registry(), nowMs: NOW, fetchCode: true, api: async () => ({ account_txs: [] }) });
    expect((r.json as any).fetch.retrospective).toBeNull();
    expect((r.json as any).fetch.grade.flags).toEqual(["NO_CHANGE"]);
    expect(r.verdict).toBe("OK");
  });

  it("an executed proposal whose code is no longer live says so, and grades what redeploying it would change", async () => {
    const { pendingCommand } = await import("../src/cli.ts");
    const H2 = await codeHash(v2);
    const api: TxApi = async (p, body: any) =>
      p === "/v0/account"
        ? { account_txs: [{ transaction_hash: "Blob", tx_block_height: 9, is_success: true }], resume_token: null }
        : { transactions: body.tx_hashes.map((h: string) => ({ transaction: { hash: h, signer_id: "a.near", receiver_id: "d.near", actions: [{ FunctionCall: { method_name: "store_blob", args: bytesToBase64(v2), gas: 1, deposit: "0" } }] } })) };
    const r = await pendingCommand("d.near", { rpc: rpc(chain(proposal("Approved", H2, 30 * 86400_000))), registry: registry(), nowMs: NOW, fetchCode: true, api });
    expect((r.json as any).fetch.superseded).toBe(true);
    expect(r.text).toMatch(/executed, but its code is not the live code of vault\.near/);
    expect(r.verdict).toBe("STOP"); // v1 → v2 adds `sweep`, unverified
  });

  it("near-plugins staging_timestamp is the earliest deploy time (stage time + staging_duration), not the stage time", async () => {
    const { formatStaged } = await import("../src/cli.ts");
    const later = formatStaged({ contract: "s.near", staged_hash: "9EUtV11wgCZ4N16xa24ETnn8E78GjeSit1r7gMyQZ6Zi", live_hash: H1, staging_timestamp_ms: NOW + 3600_000, staging_duration_ms: 86400_000, pending: true }, NOW).join("\n");
    expect(later).not.toMatch(/staged at/);
    expect(later).toMatch(/deployable from .* \(in 1h\); staging delay 24h/);
    const past = formatStaged({ contract: "s.near", staged_hash: H1, live_hash: H1, staging_timestamp_ms: NOW - 3 * 86400_000, staging_duration_ms: null, pending: false }, NOW).join("\n");
    expect(past).toMatch(/deployable since .* \(3d ago\); no staging delay/);
  });

  it("--last must be a positive integer", async () => {
    const { parseLast } = await import("../src/cli.ts");
    expect(parseLast(undefined)).toBeUndefined();
    expect(parseLast("10")).toBe(10);
    for (const bad of ["ten", "0", "-3", "2.5", ""]) expect(() => parseLast(bad)).toThrow(/--last/);
  });
});
