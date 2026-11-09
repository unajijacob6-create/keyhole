// npm run guardian -- <command>
//
//   run     [--network testnet|mainnet] [--hatches file.json] [--watch a,b] [--interval 3] [--duration s]
//           [--feed data/alerts-<network>.jsonl] [--relayer <account>] [--review] [--max-deposit 1]
//           [--fire-retry-minutes 30]
//           Watch the venues of every hatch (and --watch targets), grade pending upgrades, fire
//           hatches whose trigger matches. Without --relayer it only alerts (read-only). Before
//           relaying, every hatch is checked offline (verifyHatch, signed receiver = venue, signed
//           sender = account) and its attached deposit, which the relayer pays, must be at most
//           --max-deposit yoctoNEAR (default 1). A relay that fails is retried with backoff while
//           its trigger still holds, for up to --fire-retry-minutes (default 30).
//   arm     --account <id> --venue <contract> --method <name> [--args '{}'] [--deposit 1] [--gas 50]
//           [--ttl-blocks 604800] [--trigger stop|any-upgrade|manual] [--hatches file.json]
//           Adds a dedicated full-access key to <account> (signed with its key from
//           ~/.near-credentials/testnet), pre-signs the call, stores the hatch. Testnet only.
//   status  [--hatches file.json]   Health of every stored hatch (ARMED / USED / REVOKED / EXPIRED / STALE).
//
// Hatches are stored in ~/.keyhole/hatches-<network>.json by default. A hatch holds no secret: it
// is a signed withdraw-to-self that anyone could submit. Keep it private anyway, so nobody can
// exit you early.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Rpc, txApi, ARCHIVAL_RPC, KEYHOLE_REGISTRY, type Network } from "../../packages/core/src/index.ts";
import { armDelegateHatch, fireHatch, hatchHealth, decodeHatch, type Hatch } from "../../packages/hatch/src/index.ts";
import { DEFAULT_FIRE_RETRY, Guardian, type Alert } from "./guardian.ts";
import { Radar } from "./radar.ts";
import { teeReviewer } from "./tee.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (f: string, d?: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const network = (arg("--network", "testnet") as Network);
const store = arg("--hatches", path.join(os.homedir(), ".keyhole", `hatches-${network}.json`))!;

const load = (): Hatch[] => (fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : []);
const save = (hs: Hatch[]) => {
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify(hs, null, 1), { mode: 0o600 });
};
const rpc = new Rpc({ network, cache: false });

if (cmd === "arm") {
  if (network !== "testnet") throw new Error("arm signs transactions: testnet only in this build");
  const { account, provider } = await import("../../scripts/lib/near.ts");
  const h = await armDelegateHatch({
    owner: account(arg("--account")!),
    provider,
    venue: arg("--venue")!,
    method: arg("--method")!,
    args: JSON.parse(arg("--args", "{}")!),
    deposit: arg("--deposit", "1"),
    gas: (BigInt(arg("--gas", "50")!) * 10n ** 12n).toString(),
    ttlBlocks: Number(arg("--ttl-blocks", String(7 * 24 * 3600))),
    trigger: arg("--trigger", "stop") as Hatch["trigger"],
  });
  save([...load(), h]);
  const d = decodeHatch(h);
  console.log(`armed ${h.id}: ${d.senderId} → ${d.receiverId}.${d.actions[0].method} (${d.actions[0].deposit} yocto) until block ${d.maxBlockHeight}; stored in ${store}`);
} else if (cmd === "status") {
  for (const h of load()) {
    const s = await hatchHealth(rpc, h);
    console.log(`${s.state.padEnd(8)} ${h.id} ${h.account} → ${h.venue}.${h.method} trigger=${h.trigger}${s.blocks_left !== null ? ` blocks_left=${s.blocks_left}` : ""}${s.reasons.length ? ` (${s.reasons.join("; ")})` : ""}`);
  }
} else if (cmd === "run") {
  const feed = arg("--feed", `data/alerts-${network}.jsonl`)!;
  const relayerId = arg("--relayer");
  const relayer = relayerId ? (await import("../../scripts/lib/near.ts")).account(relayerId) : null;
  const maxDeposit = BigInt(arg("--max-deposit", "1")!);
  if (maxDeposit < 0n) throw new Error("--max-deposit must be a non-negative yoctoNEAR amount");
  const fireRetryMinutes = Number(arg("--fire-retry-minutes", String(DEFAULT_FIRE_RETRY.windowMs / 60_000)));
  if (!Number.isFinite(fireRetryMinutes) || fireRetryMinutes < 0) throw new Error("--fire-retry-minutes must be a non-negative number");
  const radar = new Radar(rpc, network, undefined, { last: 20 });
  for (const t of arg("--watch", "")!.split(",").filter(Boolean)) await radar.watch(t);
  const guardian = new Guardian({
    rpc,
    assess: { rpc, api: txApi(network), archival: new Rpc({ network, url: ARCHIVAL_RPC[network], cache: false }), registry: { rpc: network === KEYHOLE_REGISTRY.network ? rpc : new Rpc({ network: KEYHOLE_REGISTRY.network }), account: KEYHOLE_REGISTRY.account }, reviewer: argv.includes("--review") ? teeReviewer() : null },
    radar,
    hatches: load,
    driver: relayer ? { health: (h) => hatchHealth(rpc, h), fire: (h) => fireHatch(h, relayer) } : null,
    maxDeposit,
    fireRetry: { ...DEFAULT_FIRE_RETRY, windowMs: fireRetryMinutes * 60_000 },
    onError: (e, ev) => console.error(`[guardian] ${ev ? `${ev.kind} ${ev.target}` : "watch"} failed (reported again next tick): ${String((e as Error).message).slice(0, 200)}`),
    onAlert: (a: Alert) => {
      fs.mkdirSync(path.dirname(feed), { recursive: true });
      fs.appendFileSync(feed, JSON.stringify(a) + "\n");
      const g = a.assessment?.grade;
      console.log(`[guardian] ${a.at} ${a.event} ${a.target}${a.proposal_id !== null ? ` #${a.proposal_id}` : ""}${g ? ` ${g.verdict}: ${g.headline}` : ""}${a.error ? ` (${a.error.slice(0, 200)})` : ""}${a.fired.map((f) => ` | ${f.ok ? "fired" : "not fired"} ${f.hatch}${f.tx ? " " + f.tx : ""}`).join("")}`);
    },
  });
  const interval = Number(arg("--interval", "3")) * 1000;
  const until = arg("--duration") ? Date.now() + Number(arg("--duration")) * 1000 : Infinity;
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  console.log(`[guardian] ${network}: ${load().length} hatch(es), ${radar.controllers.size} extra target(s), every ${interval / 1000}s${relayer ? `, relayer ${relayerId} (deposit cap ${maxDeposit} yoctoNEAR)` : ", alert-only"}`);
  while (!stop && Date.now() < until) {
    try {
      await guardian.tick();
    } catch (e) {
      console.error(`[guardian] tick failed (continuing): ${String((e as Error).message).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
} else {
  console.log("usage: guardian run|arm|status (see guardian/src/cli.ts)");
  process.exit(cmd ? 1 : 0);
}
