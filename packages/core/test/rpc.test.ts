import { describe, expect, it } from "vitest";
import { Rpc, type Transport } from "../src/rpc.ts";

function counting(): { transport: Transport; n: () => number } {
  let n = 0;
  return { transport: async () => ({ status: 200, json: { jsonrpc: "2.0", id: "keyhole", result: { n: ++n } } }), n: () => n };
}

describe("Rpc cache", () => {
  it("shares identical requests by default", async () => {
    const c = counting();
    const rpc = new Rpc({ transport: c.transport });
    const a = await rpc.call("query", { request_type: "view_account", account_id: "a", finality: "final" });
    const b = await rpc.call("query", { request_type: "view_account", account_id: "a", finality: "final" });
    expect([a.n, b.n, c.n()]).toEqual([1, 1, 1]);
  });
  it("cache: false re-reads finality-pinned requests but still shares block-pinned ones", async () => {
    const c = counting();
    const rpc = new Rpc({ transport: c.transport, cache: false });
    await rpc.call("query", { request_type: "view_account", account_id: "a", finality: "final" });
    await rpc.call("query", { request_type: "view_account", account_id: "a", finality: "final" });
    expect(c.n()).toBe(2);
    await rpc.call("query", { request_type: "view_account", account_id: "a", block_id: 5 });
    await rpc.call("query", { request_type: "view_account", account_id: "a", block_id: 5 });
    expect(c.n()).toBe(3);
  });
});
