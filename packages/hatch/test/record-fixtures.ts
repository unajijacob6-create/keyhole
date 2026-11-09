// Records the real RPC answers probeDeposit sees for a few withdraw methods, so the unit tests replay
// chain behaviour instead of a guess. Read-only view calls (no signing, nothing spent).
//
//   NODE_USE_ENV_PROXY=1 npx tsx packages/hatch/test/record-fixtures.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc, recordingTransport, type Network } from "../../core/src/rpc.ts";
import { probeDeposit } from "../src/index.ts";

export const PROBES: Record<Network, { contract: string; method: string; args: unknown }[]> = {
  mainnet: [
    { contract: "wrap.near", method: "near_withdraw", args: { amount: "1" } },
    { contract: "wrap.near", method: "ft_transfer", args: { receiver_id: "wrap.near", amount: "1" } },
    { contract: "v2.ref-finance.near", method: "withdraw", args: { token_id: "wrap.near", amount: "1" } },
    { contract: "intents.near", method: "ft_withdraw", args: { token: "wrap.near", receiver_id: "wrap.near", amount: "1" } },
    { contract: "linear-protocol.near", method: "unstake_all", args: {} },
    // Limits of the probe, recorded on purpose: bad args panic in the generated wrapper before the
    // method body (and its deposit check) runs; a missing method answers nothing about deposits.
    { contract: "wrap.near", method: "near_withdraw", args: { amount: "not-a-number" } },
    { contract: "wrap.near", method: "no_such_method", args: {} },
    // near-contract-standards `assert_at_least_one_yocto` (NFT nft_approve): a different message from
    // assert_one_yocto, and 1 yocto satisfies it.
    { contract: "asac.near", method: "nft_approve", args: { token_id: "1", account_id: "wrap.near" } },
    { contract: "near-punks.near", method: "nft_approve", args: { token_id: "1", account_id: "wrap.near" } },
    // A deposit demand that is neither of the two 1-yocto checks ("Requires positive attached deposit").
    { contract: "wrap.near", method: "near_deposit", args: {} },
  ],
  testnet: [{ contract: "wrap.testnet", method: "near_withdraw", args: { amount: "1" } }],
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.mkdirSync(dir, { recursive: true });
  for (const network of ["mainnet", "testnet"] as const) {
    const store: Record<string, { result?: unknown; error?: unknown }> = {};
    const rpc = new Rpc({ network, transport: recordingTransport(store), retries: 2 });
    for (const p of PROBES[network]) console.log(network, p.contract, p.method, JSON.stringify(await probeDeposit(rpc, p.contract, p.method, p.args)));
    fs.writeFileSync(path.join(dir, `probe-${network}.json`), JSON.stringify({ recorded_at: new Date().toISOString(), rpc: rpc.url, fixtures: store }, null, 1) + "\n");
  }
}
