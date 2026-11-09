# Keyhole contracts

Four NEAR crates (Rust, near-sdk 5.30), in one cargo workspace:

| Crate | Wasm (`out/`) | What it is |
|---|---|---|
| `registry` (`keyhole-registry`) | `registry.wasm` | The Keyhole registry: attestations about contract code, keyed by code hash |
| `demo-vault-v1` | `demo_vault_v1.wasm` | An honest, minimal NEAR vault for the testnet "silent upgrade" demo |
| `demo-vault-v2` | `demo_vault_v2.wasm` | **Deliberately malicious.** The v1 redeploy that lets the owner drain the vault. Testnet demos only |
| `guarded-vault` | `guarded_vault.wasm` + 5 variants | A DAO-owned vault with an `upgrade` path, built as an honest default plus seeded honest/evil variants for Keyhole Guardian. Testnet only |

The guarded vault builds one wasm per cargo feature (see [Guarded vault](#guarded-vault-guarded-vault) below):
`guarded_vault.wasm` (honest), `guarded_vault_benign_v2.wasm`, `guarded_vault_evil_sweep.wasm`,
`guarded_vault_evil_addkey.wasm`, `guarded_vault_evil_owner.wasm`, `guarded_vault_evil_fee.wasm`.

`out/` holds the wasm that `test.sh` built and tested. It is kept in git so the demo scripts can deploy it without a Rust toolchain.

## Build and test

```bash
bash contracts/test.sh
```

The script:

1. builds each crate with `cargo near build non-reproducible-wasm --locked` (cargo-near 0.23.0; it runs `wasm-opt`, embeds the ABI and the NEP-330 metadata) and copies the result to `out/`. The guarded vault is built once per variant (`--no-default-features [--features <f>]`) into its six named wasm;
2. inspects each wasm in node, and fails if `contract_source_metadata` is missing. For the registry and demo vaults it also fails on any import of a host function that deploys or switches code (`promise_batch_action_deploy_contract`, `*_deploy_global_contract*`, `*_use_global_contract*`). The guarded-vault wasm legitimately import the deploy host call (their `upgrade` deploys), so for those the check instead decodes the code section, builds the call graph, and asserts that `upgrade` is the **only** export that can reach the deploy host call, that no export reaches any other code-changing import, and that `upgrade` is exported and deploy is imported. The analyzer is `wasm-reach.cjs` (plain node, no npm install; its tests in `wasm-reach.test.cjs` run first with `node --test`). It computes reachability as the backward closure from the import, treats a `call_indirect` as a possible call to every table / `ref.func` function of the same signature, reports a `start` function as `(start)`, and throws on any opcode, valtype or section encoding it does not understand. Those choices only ever add paths, so a "nothing else reaches deploy" answer holds for the code as built;
3. runs the unit tests (`cargo test --workspace --lib`), then the guarded-vault variant unit tests (one `--features` build each);
4. runs the near-workspaces sandbox tests (`registry/tests/sandbox.rs`, `demo-vault-v2/tests/silent_upgrade.rs`, `guarded-vault/tests/upgrade.rs`).

It exits non-zero on any failure. Requirements: Rust 1.97 with `wasm32-unknown-unknown` (pinned in `rust-toolchain.toml`), cargo-near, node, and a C compiler for the shim below.

The sandbox node (`neard`) wants to raise `RLIMIT_NOFILE` to 65535. Containers with a lower hard limit (this one: 20000) make it abort, so `test.sh` builds `sandbox-rlimit-shim.c` into `target/librlimit_shim.so` and loads it with `LD_PRELOAD`. The shim clamps that one request to the hard limit. It is used for tests only and never touches the contracts.

### NEP-330 `contract_source_metadata`

near-sdk's `#[near(contract_state)]` generates `contract_source_metadata` in every build, from `CARGO_PKG_VERSION` and `CARGO_PKG_REPOSITORY` (or `NEP330_VERSION` / `NEP330_LINK`). A plain `cargo build --target wasm32-unknown-unknown --release` has it too, but has no embedded ABI and skips the `wasm-opt` pass that cargo-near says rustc ≥ 1.82 output needs on nearcore. Use cargo-near.

Called in the sandbox, the `test.sh` builds return:

```json
registry: {"version":"1.0.0","link":"https://github.com/unajijacob6-create/keyhole","standards":[{"standard":"keyhole","version":"1.0.0"},{"standard":"nep330","version":"1.3.0"}],"build_info":null}
vault v1: {"version":"1.0.0","link":"https://github.com/unajijacob6-create/keyhole","standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":null}
```

`build_info` is `null` for `non-reproducible-wasm` builds. Only `cargo near build reproducible-wasm` fills it (build environment, command, source snapshot `git+…?rev=…`, contract path). That is the build to deploy when the code should be verifiable.

### Reproducible builds

Each crate's `Cargo.toml` has `[package.metadata.near.reproducible_build]`:

```toml
image = "sourcescan/cargo-near:0.23.0-rust-1.99.1"
image_digest = "sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc"
container_build_command = ["cargo", "near", "build", "non-reproducible-wasm", "--locked"]
```

The image runs the same cargo-near (0.23.0) as the local build. The digest was checked against the registry manifest (`docker buildx imagetools inspect`). The cargo-near 0.23.0 project template still defaults to `0.22.0-rust-1.99.1`. The 0.23.0 image was the newest tag on Docker Hub when chosen (published 2026-11-06). The container's Rust (1.99.1) is newer than the local pin (1.97.0). That is fine because the reproducible build depends only on the image. Run it from a clean, committed git tree:

```bash
cargo near build reproducible-wasm --manifest-path contracts/registry/Cargo.toml
```

## Registry (`registry/`)

Attestations about a code hash: the base58 `code_hash` that NEAR RPC `view_account` returns. The registry stores only hashes and short summaries, never source code.

### Attestation kinds

JSON is internally tagged by `kind`:

```jsonc
{"kind": "ChangeObserved",    "account": "vault.testnet", "old_hash": "<base58>", "new_hash": "<base58>", "block_height": 123}
{"kind": "KeyAdded",          "account": "vault.testnet", "public_key": "ed25519:…", "block_height": 123}
{"kind": "ReproducibleBuild", "account": "vault.testnet" /* or null */, "repo": "https://…", "rev": "<git rev>", "image_digest": "sha256:…", "matches": true}
{"kind": "AiReview",          "model": "…", "request_sha256": "<64 hex>", "response_sha256": "<64 hex>", "signer": "…", "chat_id": "…", "verdict_summary": "…"}
```

A stored record is `{id, code_hash, attestation, attester, block_height, timestamp_ms}`. `block_height` and `timestamp_ms` record when the registry stored it. Ids start at 1. All numbers are JSON numbers; ids, heights and millisecond timestamps stay below 2^53.

Validation (the call panics otherwise):
- `code_hash`, `old_hash` and `new_hash` must be base58 that decodes to exactly 32 bytes: 43–44 characters, or `11111111111111111111111111111111` (32 ones) for an account with no code.
- `ChangeObserved`: `code_hash == new_hash` and `old_hash != new_hash`.
- `KeyAdded`: `code_hash` is the account's code hash at that time. `public_key` must be 1–100 bytes and parse as a NEAR public key.
- `request_sha256` and `response_sha256` must be 64 lowercase hex characters.
- `repo`, `rev`, `image_digest`, `model`, `signer` and `chat_id` must be 1–200 bytes. `verdict_summary` must be 1–280 bytes.

### Methods

| Method | Who | Notes |
|---|---|---|
| `new(owner_id)` | init | |
| `add_attester(account_id) -> bool` | owner | false if already an attester |
| `remove_attester(account_id) -> bool` | owner | false if not an attester |
| `set_owner(new_owner_id)` | owner | |
| `attest(code_hash, attestation) -> u64` | attesters | returns the record id. The owner is not implicitly an attester |
| `get_attestations(code_hash, from_index?, limit?) -> Record[]` | view | all kinds for that hash, oldest first |
| `get_history(account_id, from_index?, limit?) -> Record[]` | view | `ChangeObserved` for the account, oldest first |
| `get_key_events(account_id, from_index?, limit?) -> Record[]` | view | `KeyAdded` for the account, oldest first |
| `get_latest(account_id) -> Record \| null` | view | latest `ChangeObserved` for the account |
| `get_attestation(id) -> Record \| null` | view | |
| `get_attesters() -> AccountId[]`, `is_attester(account_id) -> bool`, `get_owner() -> AccountId` | view | |
| `get_stats() -> {attestations, accounts}` | view | `accounts` counts distinct accounts with `ChangeObserved` or `KeyAdded` records |
| `contract_source_metadata()` | view | NEP-330 |

Pages default to 50 records and are capped at 100.

### Events (NEP-297)

Each state change logs one event with `standard` set to `keyhole` and `version` set to `1.0.0`:

```text
EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"attestation","data":[{"id":2,"code_hash":"…","kind":"ChangeObserved","attester":"bot.testnet","timestamp_ms":…,"account":"vault.testnet","old_hash":"…","new_hash":"…","block_height":123}]}
EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"attester_added","data":[{"account_id":"bot.testnet","by":"owner.testnet"}]}
EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"attester_removed","data":[{"account_id":"bot.testnet","by":"owner.testnet"}]}
EVENT_JSON:{"standard":"keyhole","version":"1.0.0","event":"owner_changed","data":[{"old_owner_id":"a.testnet","new_owner_id":"b.testnet"}]}
```

In the `attestation` event the payload fields sit next to `id`, `code_hash`, `kind`, `attester` and `timestamp_ms`. `block_height` there is the payload's: where the change or key was observed. JSON key order is not guaranteed.

### Storage model

The registry pays for storage from its own balance. Attesters are trusted, attach no deposit, and can use a function-call access key. Each record is stored once, by id. `by_hash`, `history` and `key_events` hold only lists of ids, and `latest` holds one id per account. Each list lives under its own storage prefix (the sha256 of its key), so appending writes one small entry. In the sandbox test, five attestations covering all four kinds used 3,042 bytes, about 600 bytes each, or roughly 0.006 NEAR each at 1 NEAR per 100 KB. The code itself takes about 219 KB (about 2.2 NEAR). Keep the account funded: once its balance cannot cover storage, `attest` fails.

The registry is append-only. No method edits or deletes a record. Removing an attester stops new attestations from that account but keeps its old ones.

### No upgrade by design

The registry deliberately has **no `upgrade` or `migrate` method and no code-deploy capability**. It imports none of `promise_batch_action_deploy_contract`, `*_deploy_global_contract*` or `*_use_global_contract*`, and `test.sh` checks this. Keyhole grades the registry the same way it grades any contract. After deployment and init, delete every full-access key on the registry account. The code can then never change, and Keyhole's own check of the account shows nobody who can change it. To ship a new version, deploy a new registry to a new account and point clients at it.

## Demo vault v1 (`demo-vault-v1/`)

A minimal, honest vault. State: `owner_id`, `balances: LookupMap<AccountId, u128>`, `total: u128`.

- `new(owner_id)`: init.
- `deposit()` (payable): credits the attached deposit to the caller and returns the new balance.
- `withdraw(amount: U128)`: sends `amount` back to the caller. It fails above the caller's balance. A private `on_withdraw` callback restores the balance if the transfer fails.
- `get_balance(account_id) -> U128`, `get_total() -> U128`, `get_owner() -> AccountId`, `version() -> "1.0.0"`.

The vault has no upgrade method and imports no deploy host function. It sends NEAR with the low-level `env::promise_batch_*` calls. near-sdk's high-level `Promise` type links every action host function into the wasm, including `promise_batch_action_deploy_contract`, even when the contract never deploys. So it would look as if the contract can replace its own code.

The demo's point: the code cannot change itself, but the owner keeps a full-access key on the vault account and can redeploy anything at any time.

## Demo vault v2 (`demo-vault-v2/`): deliberately malicious

**This contract is intentionally malicious, for testnet demos only. Never deploy it where real funds live.**

It has exactly the v1 state layout, so a redeploy over v1 reads v1's state with no migration. It adds:

- `sweep(to: AccountId)` (owner only): sends the whole recorded `total` to `to` and sets `total` to 0. The per-account balances stay as they were, but nothing backs them any more, so later withdrawals fail with "Vault is empty".
- `version() -> "2.0.0"`.

`demo-vault-v2/tests/silent_upgrade.rs` plays the demo end to end in the sandbox. It deploys v1, takes deposits from two users and runs a v1 withdraw. It then redeploys v2 with the vault account's own full-access key, checks that the code hash changed and the state carried over, and has the owner sweep about 7 NEAR. Keyhole should catch this: a `ChangeObserved` attestation with v1's hash as `old_hash` and v2's as `new_hash`.

## Guarded vault (`guarded-vault/`)

**The evil variants are intentionally malicious, for testnet demos only. Never deploy them where real funds live.**

A DAO-owned vault that mirrors how a real DeFi venue (Ref, Burrow) looks to a depositor, and that
Keyhole Guardian watches for upgrades. State is the v1 layout: `owner_id` (the DAO), `balances:
LookupMap<AccountId, u128>` (prefix `b"b"`), `total: u128`.

Methods:

- `new(owner_id)`: init.
- `deposit()` (payable): credits the attached deposit to the caller; returns the new balance.
- `withdraw_all()` (payable): requires exactly 1 yoctoNEAR (`near_sdk::assert_one_yocto`), sends the
  caller's whole balance back to `predecessor_account_id`, clears the record, and returns the amount.
  A private `on_withdraw` callback restores the full recorded balance if the transfer fails (the
  transfer runs in a later receipt, so the returned amount is what it tried to send). The
  1-yoctoNEAR gate is the standard full-access-key check: a function-call access key cannot attach a
  deposit, so only a full-access signature — or a relayed NEP-366 delegate action the user signed with
  a full-access key — can call it. Under a relayed delegate action `predecessor_account_id` is the
  user (the delegate's sender), so funds return to the user, not the relayer.
- `get_balance(account_id) -> U128`, `get_total() -> U128`, `get_owner() -> AccountId`, `version() -> String`.
- `upgrade()`: owner only (`predecessor == owner_id`). Reads the new wasm from the call's **raw**
  `env::input()` bytes (not JSON) and deploys it to the current account with `env::promise_batch_create`
  + `env::promise_batch_action_deploy_contract`. No migration (the state layout is fixed). This is the
  one method that imports the deploy host call. It takes no parameters, so the near-sdk `#[near]`
  wrapper does not deserialize input and leaves the raw wasm in `env::input()` for us. This is exactly
  what a Sputnik `UpgradeRemote` function call delivers: the stored blob as raw input.

### Seeded variants (cargo features)

Each feature produces a separate wasm with the **same state layout**, so it can be deployed over the
honest v1 by `upgrade` and read v1 state with no migration. The features are **mutually exclusive**:
enabling two makes the build fail with a `compile_error!`. The honest default is v1.

| Build (`--features`) | Wasm | `version` | Added surface | What it models |
|---|---|---|---|---|
| default | `guarded_vault.wasm` | `1.0.0` | — | the honest vault |
| `benign-v2` | `guarded_vault_benign_v2.wasm` | `1.1.0` | view `get_stats() -> (U128, u32)` | a benign upgrade Keyhole should pass |
| `evil-sweep` | `guarded_vault_evil_sweep.wasm` | `1.1.0` | `sweep()`, callable by anyone, sends `total` to a compiled-in beneficiary | a new money path |
| `evil-addkey` | `guarded_vault_evil_addkey.wasm` | `1.1.0` | `add_owner_key(public_key)`, no access check, adds a full-access key | a new key path |
| `evil-owner` | `guarded_vault_evil_owner.wasm` | `1.1.0` | `set_owner(owner_id)`, no access check | a code path one hop away (seize owner, then `upgrade`); statically only a new method name |
| `evil-fee` | `guarded_vault_evil_fee.wasm` | `1.1.0` | none | `withdraw_all` skims half; a pure logic change a wasm export/host-call diff cannot see |

`evil-sweep`'s beneficiary is fixed at compile time with `option_env!("SWEEP_TO")`, defaulting to
`keyhole-attacker.testnet`. Two variants exist to measure, honestly, what a static wasm diff misses.
`evil-fee`'s exports and host imports are identical to the honest build, yet it steals half of every
withdrawal. `evil-owner` adds one export, but `set_owner` only writes state: it reaches no host call
the honest build lacks, so a capability diff sees a new method name and nothing more (the danger is
that the new owner can then call `upgrade`). What `exportDiff` in `packages/core/src/wasm.ts` reports
for each variant against `guarded_vault.wasm` (run 2026-11-09 on the wasm in `out/`):

| Variant | Added methods | Added capabilities | Newly reachable |
|---|---|---|---|
| `benign-v2` | `get_stats` | — | — |
| `evil-sweep` | `sweep` | — | `transfer` from `sweep` |
| `evil-addkey` | `add_owner_key` | `add_full_access_key` | — |
| `evil-owner` | `set_owner` | — | — |
| `evil-fee` | — | — | — |

### Why `upgrade` is the only export that reaches deploy

Like the demo vaults, the guarded vault moves value with the low-level `env::promise_batch_*` host
calls, not near-sdk's high-level `Promise` (which would link every action host function and blur which
capabilities the code uses). The one deploy capability it imports is reached only by `upgrade`. The
build (step 2 above) checks this by call-graph reachability rather than a bare export list, so a
deploy reachable from any other method, directly, through a table, or from a start function, fails
the build. (Reachability says a path exists in the code; the access check inside `upgrade` is not
something it can see, which is why `upgrade_is_owner_only` is a unit test.)

### Sandbox tests (`guarded-vault/tests/upgrade.rs`)

1. **deposit + `withdraw_all`**: a user deposits, `withdraw_all` without the 1 yoctoNEAR is rejected,
   then with 1 yoctoNEAR it clears the record, returns the amount, and the NEAR lands back in the user's
   account.
2. **Sputnik-style upgrade**: the owner calls `upgrade` with the raw bytes of `guarded_vault_evil_sweep.wasm`
   as the call args (no JSON). The code is replaced in place, state carries over with no migration, the
   new `sweep` export appears, and `sweep` moves the whole `total` to the compiled-in beneficiary
   (the test creates `keyhole-attacker.testnet` in the sandbox so the transfer lands).
3. **Real Sputnik DAO upgrade**: the vault's owner is a Sputnik v2 DAO running the testnet factory's
   default code (`guarded-vault/tests/fixtures/sputnikdao2_testnet.wasm`; provenance in the fixtures
   README) with a two-member council. A member stores the evil-sweep blob (`store_blob` returns its
   hash), proposes `UpgradeRemote { receiver_id: vault, method_name: "upgrade", hash }`, and the council
   votes. After the first approval nothing has changed; the second approval executes the proposal in the
   same transaction, Sputnik passes the stored blob to `upgrade` as raw input, and the vault's code hash
   becomes exactly the proposal hash. The DAO does not wait on its call into the vault, so the test
   checks every receipt for failure rather than trusting the vote transaction's status.
4. **NEP-366 delegate action**: alice signs `withdraw_all` + 1 yoctoNEAR as a `SignedDelegateAction`
   with her full-access key and a separate relayer submits it. The vault logs alice as the predecessor,
   her NEAR rises by exactly her 5 NEAR deposit (the relayer pays the gas and the 1 yoctoNEAR), her
   key nonce moves to the signed nonce, and resubmitting the same signed delegate fails with
   `DelegateActionInvalidNonce`. near-workspaces 0.24 has no delegate-action builder, so the test signs
   the delegate and the relayer's transaction with `near-primitives` and sends them over JSON-RPC.
5. **Function-call key**: a function-call access key limited to `withdraw_all` cannot withdraw: with the
   1 yoctoNEAR the transaction is rejected (`DepositWithFunctionCall`), without it `assert_one_yocto`
   rejects the call, and a delegate action signed by that key fails with `DepositWithFunctionCall`.

## Eval fixtures (`fixtures/`): testnet only

Two tiny contracts for the labelled testnet corpus that `scripts/eval-fixtures.ts` builds (`eval/testnet-fixtures.json`). They live in their own cargo workspace (`fixtures/Cargo.toml`, own `Cargo.lock`), so `test.sh` and the main workspace are unchanged.

| Crate | Wasm (`fixtures/out/`) | What it is |
|---|---|---|
| `fixture-upgradable` | `fixture_upgradable.wasm` | State `owner_id`; `new(owner_id)`, view `get_owner()`, and `upgrade()`: owner only, deploys the call's raw input to the contract's own account with `env::promise_batch_create` + `env::promise_batch_action_deploy_contract` |
| `fixture-upgradable-hidden` | `fixture_upgradable_hidden.wasm` | The same, minus `get_owner`: no view method reveals the owner |

Once the account's own keys are deleted, `upgrade()` is the only way to change the code, so the expected class follows from who the owner is (one key, a DAO's threshold, a missing account, or hidden).

```bash
cd contracts/fixtures
cargo test --workspace --lib
for c in upgradable upgradable-hidden; do cargo near build non-reproducible-wasm --locked --manifest-path $c/Cargo.toml; done
install -m 644 target/near/fixture_upgradable/fixture_upgradable.wasm target/near/fixture_upgradable_hidden/fixture_upgradable_hidden.wasm out/
# then, from the repo root: NODE_USE_ENV_PROXY=1 npx tsx scripts/eval-fixtures.ts
```

The script builds these accounts under its own faucet master (labels are true by construction; each entry lists its transactions):

| Account prefix | Built as | Expected |
|---|---|---|
| `fx-immutable` | `demo_vault_v1`, every key deleted | IMMUTABLE |
| `fx-fak` | `demo_vault_v1`, keeps its full-access key | CUSTODIAL |
| `fx-fconly` | `demo_vault_v1`, only a function-call key (`deposit`) | IMMUTABLE |
| `fx-owner-key` | `fixture-upgradable`, owner a plain account with a full-access key, no own keys | CUSTODIAL |
| `fx-owner-dao` | `fixture-upgradable`, owner a Sputnik DAO needing 2+ approvals for every proposal kind | GOVERNED |
| `fx-owner-dao-weak` | `fixture-upgradable`, owner a Sputnik DAO where one member passes a `call` | CUSTODIAL |
| `fx-hidden-owner` | `fixture-upgradable-hidden`, no own keys | UNRESOLVED |
| `fx-nocode` | plain account | NO_CODE |
| `fx-owner-gone` | `fixture-upgradable`, owner an unregistered top-level name | UNRESOLVED |

The DAO owners are third-party testnet DAOs and the missing owner name can be registered by anyone, so the script re-checks those conditions on every run and warns when one no longer holds.
