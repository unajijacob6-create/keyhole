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
const events = await follow({
  network,
  watch,
  all: argv.includes("--all"),
  from: arg("--from") ? Number(arg("--from")) : undefined,
  durationMs: arg("--duration") ? Number(arg("--duration")) * 1000 : undefined,
  feed,
  poster,
  signal: ctrl.signal,
});
console.log(`[watch] stopped; ${events.length} event(s) reported`);
