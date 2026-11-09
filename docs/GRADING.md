# How Keyhole grades a contract

The grade is a pure function, `grade()` in `packages/core/src/grade.ts`, unit-tested in
`packages/core/test/grade.test.ts`. It runs on signals collected from public RPC by `inspect()`.
An attested AI review is one input among others, applied after the deterministic facts, and the
rules below say exactly where it counts. For a contract (section 4) it can make a fresh change STOP
(high risk) or keep a fresh unverified change at CAUTION instead of STOP (low risk). For a pending
upgrade (section 7) a high-risk review alone is enough for STOP, which fires `stop` hatches, and no
review lowers the verdict. Every reason carries the request that re-checks it (`--evidence` in the
CLI, "Re-check" in the UI).

Keyhole describes trust assumptions. It does not accuse anyone, and it is not a security audit.

## 1. Who can change the code? (control class)

Keyhole lists every **path** by which the code running on the account can be replaced:

| path | when it exists | who controls it |
|---|---|---|
| `full-access-key` | the account has ≥ 1 full-access key | each key alone: **single-key** |
| `contract-method` | the wasm imports a code-change host function: `promise_batch_action_deploy_contract`, `…use_global_contract[_by_account_id]`, or `…add_key_with_full_access` (a contract that can add itself a key can then deploy) | the owner Keyhole infers (below) |
| `global-contract-publisher` | the account runs a global contract referenced **by account id** (NEP-591) | the publisher account: its redeploy changes this account's code |

Each path is labelled `single-key`, `governed` (≥ 2 independent approvals), `unresolved`, or
`blocked`. The class is the **weakest link**:

| class | rule |
|---|---|
| **IMMUTABLE** | no live path: no full-access keys, no code-change host function imported, not global-by-account. This is a proof for the code as deployed. |
| **CUSTODIAL** | at least one path is `single-key` |
| **UNRESOLVED** | no single-key path, but at least one path whose controller Keyhole could not determine |
| **GOVERNED** | every path needs ≥ 2 approvals (e.g. a Sputnik DAO needing 3 of 5, a 2-of-3 multisig) |
| **NO_CODE** | the account has no contract code |

Notes:
- Function-call access keys cannot deploy code, so they are not paths.
- An imported deploy host function is necessary but not sufficient. near-sdk's `Promise` links
  every action host function into the wasm, even in contracts that never deploy (e.g. `wrap.near`).
  When Keyhole finds no method that uses it, the path stays `unresolved`, because immutability cannot
  be proven. It is never shown as single-key.
- **Call paths.** Keyhole builds the wasm call graph (direct calls, plus `call_indirect` to any
  table function with a matching signature) and reports methods with a *specific* path to a
  code-change host function (e.g. only `upgrade` on `usdt.tether-token.near`). Paths that only go
  through near-sdk's shared action dispatcher are reported separately as "via dispatcher".

### Owner inference (always labelled "inferred")
In order:
1. **near-plugins ACL.** `acl_get_super_admins` are certain controllers, because a super admin
   can grant itself any role. For deployer roles, Keyhole uses this order:
   - It reads `code_deployers(Role::…)` from the contract's NEP-330 source at the declared rev. These
     roles are certain only when the code is verified (SourceScan or a matching reproducible build).
   - Otherwise it uses known role names (`UpgradableCodeDeployer`, `Upgrader`, `CodeDeployer`,
     `UpgradeManager`), which are certain.
   - Other names that suggest deploying (e.g. `TokenDeployer`) are uncertain.
2. **Owner views the contract exports:** `get_owner`, `owner`, `owner_get`, `get_owner_id`, … If
   ACL is also present, an Ownable owner is uncertain, because whether it can upgrade depends on the
   ACL configuration.
3. **Owner fields** inside `get_config`, `get_metadata`, `get_contract_state`, … (`owner_id`,
   `admin`, `governance`, `dao`, …).

Each owner candidate is then resolved one level deep:
- **Full-access keys** → `single-key`.
- **Sputnik DAO** (`get_policy`) → the smallest number of approvals any role needs for `call`,
  `upgrade_remote`, `upgrade_self` or `policy` proposals. This uses Sputnik v2's own arithmetic:
  `Ratio(n,d)` → `min(total·n/d + 1, total)`, `Weight(w)` → `min(w, total)`, then the maximum of
  that and the quorum. Votes cast under the `Everyone` role are not counted, because Sputnik skips
  that role when it tallies.
- **Multisig** (`get_num_confirmations`) → that threshold.
- **near-plugins contract** → its super admins.
- **Anything else** → `unresolved`.

The control rule:
- Any **certain** single-key candidate makes the path `single-key`.
- An **uncertain** single-key candidate can only make it `unresolved`.
- An owner account that does not exist makes it `unresolved`.

## 2. Is it the reviewed code? (flags)

| flag | meaning |
|---|---|
| `UNVERIFIED_CODE` | the current code hash has no SourceScan entry and no matching `ReproducibleBuild` attestation in the Keyhole registry |
| `STALE_VERIFICATION` | SourceScan verified this account, but at a different code hash |
| `NO_SOURCE_METADATA` | no NEP-330 `contract_source_metadata` |
| `NO_BUILD_INFO` | NEP-330 present, but no `build_info`, so the build cannot be reproduced from it |
| `SOURCE_REPO_UNREACHABLE` | the declared GitHub repository returns 404 (rate limits and blocks count as "unknown", not unreachable) |
| `GLOBAL_BY_ACCOUNT` | runs a global contract referenced by account id |
| `AI_REVIEW_RISK` | an attested AI review of this code hash reports medium or high risk |

"Verified" means either of these:
- SourceScan has verified source for this exact code hash.
- A `ReproducibleBuild` attestation for this exact hash has `matches: true`. These come from a
  public CI rebuild of the declared source; see `docs/SECURITY.md`.

## 3. What changed?

| flag | meaning |
|---|---|
| `CHANGED_24H` | the code changed less than 24 h ago. Sources: an archival-RPC search for the block where the current hash first appears (re-check with `view_account` at that height and the one before), or a `ChangeObserved` attestation by the Keyhole watcher |
| `FULL_ACCESS_KEY_ADDED_24H` | a `KeyAdded` attestation (full-access key) from the last 24 h |

## 4. Verdict for signers

| verdict | rule |
|---|---|
| **STOP** `[XX]` | any of the following: (a) the code changed in the last 24 h **and** the new code is not verified **and** no low-risk AI review exists for it; (b) a full-access key was added in the last 24 h; (c) an attested AI review reports **high** risk **and** the code changed in the last 24 h |
| **OK** `[OK]` | class IMMUTABLE or GOVERNED, **and** the current code is verified, **and** no change in the last 24 h, **and** no high-risk AI review |
| **CAUTION** `[!!]` | everything else. CAUTION is not an accusation: it means the signer is trusting something they cannot check from the chain alone. |

A verdict is always shown as glyph plus word, never by colour alone.

## 5. Agents (`@keyhole/guard`)

| verdict | what `guardCall` does |
|---|---|
| STOP | throws `GuardRefusal` before anything is signed |
| CAUTION | asks a human (`policy.ask`), or follows `policy.onCaution`. The default is `"deny"`, so it fails closed |
| OK | executes |

`policy.expectCodeHash` pins the code the agent was configured against. Any other hash is refused,
even when the grade is OK.

## 6. Known limits

These are also listed in `docs/SECURITY.md`:
- Owner inference is heuristic.
- An imported deploy host function is not proof that the contract can upgrade.
- Wasm analysis cannot see business logic.
- The archival search can miss an A → B → A change.
- The AI review is evidence, not a guarantee, yet the rules above let a high-risk review raise a
  verdict (alone, for a pending upgrade) and a low-risk review keep a fresh contract change at CAUTION.

## 7. Upgrade grading (pending upgrades)

`gradeUpgrade()` in `packages/core/src/upgrade.ts` grades a code change *before* it lands: the code
a DAO proposal or a near-plugins staging would deploy, against the code running now. It is a pure
function, unit-tested in `packages/core/test/upgrade.test.ts`; `keyhole pending <dao-or-contract>
--fetch-code` runs it on live data. The verdict decides what a hatch with the default "strict"
trigger does: `fire` is true exactly when the verdict is STOP.

### Where the pending code comes from

| source | how Keyhole reads the hash | how it gets the bytes |
|---|---|---|
| Sputnik `UpgradeRemote` / `UpgradeSelf` | the proposal's `hash` field | the DAO's `store_blob` transaction: its args are the wasm |
| Sputnik `FunctionCall` to an upgrade method (`upgrade`, `up_deploy_code`, `up_stage_code`, `deploy`, `deploy_code`, `update_contract`, `unrestricted_upgrade`, `add_release_info`, `stage_code`, `set_code`, `upgrade_contract`; whole-name match, so `deploy_token` does not count) | a top-level `hash` / `code_hash` / `codeHash` / `new_code_hash` arg in base58, hex, a 32-byte array or padded base64; or, if the args are wasm (`\0asm`, raw or as a borsh `Vec<u8>`), sha256 of that wasm | the target's staged code (`up_staged_code`), or a stage call / `store_blob` on the DAO or the target |
| near-plugins `up_staged_code_hash` (base58 string, or a raw 32-byte array from older plugin versions) | that view | `up_staged_code` (a borsh `Option<Vec<u8>>`, not JSON: near-plugins declares it `#[result_serializer(borsh)]`) |

Bytes are found through the FastNEAR transactions API (`/v0/account`, newest first, at most 20
pages; `/v0/transactions`, at most 20 hashes per request). Keyhole accepts them **only if
sha256(bytes) equals the proposed hash**, so the API is not trusted for content. Staged code equal
to the live code means nothing is pending (near-plugins keeps the staged code after deploying).
near-plugins `staging_timestamp` is the earliest time `up_deploy_code` accepts the staged code
(`up_stage_code` sets it to the block time plus `staging_duration`), so `keyhole pending` shows it
as "deployable from / since", not as the time the code was staged.

A proposal's state is `pending` while Sputnik status is `InProgress` and `submission_time +
proposal_period` has not passed; after that it is `expired` (Sputnik's own rule; it uses the current
policy's period). `Approved` → `executed`; `Rejected`, `Removed`, `Expired`, `Moved`, `Failed` map
to their lower-case names. `required` is the number of approvals the DAO's policy needs for the
proposal kind's label (`upgrade_remote`, `upgrade_self`, `call`), computed as in section 1.

`failed` is not necessarily over. In sputnikdao2 v3 (commit `3d568f9`, which `sputnik-dao.near`
`get_contracts_metadata` lists as version 3.1, the code of `ref-finance.sputnik-dao.near`),
`Action::Finalize` recomputes the status of a `Failed` proposal and re-executes it if its approvals
still stand and its period has not passed; one call by any role with Finalize permission does it.
v2.0 (commit `c2cf155`, the code of `rainbowbridge.sputnik-dao.near`) only lets Finalize expire a
proposal. `isLive(p, now)` (pending, or failed inside the period) is what `--fetch-code` picks
first and what a watcher should treat as an open upgrade; it does not check the DAO's version.

### Flags

The diff is `exportDiff(live, pending)` plus the call graph of each side (section 1, "Call paths").
"Specific path" means a call path that avoids near-sdk's shared action dispatcher.

| flag | rule |
|---|---|
| `NO_CHANGE` | the pending hash equals the live hash |
| `UNVERIFIED_PENDING_CODE` | no `ReproducibleBuild` attestation with `matches: true` and no SourceScan verification for the pending hash (or the hash is unknown) |
| `PENDING_CODE_UNAVAILABLE` | the pending bytes could not be fetched and checked |
| `NEW_CODE_CHANGE_PATH` | the pending code adds the `deploy_contract`, `use_global_contract`, `add_full_access_key` or `delete_account` capability (import level), or an exported method gains a specific path to one of them |
| `NEW_KEY_PATH` | the same for `add_function_call_key` / `delete_key` |
| `NEW_MONEY_PATH` | an added method, or an existing method that had none, has a specific path to `transfer` (the `Transfer` or `TransferToGasKey` action: native NEAR leaving the account) |
| `EXIT_METHOD_REMOVED` | a removed export reached `transfer` in the live code (specific path or via the dispatcher; if the live call graph is unavailable, any removed export of code that imports `transfer`, marked "assumed") |
| `AI_REVIEW_HIGH` | an AI review of the pending code reports high risk (passed in, or a registry `AiReview` whose summary starts with `high:`) |

If the call graph of the pending code is unavailable, added methods are assumed to reach every
capability the pending code imports (the reason says "assumed"). If there is no analysis of the live
code, the pending code is compared with an empty contract, so every capability counts as new.

### Verdict

| verdict | rule |
|---|---|
| **STOP** `[XX]` | `UNVERIFIED_PENDING_CODE` **and** at least one of `NEW_CODE_CHANGE_PATH`, `NEW_MONEY_PATH`, `EXIT_METHOD_REMOVED`, `NEW_KEY_PATH`; **or** `AI_REVIEW_HIGH` |
| **CAUTION** `[!!]` | not STOP, and any flag other than `NO_CHANGE` (in particular unverified code, or code that could not be read) |
| **OK** `[OK]` | otherwise: verified code with no new path and no removed exit, or `NO_CHANGE` |

Notes:
- "Money" here means native NEAR. Fungible-token balances (for example Ref and Burrow deposits) move
  with cross-contract calls such as `ft_transfer`, i.e. the `function_call` capability, which no flag
  covers: a new method that calls `ft_transfer` to an attacker is not `NEW_MONEY_PATH`, and removing
  an FT `withdraw` is not `EXIT_METHOD_REMOVED`. For such venues the verdict rests on verification
  (unverified code is at least CAUTION) and the AI review.
- Unverified code is never OK (except `NO_CHANGE`: the proposed code is the code already running).
  The diff only sees exports and host-call reachability; a change inside
  an existing method (for example a `withdraw` that sends half) is invisible to it.
- Verified code that adds a money or code-change path is CAUTION, not OK: a reviewed source can
  still add a power the depositor did not sign up for.
- A high-risk AI review alone makes the verdict STOP, even when the diff shows nothing new and even
  for `NO_CHANGE` (the code already running), and `fire` follows the verdict. A medium-risk review is
  shown as a caution reason but sets no flag and does not change the verdict. In upgrade grading an AI
  review never lowers a verdict.
- For an *executed* proposal whose code is already live, `keyhole pending --fetch-code` grades it
  retrospectively against the code it replaced (found by the archival search of section 3). A
  *pending* proposal for the code already live is `NO_CHANGE`. An executed proposal whose code is no
  longer live is graded against the current code (what deploying it again would change), and the
  output says so.
- Not graded: what an upgrade call does besides deploying. near-plugins `up_deploy_code(hash,
  function_call_args)` deploys and then calls any method of the contract in the same batch, as the
  contract itself; Sputnik `UpgradeRemote` passes the blob to whatever `method_name` names. Only the
  code hash and the code are compared.

Worked examples (from the unit tests, on wasm committed in this repo):

| live → pending | verified | flags | verdict |
|---|---|---|---|
| `contracts/repro/demo_vault_v1.wasm` → `demo_vault_v2.wasm` (adds `sweep`, which reaches transfer) | no | `UNVERIFIED_PENDING_CODE`, `NEW_MONEY_PATH` | STOP |
| same | reproducible build | `NEW_MONEY_PATH` | CAUTION |
| `contracts/out/demo_vault_v1.wasm` → `contracts/repro/demo_vault_v1.wasm` (two builds of one source; different hashes, empty diff) | reproducible build | none | OK |
| same | no | `UNVERIFIED_PENDING_CODE` | CAUTION |
| `demo_vault_v1.wasm` → `contracts/fixtures/out/fixture_upgradable.wasm` | no | `UNVERIFIED_PENDING_CODE`, `NEW_CODE_CHANGE_PATH`, `EXIT_METHOD_REMOVED` | STOP |
