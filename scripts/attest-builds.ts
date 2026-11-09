// npm run attest:builds — post ReproducibleBuild attestations to the Keyhole registry from public CI
// results: (a) the `verifications` branch (deployed contracts rebuilt from on-chain NEP-330
// build_info), (b) the `repro-builds` manifest (this repo's contracts). Signed by the attester
// (watcher.keyhole.testnet). Skips anything already attested. CI runs are public; the attester only
// relays their result, so every attestation can be re-checked by re-running the build.
import { execFileSync } from "node:child_process";
import { Rpc, KEYHOLE_REGISTRY, normaliseRecord } from "../packages/core/src/index.ts";
import { registryPoster } from "../watcher/src/poster.ts";

const registry = process.env.KH_REGISTRY ?? KEYHOLE_REGISTRY.account;
const rpc = new Rpc({ network: "testnet" });
const poster = await registryPoster({ registry });
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" });
git("fetch", "-q", "origin", "verifications:refs/remotes/origin/verifications", "repro-builds:refs/remotes/origin/repro-builds");

async function already(codeHash: string, rev: string) {
  const recs = ((await rpc.view<any[]>(registry, "get_attestations", { code_hash: codeHash, from_index: 0, limit: 100 })) ?? []).map(normaliseRecord);
  return recs.some((r) => r.attestation.kind === "ReproducibleBuild" && (r.attestation as any).rev === rev);
}

const jobs: { codeHash: string; att: Record<string, unknown>; label: string }[] = [];
for (const f of git("ls-tree", "-r", "--name-only", "origin/verifications").split("\n").filter((f) => f.endsWith(".json"))) {
  const v = JSON.parse(git("show", `origin/verifications:${f}`));
  if (v.matches === null || v.matches === undefined) {
    console.log(`skip ${v.account}: ${v.reason}`);
    continue;
  }
  jobs.push({ codeHash: v.onchain_code_hash, label: `${v.account} (${v.network}) rebuilt in ${v.run}`, att: { kind: "ReproducibleBuild", account: v.account, repo: v.repo, rev: v.rev, image_digest: String(v.image ?? "").split("@")[1] ?? String(v.image), matches: v.matches } });
}
const manifest = JSON.parse(git("show", "origin/repro-builds:latest/manifest.json"));
const ATTEST_OWN = (process.env.KH_ATTEST_OWN ?? "demo_vault_v1.wasm,keyhole_registry.wasm").split(",");
for (const [file, w] of Object.entries<any>(manifest.wasm)) {
  if (!ATTEST_OWN.includes(file)) continue; // v2 is the demo's "attacker" code: deliberately not attested
  jobs.push({ codeHash: w.code_hash, label: `${file} built in ${manifest.run}`, att: { kind: "ReproducibleBuild", account: null, repo: "https://github.com/unajijacob6-create/keyhole", rev: manifest.rev, image_digest: manifest.image.split("@")[1], matches: true } });
}
for (const j of jobs) {
  if (await already(j.codeHash, String(j.att.rev))) {
    console.log(`exists  ${j.codeHash.slice(0, 8)}… ${j.label}`);
    continue;
  }
  const p = await poster.attest!(j.codeHash, j.att);
  console.log(`posted  #${p.id} ${j.codeHash.slice(0, 8)}… matches=${j.att.matches} ${j.label} (tx ${p.tx})`);
}
