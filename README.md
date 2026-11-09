# Keyhole Guardian

**See the upgrade coming. Get out before it lands.**

Of 24 major NEAR contracts Keyhole surveyed (`npm run survey`,
[STATE_OF_NEAR.md](docs/STATE_OF_NEAR.md)), 11 are governed by a Sputnik DAO (their code is replaced
through a DAO vote), among them Ref, Burrow, Meta Pool and LiNEAR, and none is immutable. A Sputnik DAO
executes an upgrade in the same call as the vote that reaches its threshold. There is no timelock to
wait out. Keyhole watches those proposals, reads the exact code they would install where it can (for
`UpgradeRemote`/`UpgradeSelf` the code is the argument of a `store_blob` transaction to the DAO, which
must be on chain before the proposal executes; for near-plugins deploys it is usually the code staged
on the target), grades it, and can submit a withdraw call the depositor signed in advance. Underneath
is Keyhole's contract inspector: who can change a contract, and whether the code running now is the
verified code. Every claim comes with the request that re-checks it.

- **Live site:** <https://unajijacob6-create.github.io/keyhole/> (static; the upgrade radar grades
  mainnet proposals in your browser)
- **Demo video:** *link added when the demo post is published*
- **For judges:** [docs/JUDGE.md](docs/JUDGE.md). `npm ci && npm run judge` needs no keys.
- **How Guardian works, with proofs and limits:** [docs/GUARDIAN.md](docs/GUARDIAN.md)

Built at NEAR HACKATHON (Nov 2026). Not a security audit; see [docs/SECURITY.md](docs/SECURITY.md).

## Try it (each step was run in this repo; output abridged)

**1. Verify everything with no keys.**
```bash
npm ci && npm run judge
```
```
 8. [ok] Guardian: the recorded testnet run re-derives from archival RPC (bytes, signature, order, outcome)
       ok  store_blob bytes hash to GHmAPqMjCHbj9PQcmp9Wjjh4WMRcBxq5vF9pFaYbFWsm (proposal hash GHmAPqMjCH…)
       ok  diff of live code vs the stored blob (re-derived now): + sweep; newly reachable: transfer←sweep
       ok  guardian tx rRASc9f6YheRZiEZiW22XS1HBHXxBTnuq1aAZEmZp36 carries that signed delegate (…)
       ok  hatch at block 276976501 < deciding vote at block 276976524 (23 blocks earlier)
 9. [ok] Guardian: the hatch's signed bytes decode to exactly one withdraw-to-self, and tampering is rejected (offline)
10. [ok] Guardian: a real mainnet upgrade's bytes were public before its vote (Ref proposal 1018)
       store_blob HhJpLfgiaMGrF6etg2XnhcxBNJRendZwV8K9U43fAw5S by refchef.near at block 222301033: 897024 bytes, sha256 = proposal hash
all checks ok (10 checks)
```

**2. Watch a DAO upgrade get caught before the deciding vote** (testnet; `-- --replay` re-checks the
recorded run without keys, `npm run setup:guardian` first for a live run):
```bash
npm run demo:guardian
```
```
── 5. council-a.keyhole.testnet stores a new wasm and proposes UpgradeRemote(gv-mw9s8ox4.keyhole.testnet.upgrade)
store_blob: 113387 bytes · proposal #2 "Vault v1.1: gas optimisations"
── 6. guardian: fetch the exact bytes being voted on, diff, grade, act
ALERT proposal #2 · 2 more approval(s) execute it · STOP: unverified code adds a new path to move funds.
   bytes: 113387 read from store_blob tx E7eefiBGPxxn22onTwpaENpVZgWwbV7ChCUoMT9yKdWJ
   diff: new methods: sweep
   diff: transfer now reachable from: sweep
   TEE review: high — New 'sweep' method can transfer the contract's balance, and a new hard-coded account 'keyhole-attacker.testnet' appears.
   FIRED hatch 474ac154d50db38a for alice.keyhole.testnet
registry registry.keyhole.testnet AiReview #16 for the pending hash (posted before the deciding vote)
── 7. the council votes; the second approval executes the upgrade in the same call
── 8. anyone calls sweep()
── 9. outcome
alice: hatch fired at block 276976501, upgrade executed at block 276976524 → out before it landed
bob: no hatch; the sweep took the vault's remaining total
```

**3. See what NEAR's DAOs are upgrading** (mainnet, read-only):
```bash
npx keyhole pending ref-finance.sputnik-dao.near --last 5
```
```
ref-finance.sputnik-dao.near  (mainnet, Sputnik DAO; proposals expire after 7d; approvals needed: upgrade_remote 3, upgrade_self 3, call 3)
  id    state    kind          target                        method           hash      votes age  expires
  1022  executed UpgradeRemote dclv2.ref-labs.near           upgrade          3G34Nhjm… 3/3   5d   -
  1018  executed UpgradeRemote v2.ref-finance.near           upgrade          GZmkbfVL… 3/3   10d  -
```
Add `--fetch-code` to read the bytes, diff them against the live code and grade them.

**4. Arm an escape hatch on a real token** (testnet keys): `npm run hatch:live` wraps 0.1 NEAR in
`wrap.testnet`, arms a hatch for `near_withdraw` (which needs 1 yoctoNEAR, so a function-call key could
not call it), lets a different account relay it, and checks that a replay is refused.
[HATCH.md](docs/HATCH.md) has the run and the hatch's limits.

**5. Inspect any contract** (Keyhole's foundation). The same library as the website, run against public RPC:
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

**6. The other path: a silent redeploy with no vote.** Run it on testnet (about 1 minute; with no keys it creates its own
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

**7. Website.** Watch the recorded Guardian run, browse the mainnet upgrade radar, or paste any account. Or paste a transaction under **Before you sign**: it decodes
`ft_transfer_call` messages and meta-transactions, then grades every contract the transaction will run.

## For agents

- **`@keyhole/guard`** ([packages/guard/README.md](packages/guard/README.md)). `guardCall()` grades
  the target before the agent's call and refuses STOP in code: it throws `GuardRefusal` and never
  calls `execute`. The verdict is the worst of the live code's grade and the grade of every upgrade
  that can still execute (`policy.checkPending`, default on): Sputnik proposals of the DAO that
  controls the target, and near-plugins staged code, each graded from the exact bytes. A live
  pending upgrade graded STOP refuses the call. Bytes that cannot be read, an RPC error or an
  unfinished proposal list give CAUTION, never OK; CAUTION asks a human (`policy.ask`) or is denied
  by default.
- **Auto-hatch, testnet only.** Pass `hatch` to `guardCall` and, after a successful call, the guard
  arms a delegate hatch for the same venue ([HATCH.md](docs/HATCH.md)). It refuses before deciding
  or executing when the network or the venue is not testnet.
- **`@keyhole/mcp`** ([packages/mcp/README.md](packages/mcp/README.md)), `npm run mcp`. A stdio MCP
  server with four read-only tools: `keyhole_inspect`, `keyhole_pending`, `keyhole_check_call` (what
  `guardCall` would decide, without executing) and `keyhole_verify_hatch` (offline). No tool takes a
  key, signs or sends a transaction. The chain can change between a check and a transaction, so send
  the call itself through `guardCall`.

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

Guardian, on top of the same core:

```
  Sputnik DAO proposals ──┐   near-plugins staged code ──┐   live code hash (fallback)
  (UpgradeRemote/Self,    │   (up_staged_code_hash)      │
   FunctionCall upgrade)  ▼                              ▼
             guardian radar ── new / changed upgrade ──► assess
                                                          │ bytes: DAO's store_blob tx (FastNEAR tx index) or up_staged_code,
                                                          │        kept only if sha256 == proposal hash
                                                          │ diff vs live wasm: new methods, privileged host calls
                                                          │ verified? SourceScan · registry ReproducibleBuild · NEP-330 the bytes declare
                                                          │ optional: private TEE review of the diff → registry AiReview
                                                          ▼
                                          gradeUpgrade() → OK / CAUTION / STOP
                                                          │ STOP + an ARMED hatch for that contract
                                                          ▼
                       relayer submits the depositor's pre-signed NEP-366 withdraw-to-self
```

Grading rules: [docs/GRADING.md](docs/GRADING.md). Design: [docs/DESIGN.md](docs/DESIGN.md),
[docs/GUARDIAN_DESIGN.md](docs/GUARDIAN_DESIGN.md).

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
| **Sputnik `store_blob` + `UpgradeRemote`/`UpgradeSelf`** | An upgrade proposal names the code hash, and the code itself is the argument of a `store_blob` transaction to the DAO, which must be on chain before the proposal executes. When the FastNEAR tx index has that transaction, Keyhole can read those bytes before the proposal executes and checks `sha256 == hash`. In the upgrade eval it found a DAO `store_blob` for 16 of 130 real proposals (Ref and SWEAT); `FunctionCall` upgrades of near-plugins contracts use code staged on the target instead, and a release registration (`add_release_info`) carries only a hash. |
| **Sputnik execution on the threshold vote** | `act_proposal` executes in the call that reaches the threshold; `proposal_period` is an expiry. That is why the window is "until the deciding vote", and why it can be minutes. |
| **near-plugins `Upgradable`** | `up_staged_code_hash` / `up_staged_code` expose staged code before `up_deploy_code`; `up_get_delay_status` shows whether any staging delay is enforced. |
| **NEP-366 meta-transactions (`SignedDelegateAction`)** | The escape hatch: a depositor signs one withdraw-to-self now; anyone can relay it later, and the signature covers every field. Signed by a dedicated full-access key because a function-call key cannot attach the 1 yoctoNEAR most withdraws demand. |
| **Access-key nonces and `max_block_height`** | One key, one hatch: the nonce makes it single-use, the expiry bounds it, and `view_access_key` tells anyone whether it is still ARMED. |
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
- **Upgrade eval** ([docs/EVAL_UPGRADES.md](docs/EVAL_UPGRADES.md), `npm run eval:upgrades`, data in
  `eval/upgrades.json`): 130 real mainnet upgrade proposals with a code hash, up to the latest 30 of
  each of 5 DAOs (Ref, Burrow, Intents, the Omni bridge, SWEAT).
  - **Windows.** 101 executed proposals have a measured window from submission to the block where
    the target's code changed (archival bisection): shortest 2.4 min, median 90.0 min, longest
    144.0 h; 12 executed in under 10 minutes. 19 more are release registrations
    (`add_release_info`), which change no code and are not timed.
  - **False alarms.** 101 real upgrades could be graded (old and new bytes both retrievable); 23 of
    them grade STOP and would have fired a `stop` hatch. No known incident is attached to these
    upgrades, so every STOP is counted as a false alarm; that is an assumption, not a proof that the
    upgrades were safe. All 23 STOPs were on code without a verified build (each carries
    `UNVERIFIED_PENDING_CODE`; the eval checks SourceScan and runs no AI review). Under
    `gradeUpgrade`, a reproducible build or SourceScan verification of the new hash would have made
    each of them CAUTION.
  - **Seeded attacks.** 4 of 6 graded as expected. The two misses are `evil-owner` (a new
    `set_owner` that only writes state; the danger, taking ownership and then calling `upgrade`, is
    one hop away) and `evil-fee` (`withdraw_all` keeps half): logic changes that add no host-call
    path, so the structural diff cannot see them. Both grade CAUTION, not STOP.
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
  - The AI review counts by fixed rules ([GRADING.md](docs/GRADING.md)). For a pending upgrade, a
    high-risk AI review alone is enough for STOP, which fires `stop` hatches; an AI review never
    lowers an upgrade verdict. For a contract's own grade, a low-risk attested review keeps a fresh
    unverified change at CAUTION instead of STOP.
  - A hatch fixes the call (receiver, method, args, deposit), not the outcome: the venue's code at
    the moment the call runs decides where the funds go. The guardian in this build also fires on
    STOP for code that already landed (an executed proposal or a changed live hash); such a hatch runs
    the new code. See [HATCH.md](docs/HATCH.md).
  - The upgrade diff sees native NEAR transfers, not token transfers: a new method that sends
    fungible tokens out with `ft_transfer` (how Ref and Burrow deposits move) is not a new money
    path to it. For such venues the verdict rests on verification (unverified code is at least
    CAUTION) and the AI review.

## Repository

```
packages/core   inspect(), wasm analysis, controller resolution, grade(), decodeTransactions(), CLI
packages/core   + pending.ts (upgrade proposals, staged code, store_blob bytes), upgrade.ts (gradeUpgrade), wasmview.ts
packages/hatch  escape hatches: NEP-366 delegate (dedicated key) and function-call-key modes; verify, health, fire, deposit probe
packages/guard  guardCall(): agents refuse STOP in code (live code and pending upgrades); CAUTION asks a human or fails closed; testnet auto-hatch
packages/mcp    read-only MCP server: keyhole_inspect, keyhole_pending, keyhole_check_call, keyhole_verify_hatch
guardian/       radar (proposals, staged code, live hash) → assess (bytes, diff, verification, TEE review) → fire
contracts/      registry (Rust, near-sdk 5), demo vaults v1/v2, guarded vault (+ seeded upgrades), reproducible builds
watcher/        neardata follower (tx + Delegate + receipts) → registry + public feed branch
verifier/       rebuild deployed contracts from NEP-330 build_info (GitHub Actions)
reviewer/       NEAR AI Cloud TEE review, receipts, offline verification, seeded eval
web/            static site (Vite, vanilla TS), Playwright smoke at 360/768/1366 light/dark
scripts/        factcheck, survey, demo:attack, demo:guardian, setup:guardian, hatch:live, eval:upgrades, radar, judge, eval
```

| command | what it does |
|---|---|
| `npm test` | unit tests, offline (recorded RPC fixtures) |
| `npm run judge` | the zero-key checks above |
| `npm run survey` | regenerate `docs/STATE_OF_NEAR.md` and the website's trust table |
| `npm run eval` / `npm run eval:review` | the two evals (`eval:review` needs NEAR AI Cloud access) |
| `npm run demo:guardian [-- --replay]` | the Guardian run on testnet, or its keyless re-check |
| `npm run guardian -- run --network mainnet --watch <contracts>` | watch contracts' DAOs and staged code; alert-only without `--relayer` |
| `npm run eval:upgrades` | real mainnet upgrade proposals: windows, bytes, grades ([docs/EVAL_UPGRADES.md](docs/EVAL_UPGRADES.md)) |
| `npm run radar` | refresh the website's upgrade-radar snapshot |
| `npm run mcp` | start the read-only MCP server on stdio ([packages/mcp/README.md](packages/mcp/README.md)) |
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
- **Guardian as a service.** Alerts per contract you hold, hatches armed from a wallet, a hosted
  relayer, and protocols pre-registering verified builds so routine upgrades don't trigger exits.
- **DAO tooling.** A "review this upgrade proposal" step for Trezu and NEAR Business, and a
  clear-signing descriptor NEP for NEAR methods. Proposal X-Ray already decodes proposals, flags
  upgrade proposals, and checks `UpgradeSelf` hashes against the releases `sputnik-dao.near` publishes;
  Keyhole adds fetching the proposed bytes and checking `sha256(bytes) == hash`, the export and
  call-graph diff against the live code, SourceScan and reproducible-build checks for any target
  (including `UpgradeRemote` targets), and the TEE review receipt.
- **Other chains.** The wasm analysis generalises to CosmWasm and Stylus.

## Other project by the same builder

[Standing Order](https://github.com/unajijacob6-create/standing-order): recurring payroll and
scheduled payouts for Sputnik DAO treasuries.

## License

MIT
