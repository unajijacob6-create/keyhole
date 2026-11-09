# Keyhole Guardian

See the upgrade coming, get out before it lands.

Most of the money on NEAR sits in contracts that a DAO can upgrade. A Sputnik DAO executes an
upgrade in the same call as the vote that reaches its threshold; the proposal period is an expiry,
not a delay. Keyhole Guardian watches those proposals, reads the exact code they would install,
grades it before the deciding vote, and can submit a withdraw-to-self that the depositor signed in
advance.

Every claim below names the command that re-checks it.

## What it does, step by step

1. **Find who controls the contract.** `inspect()` resolves owners, DAO thresholds and near-plugins
   roles from public RPC (see [GRADING.md](GRADING.md)).
2. **Watch where an upgrade appears before it lands** (`guardian/src/radar.ts`):
   - Sputnik proposals of that DAO: `UpgradeRemote`, `UpgradeSelf`, and `FunctionCall`s to
     upgrade-like methods (`upgrade`, `up_deploy_code`, `up_stage_code`, `add_release_info`, …).
     Each names the code hash. `listUpgradeProposals()` in `packages/core/src/pending.ts`.
   - near-plugins `up_staged_code_hash` (staged code that differs from the live code).
   - The live code hash itself, as a fallback after the fact.
3. **Read the exact bytes.** Sputnik stores upgrade code with a `store_blob` transaction whose
   arguments are the wasm. `fetchPendingCode()` finds it in the DAO's transaction history (FastNEAR tx
   index) and keeps it only if `sha256(bytes)` equals the proposal hash. For near-plugins, the staged
   bytes come from `up_staged_code`.
4. **Grade them before the vote** (`gradeUpgrade()` in `packages/core/src/upgrade.ts`, rules in
   [GRADING.md](GRADING.md#upgrade-grading)): new methods and privileged host calls diffed against the
   live code, SourceScan and reproducible-build attestations for the new hash, the NEP-330 source the
   bytes declare (read by running the constant getter in a stub VM, `packages/core/src/wasmview.ts`),
   and optionally a private review of the diff in a NEAR AI Cloud TEE with an offline-verifiable
   receipt, posted to the Keyhole registry as an `AiReview` for the pending hash.
5. **Act.** If the grade is STOP and a depositor armed a hatch for that contract, the guardian relays
   the hatch ([HATCH.md](HATCH.md)). It cannot change what the depositor signed.

## Proof

| claim | how to re-check | result |
|---|---|---|
| A testnet DAO upgrade was graded STOP and Alice's hatch landed before the deciding vote | `npm run demo:guardian -- --replay` (no keys) | 21/21 checks; hatch 23 blocks before the executing vote (run of 2026-11-09) |
| The hatch is exactly what Alice signed | `npm run judge` (check 9, offline) | signature valid; changing receiver, method, deposit or nonce fails |
| A real mainnet upgrade's bytes were public before its vote | `npm run judge` (check 10) | Ref proposal 1018: `store_blob` by refchef.near, 897,024 bytes, sha256 = proposal hash |
| A hatch works on a real NEP-141 venue | `npm run hatch:live` (testnet keys) | wrap.testnet `near_withdraw` (1 yoctoNEAR) relayed by another account; replay refused |
| How fast real upgrades execute | `npm run eval:upgrades` ([EVAL_UPGRADES.md](EVAL_UPGRADES.md)) | measured per proposal by archival bisection |

### The recorded run (testnet, 2026-11-09)

`npm run demo:guardian` creates a vault owned by `kh-guardian.sputnikv2.testnet` (a DAO from the
official `sputnikv2.testnet` factory, 2 of 2 council approvals), deletes the vault's own key, and
then:

| block | event |
|---|---|
| 276976436 / 276976443 | Alice deposits 1 NEAR, Bob 0.5 NEAR |
| 276976473 | a council member stores 113,387 bytes with `store_blob` |
| 276976482 | proposal #2: UpgradeRemote, "Vault v1.1: gas optimisations" |
| 276976501 | guardian: bytes read from the store_blob tx, diff `+ sweep`, `transfer ← sweep`, no verified build: **STOP**; Alice's hatch fired |
| 276976511 | registry AiReview #16 for the pending hash (TEE review: high) |
| 276976516 | vote 1 of 2 |
| 276976524 | vote 2 of 2: the upgrade executes in this call |
| 276976535 | `sweep()` empties the vault: Bob's 0.5 NEAR |

Wall-clock time from the proposal transaction to the hatch landing: 11.8 s in that run.

## Limits (read these)

- **No window, no head start.** Stage and deploy in one transaction, a direct `DeployContract` by a
  key, or an unrestricted upgrade method leave nothing to beat. Keyhole then reports the change after
  the fact. near-plugins `staging_duration` was unset (zero) on every Upgradable contract surveyed in
  `data/radar.json`.
- **The diff sees structure, not intent.** New methods and privileged host-call reachability are
  visible; a logic change inside an existing method is not (the seeded `evil-fee` case in
  [EVAL_UPGRADES.md](EVAL_UPGRADES.md) is graded as a miss on purpose). Verified builds and the private
  review exist for that gap; neither is proof of correctness.
- **Most real upgrades are unverified.** A strict STOP rule would fire on routine upgrades. The eval
  reports how often, and hatches default to the `stop` trigger only for contracts the depositor
  chooses.
- **Hatches have the limits in [HATCH.md](HATCH.md):** a dedicated full-access key exists for the
  moment of signing; no protection against a compromised key on the depositor's own account; venues
  that check `signer_account_id` refuse relayed calls; args are fixed at signing.
- **Off-chain trigger.** The guardian decides when to submit. The worst it can do is submit the exit
  early.
- **Mainnet is read-only here.** The radar reads mainnet; hatches are demonstrated on testnet.

## Prior and adjacent work

[Proposal X-Ray](https://github.com/bars26/near-proposal-xray) decodes Sputnik/Trezu proposals and
does vote maths; Keyhole Guardian adds reading and diffing the pending wasm, verification of the
proposed hash, the private review with a receipt, and the escape hatch. Shelflife surveys NEP-330 and
SourceScan coverage; Workcell exports executable regression tests bound to a wasm hash. Credit where
it is due.

## Run it

```bash
npx keyhole pending ref-finance.sputnik-dao.near --last 10
```
```bash
npm run guardian -- run --network mainnet --watch v2.ref-finance.near,contract.main.burrow.near
```
```bash
npm run demo:guardian -- --replay
```
