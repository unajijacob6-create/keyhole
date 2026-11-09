# For judges: verify Keyhole in five minutes, with no keys

Everything below is read-only and needs no NEAR account, no API key and no funds.

```bash
git clone https://github.com/unajijacob6-create/keyhole && cd keyhole
npm ci
npm run judge      # 7 checks, prints [ok]/[FAIL], exits non-zero on failure
npm test           # offline unit tests (recorded RPC fixtures)
```

Behind an HTTP proxy, prefix Node commands with `NODE_USE_ENV_PROXY=1`.

## What `npm run judge` checks

| # | check | what it proves | re-check by hand |
|---|---|---|---|
| 1 | the testnet registry answers, and Keyhole grades the registry itself | `registry.keyhole.testnet` is live; its code imports no deploy or global-contract host function | `npx keyhole inspect registry.keyhole.testnet --evidence` |
| 2 | the demo vault's v1 → v2 silent upgrade is on record | the watcher's `ChangeObserved` record names block H; an **archival** `view_account` at H−1 returns v1's hash and at H returns v2's; the export diff shows `+ sweep` | `curl -s https://archival-rpc.testnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","account_id":"vault.keyhole.testnet","block_id":H}}'` |
| 3 | v1's wasm proves no method can redeploy it; the reproducible builds hash to the manifest | v1 imports no deploy, add-key or global-contract host function; each wasm in `contracts/repro/` hashes to the code hash its public CI build reported | `npx keyhole diff contracts/repro/demo_vault_v1.wasm contracts/repro/demo_vault_v2.wasm` |
| 4 | `inspect()` grades the recorded mainnet fixtures as recorded | deterministic grading on recorded RPC answers (offline) | `npm test` |
| 5 | labelled eval corpus | control class against ground truth (mainnet hand-labelled + testnet by construction); **zero dangerous misses** required | `npm run eval` → `docs/EVAL.md` |
| 6 | the TEE review receipt re-verifies offline | the EIP-191 signature recovers to the attested NEAR AI Cloud TEE address; the signed text is `model:sha256(request):sha256(response)`; the published response hashes to the signed hash; the registry's `AiReview` carries the same hash | `data/reviews/vault-v1-to-v2.json` |
| 7 | a SourceScan-verified mainnet contract re-checks, and a CI rebuild matches `intents.near` | `token.sweat`'s current hash is in SourceScan. Keyhole's CI rebuilt `intents.near` from its on-chain NEP-330 `build_info`, and the result matches the deployed hash (SourceScan's own entry for it is stale) | `.github/workflows/verify.yml` run, results on the `verifications` branch |

## Try the product

1. **Inspect any contract.**
   ```bash
   npx keyhole inspect usdt.tether-token.near
   ```
   You'll see **CAUTION · GOVERNED**: the `upgrade` method is gated by `tether.multisafe.near`, a
   2-of-3 multisig, and the current code is not source-verified. Add `--evidence` for the RPC
   command behind each reason.
2. **Run the silent-upgrade attack on testnet.**
   ```bash
   npm run demo:attack
   ```
   With no keys it creates a fresh testnet account from the public faucet and deploys its own
   private registry. It then runs:
   CAUTION → guarded deposit allowed → owner silently redeploys → watcher records it →
   `+ sweep` → **STOP** → the agent's next deposit is refused in code. About one minute.
   The TEE review step needs NEAR AI Cloud access and is skipped without it. A recorded receipt is
   in `data/reviews/`.
3. **Website:** <https://unajijacob6-create.github.io/keyhole/>. Paste an account, or a transaction
   JSON in "Before you sign".

## Honest scope

Keyhole is not an audit (see `docs/SECURITY.md`):
- Owner inference is heuristic and labelled "inferred".
- Builds are verified on a public CI runner, not in a TEE.
- The AI review is evidence, not a guarantee, and never sets the grade.
