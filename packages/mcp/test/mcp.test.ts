// The MCP server in-process (SDK in-memory transport) on an offline fake chain: a vault whose owner
// is a 2-of-2 Sputnik DAO with a live upgrade proposal for code that adds sweep().
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { codeHash } from "../../core/src/index.ts";
import { DAO, DAO_WASM, NOW, VAULT, daoViews, fakeChain, fakeTxApi, proposal, wasm, type ChainState } from "../../guard/test/fake-chain.ts";
import { fixedHatch, tamperPayload } from "../../hatch/test/helpers.ts";
import { createServer, validate } from "../src/server.ts";
import { TOOLS } from "../src/tools.ts";

const LIVE = wasm("guarded_vault.wasm");
const SWEEP = wasm("guarded_vault_evil_sweep.wasm");

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function connect(proposals: any[], blobs: Uint8Array[], extra: Partial<ChainState> = {}) {
  const state: ChainState = {
    accounts: { [VAULT]: { code: LIVE }, [DAO]: { code: DAO_WASM } },
    views: { [DAO]: daoViews(proposals), [VAULT]: { get_owner: DAO } },
    ...extra,
  };
  const chain = fakeChain(state);
  const api = fakeTxApi(DAO, blobs);
  const server = createServer({ rpc: () => chain.rpc, txApi: () => api, registry: false, sourceRoles: false, nowMs: () => NOW, txBudget: 50 });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: r.content[0].text as string, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { client, call, chain, api };
}

describe("@keyhole/mcp server", () => {
  it("lists the four read-only tools with JSON-schema inputs", async () => {
    const { client } = await connect([], []);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["keyhole_inspect", "keyhole_pending", "keyhole_check_call", "keyhole_verify_hatch"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("keyhole_inspect: verdict, who can change the code (the DAO and its threshold), reasons with evidence", async () => {
    const { call } = await connect([], []);
    const r = await call("keyhole_inspect", { contract: VAULT });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ schema: "keyhole.mcp.inspect/1", contract: VAULT, network: "testnet", exists: true, code: { hash: await codeHash(LIVE) } });
    expect(["OK", "CAUTION", "STOP"]).toContain(r.json.verdict);
    expect(r.json.owners[0]).toMatchObject({ account: DAO, actor: { dao: { required_approvals: 2, role: "council", role_size: 2 } } });
    expect(r.json.who_can_change_the_code.some((p: any) => p.via === "contract-method" && p.control === "governed" && p.text.includes(DAO))).toBe(true);
    expect(r.json.reasons.length).toBeGreaterThan(0);
    expect(r.json.reasons.every((x: any) => Array.isArray(x.evidence))).toBe(true);
    expect(r.json.disclaimer).toMatch(/not a security audit/);
  });

  it("keyhole_pending {contract}: resolves the DAO, grades the live proposal STOP from the store_blob bytes, lists settled ones ungraded", async () => {
    const h = await codeHash(SWEEP);
    const { call } = await connect([proposal(0, "Approved", await codeHash(LIVE), { approvals: 2, ageMs: 9 * 86400_000 }), proposal(1, "InProgress", h, { approvals: 1 })], [SWEEP]);
    const r = await call("keyhole_pending", { contract: VAULT });
    expect(r.json).toMatchObject({ contract: VAULT, controllers: [DAO], live_count: 1, live_verdict: "STOP" });
    const [live, old] = r.json.proposals;
    expect(live).toMatchObject({ id: 1, state: "pending", live: true, code_hash: h, votes: { approve: 1 }, required: 2, is_current_code: false });
    expect(live.grade).toMatchObject({ verdict: "STOP", pending_hash: h, code_source: { kind: "store_blob", tx: "TX0", signer: "a.testnet" }, flags: ["UNVERIFIED_PENDING_CODE", "NEW_MONEY_PATH"] });
    expect(live.grade.headline).toMatch(/^STOP/);
    expect(live.grade.summary.join(" ")).toMatch(/sweep/);
    expect(old).toMatchObject({ id: 0, state: "executed", live: false, is_current_code: true });
    expect(old.grade).toBeUndefined();
    expect(old.not_graded).toMatch(/settled/);
  });

  it("keyhole_pending {dao}: every target of that DAO", async () => {
    const h = await codeHash(SWEEP);
    const { call } = await connect([proposal(0, "InProgress", h, { target: "other.testnet" }), proposal(1, "InProgress", h)], [SWEEP], {
      accounts: { [VAULT]: { code: LIVE }, [DAO]: { code: DAO_WASM }, "other.testnet": { code: LIVE } },
    });
    const r = await call("keyhole_pending", { dao: DAO });
    expect(r.json.proposals.map((p: any) => p.target)).toEqual([VAULT, "other.testnet"]);
    expect(r.json.live_verdict).toBe("STOP");
  });

  it("keyhole_pending: needs exactly one of contract or dao", async () => {
    const { call } = await connect([], []);
    expect((await call("keyhole_pending", {})).text).toMatch(/exactly one of contract or dao/);
    expect((await call("keyhole_pending", { contract: VAULT, dao: DAO })).isError).toBe(true);
  });

  it("keyhole_pending: when the oldest proposal read is still inside its period, older live ones are not ruled out (CAUTION)", async () => {
    const h = await codeHash(LIVE);
    const { call } = await connect([0, 1, 2].map((i) => proposal(i, "Approved", h, { approvals: 2 })), []);
    const r = await call("keyhole_pending", { contract: VAULT, limit: 2 });
    expect(r.json).toMatchObject({ live_count: 0, live_complete: false, live_verdict: "CAUTION" });
    expect(r.json.notes[0]).toMatch(/not ruled out/);
    const all = await call("keyhole_pending", { contract: VAULT, limit: 4 });
    expect(all.json).toMatchObject({ live_complete: true, live_verdict: "OK" });
  });

  it("keyhole_check_call: STOP from the pending upgrade, without executing anything", async () => {
    const h = await codeHash(SWEEP);
    const { call, chain } = await connect([proposal(0, "InProgress", h)], [SWEEP]);
    const r = await call("keyhole_check_call", { contract: VAULT, method: "deposit", deposit: "1000000000000000000000000" });
    expect(r.json).toMatchObject({ decision: "STOP", would_execute_by_default: false, executed: false, pending_stop: { dao: DAO, proposal_id: 0, pending_hash: h } });
    expect(r.json.reason).toContain(`proposal #0 of ${DAO}`);
    expect(r.json.pending.upgrades[0]).toMatchObject({ verdict: "STOP", code_source: { kind: "store_blob" } });
    // Only reads went to the chain.
    expect(chain.log.every((l) => /^(block|view_account|view_access_key_list|view_code|call_function) /.test(l) || l === "block")).toBe(true);
  });

  it("keyhole_check_call: nothing pending gives the live code's verdict; check_pending:false skips the pending check", async () => {
    const { call } = await connect([], []);
    const r = await call("keyhole_check_call", { contract: VAULT, method: "deposit" });
    expect(r.json.decision).toBe(r.json.live_code.verdict === "STOP" ? "STOP" : r.json.live_code.verdict);
    expect(r.json.pending).toMatchObject({ verdict: "OK", daos: [DAO], upgrades: [] });
    const off = await call("keyhole_check_call", { contract: VAULT, method: "deposit", check_pending: false });
    expect(off.json.pending).toBeNull();
  });

  it("keyhole_check_call: an RPC outage in the pending check is CAUTION, not OK", async () => {
    const { call } = await connect([], [], { outage: (p) => p.method_name === "get_last_proposal_id" });
    const r = await call("keyhole_check_call", { contract: VAULT, method: "deposit" });
    expect(["CAUTION", "STOP"]).toContain(r.json.decision);
    expect(r.json.pending.verdict).toBe("CAUTION");
    expect(r.json.pending.errors[0]).toMatch(/RPC HTTP 500/);
  });

  it("keyhole_verify_hatch: offline verify + decode; a tampered hatch fails", async () => {
    const { call, chain } = await connect([], []);
    const h = await fixedHatch();
    const good = await call("keyhole_verify_hatch", { hatch: h });
    expect(good.json).toMatchObject({ ok: true, record: { venue: "wrap.testnet", method: "near_withdraw" }, signed: { sender: "alice.testnet", receiver: "wrap.testnet" } });
    expect(good.json.signed.actions[0]).toMatchObject({ kind: "functionCall", method: "near_withdraw", deposit: "1" });
    const asString = await call("keyhole_verify_hatch", { hatch: JSON.stringify(h) });
    expect(asString.json.ok).toBe(true);
    const bad = await call("keyhole_verify_hatch", { hatch: { ...h, signed_delegate: tamperPayload(h, (da) => (da.receiverId = "evil.testnet")) } });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.checks.some((c: string) => c.startsWith("FAIL"))).toBe(true);
    expect(chain.log).toEqual([]); // offline
  });

  it("rejects unknown and malformed arguments", async () => {
    const { call } = await connect([], []);
    expect((await call("keyhole_inspect", {})).text).toMatch(/missing required argument: contract/);
    expect((await call("keyhole_inspect", { contract: "Not An Account!" })).text).toMatch(/contract is not valid/);
    expect((await call("keyhole_inspect", { contract: VAULT, private_key: "x" })).text).toMatch(/unknown argument: private_key/);
    expect((await call("keyhole_inspect", { contract: VAULT, network: "betanet" })).text).toMatch(/must be one of/);
  });
});

describe("no tool can sign", () => {
  const FORBIDDEN = /key|secret|sign|seed|mnemonic|private|passw|credential|keystore/i;
  const names = (schema: any): string[] => Object.entries(schema?.properties ?? {}).flatMap(([k, v]) => [k, ...names(v), ...names((v as any).items)]);

  it("no tool name or input property asks for a key, secret or signature", () => {
    for (const t of TOOLS) {
      expect(t.name).not.toMatch(/sign|send|transfer|deploy|withdraw|fire|arm|deposit|execute/i);
      for (const n of names(t.inputSchema)) expect(n, `${t.name}.${n}`).not.toMatch(FORBIDDEN);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("the server sources never touch signing or sending APIs", () => {
    const dir = path.join(import.meta.dirname, "../src");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      for (const api of ["KeyPair", "fromRandom", "signTransaction", "sendTransaction", "signAndSendTransaction", "addFullAccessKey", "armDelegateHatch", "armFunctionCallHatch", "fireHatch", "fireFunctionCallHatch", "guardCall(", "near-credentials", "KeyStore", "broadcast_tx", "send_tx"]) {
        expect(src.includes(api), `${f} mentions ${api}`).toBe(false);
      }
    }
  });

  it("validate() applies the declared schema", () => {
    const s = TOOLS.find((t) => t.name === "keyhole_check_call")!.inputSchema;
    expect(validate(s, { contract: "a.near", method: "deposit", deposit: "12" })).toBeNull();
    expect(validate(s, { contract: "a.near", method: "deposit", deposit: "1.5" })).toMatch(/deposit/);
    expect(validate(s, { contract: "a.near" })).toMatch(/method/);
  });
});
