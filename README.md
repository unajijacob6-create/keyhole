# Keyhole

**See who can change the contract you're about to trust.**

On NEAR, a contract with no keys can still replace its own code. Wallets and explorers don't show
who holds that power, or whether the code running now is the code that was verified. Keyhole does.
It reads public RPC directly, grades deterministically, and gives the request that re-checks every claim.

- **Live site:** <https://unajijacob6-create.github.io/keyhole/> (static, runs in your browser)
- **Demo video:** *link added when the demo post is published*
- **For judges:** [docs/JUDGE.md](docs/JUDGE.md). `npm ci && npm run judge` needs no keys.

Built at NEAR HACKATHON (Nov 2026). Not a security audit; see [docs/SECURITY.md](docs/SECURITY.md).

## Try it (each step was run in this repo; output abridged)

**1. Verify the deployment, with no keys.**
```bash
npm ci && npm run judge
```
```
 1. [ok] the testnet registry answers, and Keyhole grades the registry itself
 2. [ok] the demo vault's v1 → v2 silent upgrade is on record at a block anyone can re-query
       archival view_account: E1arxbbpY6… at 276954999, BJU8rR1Mjy… at 276955000 (re-checked independently)
       export diff v1 → v2: + sweep
 ...
 7. [ok] a SourceScan-verified mainnet contract re-checks, and a CI rebuild matches intents.near
all checks ok (7 checks)
```

**2. Inspect any contract.** The same library as the website, run against public RPC:
```bash
npx keyhole inspect usdt.tether-token.near
```
```
[!!] CAUTION  ·  GOVERNED  ·  UNVERIFIED_CODE NO_SOURCE_METADATA
Code can be replaced only with multiple approvals (2 of 3). Current code is not source-verified.
Who can change it?
  - [governed] The contract can deploy contract through method `upgrade`, gated by its owner (inferred):
    tether.multisafe.near via owner() — multisig tether.multisafe.near: 2 of 3 members must confirm.
```
Add `--evidence` for the `curl` that re-checks each reason, or `--json` for agents.

**3. Run the silent-upgrade attack on testnet** (about 1 minute; with no keys it creates its own
faucet account and private registry):
```bash
npm run demo:attack
```
```
── 1. Keyhole inspects vault.keyhole.testnet
[!!] CAUTION · CUSTODIAL   Code can be replaced by a single key. Current code is source-verified.
── 2. agent deposits through guardCall
[guard] [!!] CAUTION allowed vault.keyhole.testnet.deposit() … deposit 0.1 NEAR ok
── 3. the owner key silently redeploys the vault with v2
── 4. watcher: block stream → registry
[watch] block 276,955,000  vault.keyhole.testnet  DeployContract (transaction)  E1arxb… → BJU8rR…  → registry ChangeObserved #13
export diff v1 → v2: + sweep
── 5. private review of the new code in a NEAR AI Cloud TEE
Qwen/Qwen3.8-27B: risk high — New 'sweep' function allows the owner to drain all vault funds …
receipt: TEE signer 0x835ab53d…aa26, nonce echoed true, signature verified true (only hashes leave memory)
── 6. Keyhole inspects vault.keyhole.testnet again
[XX] STOP · CUSTODIAL · UNVERIFIED_CODE CHANGED_24H AI_REVIEW_RISK
── 7. agent tries to deposit again
[guard] [XX] STOP refused vault.keyhole.testnet.deposit(): The code changed less than a minute ago …
deposit NOT sent: GuardRefusal thrown before signing; no transaction was created
```

**4. Website.** Paste any account. Or paste a transaction under **Before you sign**: it decodes
`ft_transfer_call` messages and meta-transactions, then grades every contract the transaction will run.

## How it works

```
                public NEAR RPC (FastNEAR) · archival RPC · neardata.xyz block stream
                                 │
  ┌──────────────────────────────┴──────────────────────────────────────┐
  │ @keyhole/core  inspect(account)   — runs in the browser and the CLI │
  │  view_account / view_access_key_list / view_code                    │
  │  wasm: host-function imports + call graph → who can reach deploy    │
  │  owner: get_owner / near-plugins ACL / Sputnik get_policy / multisig│
  │  NEP-330 build_info · SourceScan at this hash · archival change     │
  │  search · Keyhole registry attestations                             │
  │  grade() — pure, unit-tested → IMMUTABLE/GOVERNED/CUSTODIAL/…       │
  │          → OK / CAUTION / STOP, every reason with its re-check      │
  └───────┬───────────────────────────────┬─────────────────────────────┘
          │                               │
  @keyhole/guard guardCall()      watcher (GitHub Actions, ~5 h runs, self-dispatching)
  refuses in code on STOP         stream: tx + Delegate + receipt actions (neardata, best effort)
                                  poll: watchlist over RPC + archival bisection for the exact block
                                        → ChangeObserved / KeyAdded
                                          │
                     Keyhole registry (Rust, testnet) ◄── verifier: CI rebuild from NEP-330
                     attestations keyed by code hash  ◄── reviewer: NEAR AI Cloud TEE review
```

Grading rules: [docs/GRADING.md](docs/GRADING.md). Design: [docs/DESIGN.md](docs/DESIGN.md).

## NEAR primitives used, and why each is needed

| primitive | why Keyhole needs it |
|---|---|
| **Access keys** (full-access vs function-call) | Any full-access key can `DeployContract`; function-call keys cannot. This is the first upgrade path. The guard demo agent's refusal happens before signing. |
| **Wasm host functions** (`promise_batch_action_deploy_contract`, `…add_key_with_full_access`) | A contract with no keys can still redeploy itself. Keyhole reads the imports and the call graph of the deployed code. |
| **Global contracts (NEP-591)** | An account that references a global contract *by account id* changes code whenever the publisher redeploys. `view_account.global_contract_*` and `view_global_contract_code` are handled. |
| **NEP-330 `contract_source_metadata` / `build_info`** | The recipe for rebuilding the deployed code. Keyhole's CI uses it to rebuild and compare hashes. |
| **Sputnik DAO policy** (`get_policy`) | It turns "owned by a DAO" into "3 of 5 council members can pass a `call` proposal", using Sputnik's own threshold arithmetic. |
| **near-plugins ACL** | `acl_get_super_admins` and deployer roles. The roles are read from verified source when available. |
| **Named accounts + receipts** | The watcher follows executed receipts, so self-upgrades through an `upgrade` method and meta-transactions (`Delegate`) are caught, not only direct transactions. |
| **NEAR AI Cloud TEE** | A private review whose receipt (TEE attestation + signature over request/response hashes) anyone can re-verify. Only hashes go on-chain. |
| **A registry contract other apps query** | Attestations keyed by code hash (`ChangeObserved`, `KeyAdded`, `ReproducibleBuild`, `AiReview`). Each one names how to re-check it. |

## Why this gap is real (evidence, re-checked 2026-11-09)

From `npm run factcheck` (raw data: `docs/FACTCHECK.json`) and `npm run survey`
(`docs/STATE_OF_NEAR.md`), read-only against mainnet around block 223.8M:

| finding | number | source |
|---|---|---|
| Contracts with verified source on SourceScan, NEAR's verification registry | 110 total | `v2-verifier.sourcescan.near get_contracts_count` |
| …that no longer run the code that was verified | 37 of 110: 25 run different code, 3 have no code, 9 accounts are deleted. None of the 25 new hashes is verified anywhere in SourceScan | `get_contracts` + `view_account` per entry |
| …including | intents.near, venear.dao, vote.dao, lst.rhealab.near, btc-connector.bridge.near, zcash-client.bridge.near | same |
| 24 major contracts publishing reproducible-build metadata (`build_info`) | 7 of 24 | `contract_source_metadata` |
| 24 major contracts with a full-access key on the contract account | 7 of 24 (native USDC: 1; game.hot.tg: 66) | `view_access_key_list` |
| Major DeFi contracts whose wasm imports the deploy host function and exports an upgrade method | 7 of 7 sampled (intents, Ref v2, Burrow, Meta Pool, LiNEAR, USDT, Ref DCL) | `view_code` → wasm imports/exports |
| Top-50 NEP-141 tokens (list from our research notes) running SourceScan-verified code | 8 of 50; 27 publish no NEP-330 metadata | same method |
| Keyhole's watchlist survey of 24 contracts | 12 GOVERNED, 7 CUSTODIAL, 5 UNRESOLVED, 0 IMMUTABLE | `npm run survey` |

Two numbers from earlier research were **corrected** before publishing:
- **SourceScan.** "49 of 110 stale" counted 12 global-contract users as having no code, so it was wrong.
- **`view_state`.** The claim that public RPC rejects `view_state` on large contracts no longer holds: nearcore 2.14 pages it with `limit`.

**Why users care:**
- Chainalysis counts "over $3.4 billion in theft from January through early December 2025". The
  Bybit compromise alone was $1.5 billion of it
  ([Chainalysis, 2025-12-18](https://www.chainalysis.com/blog/crypto-hacking-stolen-funds-2026/)).
- The Ethereum Foundation calls blind signing "a structural flaw that has contributed to billions in
  user losses, including the Bybit hack"
  ([EF, 2026-05-12](https://blog.ethereum.org/2026/05/12/clear-signing-announcement)). Its clear-signing
  work (ERC-7730) does not cover NEAR.

## Results

- **Control-class eval** ([docs/EVAL.md](docs/EVAL.md)): **19 of 21 correct, 0 dangerous misses**
  on 12 hand-labelled mainnet contracts (controller established by protocol facts or verified
  source) and 9 testnet fixtures whose class is true by construction. Both misses are conservative:
  a single-key owner that no view method reveals, and an owner name nobody has registered yet, are
  reported UNRESOLVED rather than CUSTODIAL. `npm run judge` fails if Keyhole ever reports a stronger
  assurance than the truth.
- **AI review eval** ([docs/EVAL_REVIEW.md](docs/EVAL_REVIEW.md)): the TEE-hosted model caught
  **5 of 5** seeded malicious diffs (drain, unchecked owner change, removed balance check, fee
  diversion, new deploy capability) and flagged **0 of 2** benign diffs. Every receipt verified.
  This is evidence about one model on seven small diffs, not proof.
- **Independent verification**: Keyhole's CI rebuilt `intents.near` (rev `16d04f6`) and
  `token.sweat` from their on-chain `build_info`, and both match the deployed hash. SourceScan's entry
  for intents.near is for an older hash. `lst.rhealab.near`'s declared repository returns 404, so it
  could not be rebuilt.

## Trust model and limits

Full text: [docs/SECURITY.md](docs/SECURITY.md).
- **Core.** The core runs on your machine against public RPC, and every reason carries its re-check.
- **Attestations.** These are signed claims by named attesters, each re-checkable:
  - `ChangeObserved`: re-check with an archival `view_account`.
  - `ReproducibleBuild`: re-check by rebuilding on a public CI runner (not a TEE).
  - `AiReview`: re-check through the TEE signature and attestation.
- **Limits:**
  - Owner resolution is heuristic and labelled inferred.
  - A deploy import is not proof of upgradeability.
  - Wasm analysis can't see business logic.
  - There is no state simulation.
  - The AI review is evidence, never the grade.

## Repository

```
packages/core   inspect(), wasm analysis, controller resolution, grade(), decodeTransactions(), CLI
packages/guard  guardCall(): agents refuse STOP in code; CAUTION asks a human or fails closed
contracts/      registry (Rust, near-sdk 5), demo vaults v1/v2, reproducible builds in contracts/repro
watcher/        neardata follower (tx + Delegate + receipts) → registry + public feed branch
verifier/       rebuild deployed contracts from NEP-330 build_info (GitHub Actions)
reviewer/       NEAR AI Cloud TEE review, receipts, offline verification, seeded eval
web/            static site (Vite, vanilla TS), Playwright smoke at 360/768/1366 light/dark
scripts/        factcheck, survey, demo:attack, judge, eval, attest:builds
```

| command | what it does |
|---|---|
| `npm test` | unit tests, offline (recorded RPC fixtures) |
| `npm run judge` | the zero-key checks above |
| `npm run survey` | regenerate `docs/STATE_OF_NEAR.md` and the website's trust table |
| `npm run eval` / `npm run eval:review` | the two evals (`eval:review` needs NEAR AI Cloud access) |
| `npm run watch -- --network mainnet --all` | follow the chain locally |
| `bash contracts/test.sh` | build the contracts, then run unit and sandbox tests |
| `npm run test:web` | build the site and run the Playwright smoke test |

## Built during the hackathon, and what was reused

- **Built in the window.** All code in this repository was written during NEAR HACKATHON
  (2026-11-09 to 2026-11-14), with Claude Code. The repository starts empty at the first commit.
- **Reused from the same builder.** `reviewer/src/nearai.ts`, the NEAR AI Cloud attestation and
  signature verification, comes from
  [Standing Order](https://github.com/unajijacob6-create/standing-order) (`clerk/src/nearai.ts`),
  also written during this hackathon. The two projects are otherwise independent.
- **Libraries and services.**
  - Libraries: near-sdk 5, near-workspaces, near-plugins (read only), near-api-js, ethers (EIP-191
    recovery), bs58, Vite, Playwright, vitest, @fontsource.
  - Services: SourceScan (read), FastNEAR RPC, neardata.xyz, NEAR AI Cloud, and the
    sourcescan/cargo-near build image.

## After the hackathon

- **Wallet and dApp integration.** A free public API and SDK. First targets are Meteor, HOT,
  Intear, Bitte and NearBlocks (NearBlocks issue #1175 asks for deploy details).
- **Protocol badges.** Badges that expire when the code hash changes, and paid monitoring with
  per-upgrade TEE review for teams.
- **DAO tooling.** A "review this upgrade proposal" step for Trezu and NEAR Business, and a
  clear-signing descriptor NEP for NEAR methods.
- **Other chains.** The wasm analysis generalises to CosmWasm and Stylus.

## Other project by the same builder

[Standing Order](https://github.com/unajijacob6-create/standing-order): recurring payroll and
scheduled payouts for Sputnik DAO treasuries.

## License

MIT
