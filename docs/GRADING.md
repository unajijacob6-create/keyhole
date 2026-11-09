# How Keyhole grades a contract

The grade is a pure function, `grade()` in `packages/core/src/grade.ts`, unit-tested in
`packages/core/test/grade.test.ts`. It runs on signals collected from public RPC by `inspect()`.
**AI never sets the grade.** An attested AI review is one input among others, and it is applied
after the deterministic facts. Every reason carries the request that re-checks it (`--evidence` in
the CLI, "Re-check" in the UI).

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
- The AI review is evidence, not a guarantee.
