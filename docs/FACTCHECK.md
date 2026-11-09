# Phase 0 fact-check (2026-11-09)

`npm run factcheck` re-queries NEAR mainnet (read-only, no keys) and writes the raw data to
`docs/FACTCHECK.json`. Run on 2026-11-09 around 17:08 UTC, at final block ~223,796,020, against
`https://rpc.mainnet.fastnear.com` (nearcore 2.14.0, protocol 88). Every number published in the README or UI must be
re-run on the day it is published.

| # | Claim in the brief | Result | Use it? |
|---|---|---|---|
| 1 | SourceScan holds 110 verified mainnet contracts | `get_contracts_count` = 110 | yes |
| 2 | 49/110 (45%) run different code than verified | **Changed.** 73 match, 25 run different code (23%), 3 have no code, 9 accounts are deleted. 37/110 (34%) no longer run the verified code. Of the 25, none of the new hashes is in SourceScan. The 49 in the research counted 12 global-contract users as "no code": their `code_hash` is `1111…` and the real hash is in `global_contract_hash` (all 12 match) | publish the corrected split |
| 3 | intents.near, venear.dao, vote.dao, lst.rhealab.near, btc-connector.bridge.near, zcash-client.bridge.near are stale | all 6 STALE | yes |
| 4 | 7/24 sample publish NEP-330 `build_info`; ref, burrow, wrap, meta-pool, usdt, native USDC, priceoracle don't | 7/24, same list; 7/7 named still lack it | yes |
| 5 | 7/24 have full-access keys; native USDC 1, game.hot.tg 66 | 7/24, USDC 1, game.hot.tg 66 | yes |
| 6 | Top-50 tokens: 8 run SourceScan-verified code; 27 lack NEP-330 | 8/50 and 27/50. The token list comes from the research notes; the market-cap ranking is not re-derived | yes, stating the list source |
| 7 | Major DeFi contracts import `promise_batch_action_deploy_contract` and export an upgrade method; wrap.near imports it with no upgrade export | 7/7 (intents, ref v2, burrow, meta-pool, linear, usdt, dclv2); wrap.near import yes, export none | yes |
| 8 | Public RPC rejects `view_state` on large contracts | **Changed.** Without `limit`: TOO_LARGE_CONTRACT_STATE. With the new `limit` parameter (nearcore 2.14), `wrap.near` pages (5 values, `last_key` returned) | drop it as a "gap" |
| 9 | Global contract fields and host functions | `global_contract_hash` / `global_contract_account_id` on `view_account`; `view_global_contract_code[_by_account_id]` queries; host functions `promise_batch_action_{deploy_global_contract, deploy_global_contract_by_account_id, use_global_contract, use_global_contract_by_account_id}`. Live: 12 SourceScan accounts (e.g. `jau.sputnik-dao.near`) run global code | yes |
| 10 | Wasm in Node and Chromium; neardata | intents.near 1,267 KiB: `view_code` ~250 ms, `WebAssembly.Module` 3 ms (Node 22), 14 ms (Chromium 153). neardata `/v0/last_block/final` returns 200 on mainnet and testnet | yes |
| 11 | Rustle last commit 2023-07-10; NearBlocks #1610 closed Aug 2026; #1175 open; btc-bridge #78 rebuild "did not match" | Checked through github.com pages (api.github.com is blocked from this sandbox for repos outside the session): Rustle Jul 10 2023; #1610 closed 2026-08-28; #1175 open; btc-bridge #78 **open**, quote: "Our own sealed rebuild of the revision we pinned did not match" | yes |

Notes for the build:

- **Effective code hash.** `view_account.code_hash` is `1111…` for accounts that run a global contract. Keyhole must use
  `global_contract_hash`, or resolve `global_contract_account_id` with `view_code`, which returns the global code and
  its hash.
- **Errors are not absence.** A transient RPC error once made a token look as if it had no NEP-330 metadata. Core treats
  only deterministic contract errors (MethodNotFound, no code, panic) as "absent" and retries everything else.
- **`ActionView::DeployContract`** in nearcore's RPC views carries `sha256(code)`, not the code. The watcher can read the new hash
  straight from the block stream without fetching the wasm.
- **New host functions** to classify: `promise_batch_action_add_key_with_full_access` (a contract that can add a
  full-access key to itself can upgrade indirectly), `promise_batch_action_state_init*` and gas-key actions.
