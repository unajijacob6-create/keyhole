// npm run watch -- [--network testnet|mainnet] [--watch a,b | --watchlist file.json] [--all]
//                  [--post] [--feed data/feed-<network>.jsonl] [--from <height>] [--duration <seconds>]
// --post signs `attest` on the testnet registry as the attester (watcher.keyhole.testnet by default).
import fs from "node:fs";
import { registryPoster } from "./poster.ts";
import { follow } from "./follow.ts";
import type { Network } from "../../packages/core/src/index.ts";

const argv = process.argv.slice(2);
const arg = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const network = (arg("--network") ?? "testnet") as Network;
const watch = new Set<string>([
  ...(arg("--watch")?.split(",").filter(Boolean) ?? []),
  ...(arg("--watchlist") ? (JSON.parse(fs.readFileSync(arg("--watchlist")!, "utf8")).accounts as string[]) : []),
]);
const feed = arg("--feed") ?? `data/feed-${network}.jsonl`;
const poster = argv.includes("--post") ? await registryPoster() : undefined;
const ctrl = new AbortController();
process.on("SIGINT", () => ctrl.abort());
process.on("SIGTERM", () => ctrl.abort());
// Never let a stray rejection kill the watcher: log it and keep going.
process.on("unhandledRejection", (e) => console.error(`[watch] unhandled rejection (continuing): ${String((e as Error)?.message ?? e).slice(0, 200)}`));
const durationMs = arg("--duration") ? Number(arg("--duration")) * 1000 : undefined;
const started = Date.now();
let total = 0;
let from = arg("--from") ? Number(arg("--from")) : undefined;
// Supervisor: any error inside follow() (RPC, neardata, registry) is logged and retried with
// backoff until the requested duration is over. The process exits 0 only at the end of its run.
for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
  const remaining = durationMs === undefined ? undefined : durationMs - (Date.now() - started);
  if (remaining !== undefined && remaining <= 0) break;
  try {
    const events = await follow({ network, watch, all: argv.includes("--all"), from, durationMs: remaining, feed, poster, signal: ctrl.signal, heartbeatMs: arg("--heartbeat") ? Number(arg("--heartbeat")) * 1000 : 300_000 });
    total += events.length;
    break;
  } catch (e) {
    const wait = Math.min(60_000, 5000 * 2 ** Math.min(attempt, 4));
    console.error(`[watch] ${network}: follow() failed (${String((e as Error)?.message ?? e).slice(0, 200)}); restarting in ${wait / 1000}s`);
    from = undefined; // resume from the current head
    await new Promise((r) => setTimeout(r, wait));
  }
}
console.log(`[watch] ${network} stopped after ${Math.round((Date.now() - started) / 1000)}s; ${total} event(s) reported`);
