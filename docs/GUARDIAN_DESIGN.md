# Keyhole Guardian: design contract

Status: build spec (2026-11-09). This file fixes the interfaces between the pieces so they can be built
in parallel. Public-facing claims live in `docs/GUARDIAN.md` (written last) and must cite a command.

## One line

See the upgrade coming, get out before it lands. Keyhole reads the exact code a DAO is voting on,
grades it before the deciding vote, and can fire a withdraw-to-self the user signed in advance.

## Verified facts this design rests on (2026-11-09, re-check before publishing)

- A function-call access key cannot attach a deposit, meta-transactions included
  (nearcore `runtime/runtime/src/verifier.rs` `DepositWithFunctionCall`; `actions.rs` delegate path).
  Ref `withdraw`, Burrow `execute`/`simple_withdraw`, `wrap.near` `near_withdraw`, `intents.near`
  `ft_withdraw` and NEP-141 `ft_transfer` all require exactly 1 yoctoNEAR (view-call probes).
- A NEP-366 `SignedDelegateAction` signed by a full-access key may carry a deposit, can be held and
  relayed later by anyone, cannot be altered (signature covers sender, receiver, actions, nonce,
  max_block_height, public key), is valid while `nonce > key.nonce` and `height <= max_block_height`
  (no protocol cap on max_block_height). The relayer pays gas and the deposit.
- Sputnik v2 executes a proposal in the same call as the vote that reaches the threshold.
  `proposal_period` is an expiry, not a delay.
- Upgrade proposals carry the exact code hash (UpgradeRemote / UpgradeSelf) and the bytes are public
  before execution: they are the args of the DAO's `store_blob` transaction. Verified on mainnet:
  ref-finance.sputnik-dao.near proposal 1018 hash GZmkbf… = sha256 of the 897,024-byte `store_blob`
  args sent by refchef.near (FastNEAR tx API `https://tx.main.fastnear.com/v0/account` + `/v0/transactions`).
- near-plugins `Upgradable` exposes `up_staged_code_hash`, `up_staged_code`, `up_get_delay_status`;
  `staging_duration` was null (0) on all 13 mainnet contracts sampled.

## Threat model (what it does and does not do)

Protects a depositor against changes made *outside their account*: a malicious or unreviewed code
upgrade of a contract that holds their funds, approved by a DAO / multisig / staged deploy.

Does not protect against: a compromised key on the user's own account (any full-access key holder can
delete the hatch key or move funds first); a zero-window upgrade (stage+deploy in one tx, a direct
DeployContract by a key, `unrestricted_upgrade`) — then Keyhole can only alert after the fact; venues
that authorize with `signer_account_id` (with a relayer, signer ≠ user); positions whose withdraw needs
arguments that change (args are fixed at signing; prefer withdraw-all forms).

Residual trust: the guardian decides *when* to submit (it can fire early, late or not at all). The
worst it can do with a hatch is submit exactly the signed withdraw-to-self; it cannot change a field of
it. The venue's code at the moment the call runs decides where the funds go, so a hatch fired after an
upgrade landed runs the new code.

## Packages and interfaces

### contracts/guarded-vault (Rust, near-sdk 5.30, crate `guarded_vault`)

Testnet-only demo venue that mirrors how Ref/Burrow look to a depositor at the exit (a 1-yoctoNEAR
withdraw). It holds native NEAR, whereas Ref and Burrow hold fungible tokens, whose drains the upgrade
diff does not flag (GRADING.md section 7).

State: `owner_id: AccountId` (the DAO), `balances: LookupMap<AccountId,u128>` (prefix `b"b"`), `total: u128`.
Methods:
- `#[init] new(owner_id)`
- `#[payable] deposit() -> U128`
- `#[payable] withdraw_all() -> U128` — `assert_one_yocto()`; sends the caller's whole balance to
  `predecessor_account_id`, with an `on_withdraw` callback that restores the balance if the transfer fails.
  Returns the amount. Under a relayed delegate action predecessor = the user (sender_id).
- `get_balance(account_id) -> U128`, `get_total() -> U128`, `get_owner() -> AccountId`, `version() -> String`
- `upgrade()` — owner only (`predecessor == owner_id`); reads the new wasm from raw `env::input()`
  (this is what Sputnik `UpgradeRemote` sends: the stored blob as raw input) and deploys it to the
  current account. No migration (state layout is fixed).

Cargo features select seeded variants (same state layout, built as separate wasm):
- default: honest v1 (`version` "1.0.0")
- `benign-v2`: adds view `get_stats() -> (U128, u32)`; `version` "1.1.0". A benign upgrade.
- `evil-sweep`: adds `sweep()` callable by anyone that sends `total` to a beneficiary fixed at compile
  time (`option_env!("SWEEP_TO")`, default `keyhole-attacker.testnet`), zeroes `total`. `version` "1.1.0".
- `evil-addkey`: adds `add_owner_key(public_key)` (no access check) that adds a full-access key to the
  vault account. `version` "1.1.0".
- `evil-owner`: adds `set_owner(owner_id)` with no access check. `version` "1.1.0".
- `evil-fee`: no new methods; `withdraw_all` sends only half the balance and keeps the rest.
  `version` "1.1.0". (A logic change that a wasm export/host-call diff cannot see. Used to measure misses honestly.)

Outputs in `contracts/out/`: `guarded_vault.wasm`, `guarded_vault_benign_v2.wasm`,
`guarded_vault_evil_sweep.wasm`, `guarded_vault_evil_addkey.wasm`, `guarded_vault_evil_owner.wasm`,
`guarded_vault_evil_fee.wasm`. Unlike demo-vault, every guarded_vault build imports
`promise_batch_action_deploy_contract` (its `upgrade` deploys), so test.sh's "no code-changing imports"
check exempts guarded_vault* and instead asserts that only `upgrade` reaches deploy.

### packages/core/src/pending.ts + upgrade.ts (TypeScript, browser + Node, no Node-only APIs)

```ts
export type ProposalState = "pending" | "expired" | "executed" | "rejected" | "removed" | "failed" | "moved";
export interface UpgradeProposal {
  dao: string; id: number; proposer: string; description: string;
  kind: "UpgradeRemote" | "UpgradeSelf" | "FunctionCall";
  target: string;               // contract whose code would change (UpgradeSelf: the DAO itself)
  method: string | null;        // method the DAO will call (UpgradeRemote/FunctionCall)
  code_hash: string | null;     // base58 sha256 of the new code, if determinable
  hash_from: "proposal" | "args-hash" | "args-code" | null;
  status: string;               // raw Sputnik status
  state: ProposalState;         // InProgress past submission_time+proposal_period => "expired"
  submitted_at_ms: number; expires_at_ms: number;
  votes: { approve: number; reject: number; remove: number };
  required: number | null;      // approvals needed for this kind (from get_policy, analyzeSputnikPolicy)
}
export const UPGRADE_METHODS: RegExp; // upgrade|up_deploy_code|up_stage_code|deploy|deploy_code|update_contract|unrestricted_upgrade|add_release_info|stage_code|set_code|upgrade_contract
export function decodeUpgradeProposal(dao: string, raw: any, policy: any, nowMs: number): UpgradeProposal | null;
export async function listUpgradeProposals(rpc: Rpc, dao: string, opts?: { last?: number; nowMs?: number }): Promise<UpgradeProposal[]>;
export function hashFromArgs(argsBase64: string): Promise<{ hash: string; from: "args-hash" | "args-code" } | null>;
  // JSON field hash|code_hash|codeHash|new_code_hash as base58, hex (64 chars) or 32-byte array; or raw wasm args (\0asm) => sha256
export interface StagedUpgrade { contract: string; staged_hash: string | null; live_hash: string; staging_timestamp_ms: number | null; staging_duration_ms: number | null; pending: boolean }
export async function stagedUpgrade(rpc: Rpc, contract: string): Promise<StagedUpgrade | null>; // null if not near-plugins Upgradable
  // accepts both base58 string and raw 32-byte array hash formats; staged == live => pending false
export interface TxApi { (path: "/v0/account" | "/v0/transactions", body: unknown): Promise<any> }
export const TX_API: Record<Network, string>; // mainnet https://tx.main.fastnear.com, testnet https://tx.test.fastnear.com
export function txApi(network: Network, fetchImpl?: typeof fetch): TxApi;
export async function fetchPendingCode(opts: { api: TxApi; dao: string; hash: string; maxPages?: number }): Promise<{ code: Uint8Array; tx: string; signer: string; height: number } | null>;
  // scans the DAO's real-receiver txs newest-first for a FunctionCall store_blob whose args sha256 == hash
```

```ts
// upgrade.ts
export type UpgradeFlag = "PENDING_CODE_UNAVAILABLE" | "UNVERIFIED_PENDING_CODE" | "NEW_CODE_CHANGE_PATH"
  | "NEW_MONEY_PATH" | "EXIT_METHOD_REMOVED" | "NEW_KEY_PATH" | "AI_REVIEW_HIGH" | "NO_CHANGE";
export interface UpgradeGradeInput {
  target: string; live_hash: string; pending_hash: string | null;
  live: WasmAnalysis | null; pending: WasmAnalysis | null;
  verified: { reproducible: boolean | null; sourcescan: boolean | null; registry_review?: string | null };
  review?: { risk: "high" | "medium" | "low" | "none"; summary: string } | null;
}
export interface UpgradeGrade {
  verdict: "OK" | "CAUTION" | "STOP"; flags: UpgradeFlag[];
  reasons: { severity: "stop" | "caution" | "info" | "ok"; text: string }[];
  diff: ExportDiff | null;
  fire: boolean;   // what the default "strict" auto-fire policy would do
  headline: string;
}
export function gradeUpgrade(i: UpgradeGradeInput): UpgradeGrade;
```

Rules (deterministic, documented in GRADING.md):
- NEW_CODE_CHANGE_PATH: an added capability or newly reachable export in {deploy_contract, use_global_contract, add_full_access_key, delete_account}.
- NEW_KEY_PATH: same for add_function_call_key / delete_key.
- NEW_MONEY_PATH: added methods, or newly reachable methods, with a specific (non-dispatcher) path to transfer.
- EXIT_METHOD_REMOVED: a removed export that reached transfer in the live code.
- UNVERIFIED_PENDING_CODE: neither a reproducible-build match nor SourceScan for pending_hash.
- STOP iff UNVERIFIED and (NEW_CODE_CHANGE_PATH or NEW_MONEY_PATH or EXIT_METHOD_REMOVED or NEW_KEY_PATH), or AI_REVIEW_HIGH.
- CAUTION iff not STOP and (UNVERIFIED or PENDING_CODE_UNAVAILABLE or any other flag).
- OK otherwise. `fire` = verdict === "STOP".

### packages/hatch (`@keyhole/hatch`)

```ts
export interface Hatch {
  schema: "keyhole.hatch/1"; id: string; network: Network;
  account: string; venue: string; method: string; args: Record<string, unknown>;
  deposit: string; gas: string; mode: "delegate" | "fc-key";
  public_key: string;           // dedicated key
  nonce: string | null; max_block_height: string | null;  // delegate
  signed_delegate: string | null;  // base64 borsh SignedDelegate
  created_at: string; created_height: number; trigger: "stop" | "any-upgrade" | "manual";
}
export function prepareDelegateHatch(o: { network; account; venue; method; args; deposit; gas; keyPair: KeyPair; keyNonce: bigint; headHeight: number; ttlBlocks: number; trigger; now?: Date }): Promise<Hatch>;   // pure, offline
export async function armDelegateHatch(o: { owner: Account; provider; venue; method; args; deposit?; gas?; ttlBlocks?; trigger? }): Promise<Hatch>;
  // KeyPair.fromRandom("ed25519") → owner adds it as FULL ACCESS → read its nonce → prepare → drop the secret (never written to disk)
export function decodeHatch(h: Hatch): { senderId; receiverId; actions: { method; args; deposit; gas }[]; nonce: bigint; maxBlockHeight: bigint; publicKey: string };
export function verifyHatch(h: Hatch): { ok: boolean; checks: string[] };  // signature over NEP-461 hash, fields match record
export type HatchState = "ARMED" | "USED" | "REVOKED" | "EXPIRED" | "STALE";
export async function hatchHealth(rpc: Rpc, h: Hatch, opts?: { headHeight?: number }): Promise<{ state: HatchState; reasons: string[]; key_nonce: string | null; head: number; blocks_left: number | null }>;
export async function fireHatch(h: Hatch, relayer: Account): Promise<{ tx: string; ok: boolean; error?: string }>;
export async function armFunctionCallHatch(o: { owner: Account; venue; methods: string[]; method; args; allowance? }): Promise<{ hatch: Hatch; keyPair: KeyPair }>;  // guardian must store keyPair; can only call those methods with 0 deposit
export async function fireFunctionCallHatch(h: Hatch, keyPair: KeyPair, provider): Promise<{ tx: string; ok: boolean; error?: string }>;
export type DepositNeed = "one-yocto" | "none-before-state" | "inconclusive";
export async function probeDeposit(rpc: Rpc, contract: string, method: string, args?: unknown): Promise<{ need: DepositNeed; detail: string }>;
  // view-call probe: panic "Requires attached deposit of exactly 1 yoctoNEAR" => one-yocto; ProhibitedInView => inconclusive; other => none-before-state
```

### guardian/ (integration)

Loop: hatches + watchlist → resolve each venue's controller (inspect) → for DAO controllers poll
`get_last_proposal_id`; for near-plugins targets poll `up_staged_code_hash`; for everything keep the
existing code-hash watcher as post-deploy fallback → on a new pending upgrade fetch code, grade, publish
an alert, and fire hatches whose trigger matches.

### Demo (`npm run demo:guardian`, `--replay` verifies a recorded run against public testnet RPC)

DAO `kh-guardian.sputnikv2.testnet` (council: keyhole-attacker.testnet, keyhole.testnet; 2 approvals
needed) owns a fresh `gv-<run>.keyhole.testnet` guarded vault. Alice arms a delegate hatch; Bob does
not. The attacker stores the evil-sweep blob and proposes UpgradeRemote. Keyhole fetches the bytes,
diffs, STOP, fires Alice's hatch. The second vote executes; the sweep takes only Bob's deposit.
