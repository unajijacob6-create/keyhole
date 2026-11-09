# Keyhole hatch: get out before the upgrade lands

A hatch is a withdraw-to-self that a depositor arms in advance and someone else (the Keyhole guardian)
submits later, when Keyhole grades a code change of the venue STOP. In this build the guardian fires a
`stop` hatch for a pending proposal, staged code, and also for code that already landed (an executed
proposal or a changed live code hash), in which case the call runs the new code. Code:
[`packages/hatch`](../packages/hatch). Interface contract:
[GUARDIAN_DESIGN.md](GUARDIAN_DESIGN.md#packageshatch-keyholehatch). Live proof:
[`scripts/hatch-live.ts`](../scripts/hatch-live.ts), run on testnet on 2026-11-09 (below).

## Why two modes

Most withdraw methods demand exactly 1 yoctoNEAR (near-sdk `assert_one_yocto`), so that only a
full-access key can call them. A function-call access key can never attach a deposit: nearcore rejects
the transaction before it executes. Both facts were checked, not assumed:

| Venue, method | `probeDeposit` | Source |
| --- | --- | --- |
| `wrap.near` `near_withdraw` | one-yocto | mainnet view call, `packages/hatch/test/fixtures/probe-mainnet.json` |
| `wrap.near` `ft_transfer` (NEP-141) | one-yocto | same |
| `v2.ref-finance.near` `withdraw` | one-yocto | same |
| `intents.near` `ft_withdraw` | one-yocto | same |
| `linear-protocol.near` `unstake_all` | inconclusive (reads `predecessor_account_id`, which a view call may not) | same |
| `asac.near`, `near-punks.near` `nft_approve` (NFT standard) | one-yocto ("Requires attached deposit of **at least** 1 yoctoNEAR", near-contract-standards `assert_at_least_one_yocto`; 1 yocto satisfies it) | same |
| `wrap.near` `near_deposit` | inconclusive ("Requires positive attached deposit": a deposit demand that is not a 1-yocto check) | same |
| `wrap.testnet` `near_withdraw`, `ft_transfer`, `storage_withdraw`, `storage_unregister` | one-yocto | testnet view calls, live run below |
| function-call key + 1 yocto on `wrap.testnet` | RPC refused: "Deposit is not allowed with function call" | live run below (no tx hash: rejected before inclusion) |

So Keyhole has two kinds of hatch:

| | **delegate** (default) | **fc-key** |
| --- | --- | --- |
| What is stored | A NEP-366 `SignedDelegateAction` (base64 borsh) | A function-call key the guardian holds |
| Signed by | A dedicated FULL ACCESS key, generated for this hatch; its secret is dropped right after signing | Nothing is pre-signed; the guardian signs when it fires |
| Can attach the 1 yoctoNEAR deposit | Yes (the relayer pays it) | No, never |
| Who pays gas | The relayer | The user's account, capped by the key's allowance (default 0.25 NEAR; see "fc-key allowance" below) |
| How many times | Once: the delegate nonce is spent | Until the key is deleted or the allowance runs out |
| Arguments | Fixed at signing | Fixed in the record (the key would allow any args to the listed methods) |
| Expires | At `max_block_height` (default 4,500,000 blocks ≈ 30 days, see below) | No |
| Revoke | Delete the dedicated key | Delete the key |

Use delegate mode for every venue whose exit needs 1 yocto (all the mainnet withdraws probed above).
Use fc-key mode only for an exit that takes no deposit, such as a core staking pool's `withdraw_all`.

## What a hatch can do, and what it cannot

A delegate hatch is one signed call: `account` calls `venue.method(args)` with `deposit` and `gas`,
valid while the key's nonce is below the hatch nonce and the chain height is at most
`max_block_height`. The signature covers sender, receiver, the action list, nonce, max_block_height and
the public key, so:

- **Can:** be submitted by anyone who holds the record (Keyhole's guardian, or the user, or any other
  relayer). The call executes as the user (`predecessor_account_id` = the user), so a withdraw-to-self
  pays the user as long as the venue's code does what it did when the hatch was armed.
- **Cannot:** be redirected to another receiver, method, amount or account, or be submitted twice.
  `verifyHatch` checks this offline; the tests alter each field (receiver, sender, method, args,
  deposit, gas, nonce, max_block_height, public key) in the record and, separately, inside the signed
  payload, and every alteration is rejected (`packages/hatch/test/hatch.test.ts`).
- **Cannot:** move funds the call itself does not move. The worst a holder can do is submit exactly the
  signed withdraw, early, late or never.
- **Does not fix the outcome.** The signature fixes the receiver, method, args and deposit, not what
  the venue's code does with them. Where the funds go is decided by the venue's code at the moment
  the call runs. A hatch fired after an upgrade landed runs the new code: the repo's own seeded
  `evil-fee` vault keeps half of every `withdraw_all`, with the same method and arguments.

An fc-key hatch is a key that can call only the listed methods on one venue, with 0 deposit.

- **Can:** call those methods with *any* arguments, repeatedly, spending the allowance on gas. For a
  withdraw-to-self method that only ever pays the caller, that is still only "get the user out" (the
  staking pool's `withdraw_all` reads `predecessor_account_id`, per its probe, and paid the user in the
  live run), but a careless method list could grant more. `armFunctionCallHatch` refuses an empty list
  (which on NEAR means "any method").
- **Cannot:** attach a deposit, touch any other contract, or add keys.

`hatchHealth` reads the key from chain and says whether the hatch can still fire:

| State | Meaning |
| --- | --- |
| ARMED | Key present with the right permission; delegate: nonce unspent and at least `MIN_LANDING_BLOCKS` (4) blocks before `max_block_height` (`blocks_left` given); fc-key: allowance covers one call up front |
| USED | Delegate: key nonce ≥ hatch nonce. The hatch fired (or the key signed something else); it can never land again |
| REVOKED | The key is gone (deleted, or the account was deleted) |
| EXPIRED | Delegate: head is past `max_block_height`, or so close to it (fewer than 4 blocks) that a delegate action sent now would execute after it |
| STALE | The key's permission no longer fits (delegate key downgraded; fc key for another receiver or method, or upgraded to full access), the record no longer matches its signature (delegate) or its id (fc-key), or an fc key's allowance is too small to send the call |

Why 4 blocks: nearcore checks `max_block_height` against the block where the delegate *receipt* is
applied, not the head `hatchHealth` reads. The final head trailed the optimistic head by 2 to 4 blocks in
three testnet samples (2026-11-09), the relayer's transaction lands after the tip, and the delegate receipt
ran one block after its transaction in the live run (blocks 276977260 → 276977261). 2 + 1 + 1 is a lower
bound, not a target: fire well before it.

### fc-key allowance

Measured on testnet on 2026-11-09 with `NODE_USE_ENV_PROXY=1 npx tsx scripts/hatch-allowance.ts` (gas
price 100,000,000 yocto/gas, protocol 88; throwaway account `hatch-allow-1794262088525.keyhole.testnet`,
created [6PxAyB…](https://testnet.nearblocks.io/txns/6PxAyBPvNJtgcyCZSunxwwre5FwESTgXFjowTKeH9FUW),
deleted [9A55f4…](https://testnet.nearblocks.io/txns/9A55f4jb21BPSa1AZJNk6foSPSQg193NxsH2z72is2SH);
two earlier runs of the same steps gave identical numbers):

- A key with 0.005 NEAR allowance was refused by the node (`NotEnoughAllowance`, no tx hash) for a
  100 Tgas call ("allowance: 5000000000000000000000, cost: 100919362755690500000000") and for a 30 Tgas
  call ("cost: 30919362755690500000000"). Prepaid gas is priced at 1e9 yocto/gas up front, 10× the
  reported gas price. `EXPERIMENTAL_protocol_config` shows `pessimistic_gas_price_inflation_ratio`
  [1, 1], so where the 10× comes from is not established here; Keyhole uses it as a measured factor
  (`FC_PREPAID_PRICE_FACTOR`), not a protocol constant.
- A 100 Tgas `ft_balance_of` call from a key with 0.25 NEAR
  ([FowGYw…](https://testnet.nearblocks.io/txns/FowGYw5owLA67WcVhyYuujfSGtev7w8K5fq93CnxEYFB)) took only
  156716395580200000000 yocto off the allowance: the gas burnt, not the prepaid amount.

So a 100 Tgas fc-key hatch needs about 0.101 NEAR of allowance left at the moment it fires, while each
call actually consumes far less. `armFunctionCallHatch` refuses a smaller allowance and `hatchHealth`
reports STALE once the allowance drops below it. (Inference, not measured: the account's own balance must
clear the same up-front cost.)

### The secret key

`armDelegateHatch` generates the dedicated key with `KeyPair.fromRandom("ed25519")`, has the owner add it
as a full-access key, signs, and drops every reference. It is never written to disk, a log, or the
record (`hatch.test.ts` checks the record does not contain it). **JavaScript cannot zero memory**: the
secret sits in immutable strings and buffers we do not own, so "dropped" means unreachable and
eventually garbage-collected, not wiped. Anyone who can read the arming process's memory before then
could recover a full-access key to the account. Arm in a process you trust, and treat a hatch whose
arming environment you doubt as compromised: delete its key.

After a hatch fires, its full-access key stays on the account with nobody holding the secret.
`scripts/hatch-live.ts` deletes it; a wallet integration should too.

## Threat model limits (from GUARDIAN_DESIGN.md)

Protects a depositor against changes made *outside their account*: a malicious or unreviewed code
upgrade of a contract that holds their funds, approved by a DAO, a multisig or a staged deploy, when the
hatch fires before the upgrade executes. Does not protect against:

- **A compromised key on the user's own account.** Any full-access key holder can delete the hatch key
  or move the funds first.
- **A zero-window upgrade** (stage and deploy in one transaction, a direct DeployContract by a key,
  `unrestricted_upgrade`). There is nothing to see before it lands; Keyhole can only alert afterwards.
  The same holds when the upgrade's executing vote lands before the hatch: Sputnik v2 executes a
  proposal in the same call as the vote that reaches the threshold.
- **Venues that authorize with `signer_account_id`.** With a relayer, the signer is the relayer, not
  the user. (fc-key mode does not have this problem: the user's account signs.)
- **Positions whose withdraw needs arguments that change.** Args are fixed at signing. A hatch for
  `near_withdraw {"amount": X}` leaves anything above X behind, and (inference, not tested here) fails
  once the balance drops below X. Prefer withdraw-all forms, and re-arm after deposits.
- **Token drains the diff cannot see.** The upgrade grade's money flags cover native NEAR
  (`transfer`) only. Fungible-token balances, such as Ref and Burrow deposits, move with cross-contract
  calls like `ft_transfer`, which no flag covers: a new method that sends everyone's tokens out with
  `ft_transfer` is not `NEW_MONEY_PATH`, and removing an FT withdraw is not `EXIT_METHOD_REMOVED`
  ([GRADING.md](GRADING.md#upgrade-grading)). Such an upgrade grades CAUTION if its code is
  unverified (OK if verified) unless an AI review reports high risk, so a `stop` hatch does not fire
  on it. The 1-yoctoNEAR exit requirement is the same as for native-NEAR vaults; the detection is not.
- **A failing exit.** `fireHatch` reports `ok: false` whenever any receipt fails (the live run shows
  a venue panic and a spent nonce). It cannot make a broken or already-upgraded venue pay. It is also
  conservative: a venue whose successful withdraw includes a deliberately failing sub-call would be
  reported as `ok: false`.

Residual trust: the guardian decides *when* to submit. It can fire early (the user is withdrawn
needlessly; on unchanged code the funds go to the user), late (after new code landed, which then
decides where the funds go) or not at all. It cannot change a field of the signed call.

`probeDeposit` is a view call: it sees only what the method does before its first state write or
forbidden host call. `one-yocto` is reliable (the panic names it, as "exactly" or "at least" 1
yoctoNEAR); a panic about any other "attached deposit" is `inconclusive`; `none-before-state` means "no
deposit was demanded before the method failed for another reason", not "no deposit is needed" (the
recorded `wrap.near` probe with bad args shows this: it panics in argument parsing, before the deposit
check); `inconclusive` means the view could not get that far.

## Default lifetime

`DEFAULT_TTL_BLOCKS` = 4,500,000. Measured on 2026-11-09 over the last 1,000,000 blocks: mainnet
0.578 s per block (blocks 222,823,162 to 223,823,162), testnet 0.593 s. At the mainnet rate that is
about 30.1 days. The protocol puts no cap on `max_block_height`; a longer TTL means a longer-lived
signed withdraw.

## Live testnet run (2026-11-09)

`NODE_USE_ENV_PROXY=1 npx tsx scripts/hatch-live.ts` against the real NEP-141 venue `wrap.testnet`
(code hash `DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa`). User `hatch-1794260757449.keyhole.testnet`
was created for the run with 0.5 NEAR and deleted at the end (beneficiary `keyhole.testnet`); the
relayer was `keyhole.testnet`. Every number below is printed by that run and stored in
`packages/hatch/test/fixtures/live-run.json`, which `packages/hatch/test/live-run.test.ts` replays.

**Delegate mode**

1. `probeDeposit(wrap.testnet, near_withdraw)` → `one-yocto`.
2. User registers storage ([89oQuy…](https://testnet.nearblocks.io/txns/89oQuyYJYbD3VudGune6SpCvhJe9KtxA3L3m83qtZKES))
   and wraps 0.1 NEAR ([CqDcGm…](https://testnet.nearblocks.io/txns/CqDcGmo43Lqkxtet7M9KvtVApv3xYbPu65rpnL33mbk8)):
   wNEAR balance 100000000000000000000000.
3. `armDelegateHatch` for `near_withdraw {"amount":"100000000000000000000000"}` with 1 yocto: hatch
   `928ddb0b03c5aa32`, key `ed25519:4dgemUZ2MtzDuSfNS9cP4xHtnDSLdmrjKyn123y29KCV`, nonce 276977252000001,
   max_block_height 281477253. `verifyHatch` ok (all 14 checks). `hatchHealth` ARMED, 4,500,000 blocks left.
4. `fireHatch` by the relayer: [HK9VR5NtNUXLUZJXpwva9qxG88e1cw82kfJkyeojyrBP](https://testnet.nearblocks.io/txns/HK9VR5NtNUXLUZJXpwva9qxG88e1cw82kfJkyeojyrBP),
   `ok: true`. The user's wNEAR went to 0 and their NEAR balance rose by 100000000000000000000001
   yocto: the 0.1 NEAR plus the 1 yocto deposit, which `wrap.testnet` refunds (its Transfer receipt
   to the user carries 100000000000000000000001, read with `EXPERIMENTAL_tx_status`). The receipts
   ran user (delegate action) → `wrap.testnet` (`near_withdraw`, log "Withdraw 100000000000000000000000
   yoctoNEAR from …") → user (transfer). The relayer's balance fell by 308626422960500000001 yocto
   (about 0.00031 NEAR: gas plus the 1 yocto); the user paid nothing for the withdraw.
5. `hatchHealth` USED (key nonce 276977252000001 = hatch nonce).
6. Replaying the same record: [2R7oWF…](https://testnet.nearblocks.io/txns/2R7oWFRS8pvDsfzXdePEdpS5t2EWz3xwGfGX8ZtxgbNv)
   was included but failed with `DelegateActionInvalidNonce`; `fireHatch` returned `ok: false`.
7. The owner deleted the key ([DQYPy7…](https://testnet.nearblocks.io/txns/DQYPy7cVUikE5mPtgMP4Ku5ZDacKGpdjY9TTr411adyP)):
   `hatchHealth` REVOKED.

**fc-key mode.** None of the `wrap.testnet` exits we probed takes 0 deposit (the four methods above are
one-yocto), so fc-key mode cannot withdraw from it. The run shows both halves of that, then uses a real
venue whose exit needs no deposit:

8. An fc-key hatch for `wrap.testnet` `near_withdraw` fired with 0 deposit:
   [EFPw7Z…](https://testnet.nearblocks.io/txns/EFPw7ZMffmuKbNSNohpgBCQNnR1tpPwxiRvaqYLj3aeb) was
   included and the venue panicked ("Requires attached deposit of exactly 1 yoctoNEAR");
   `fireFunctionCallHatch` returned `ok: false` with that message.
9. The same key sending `near_withdraw` with 1 yocto: refused by RPC, "Deposit is not allowed with
   function call".
10. The user deposited 0.1 NEAR (unstaked) into the testnet staking pool `aurora.pool.f863973.m0`
    ([9Y6RbU…](https://testnet.nearblocks.io/txns/9Y6RbUdxwCDrdUd5uyNhKL4JkXJH9SHY2ssPPW7YKA1Q)) and
    armed an fc-key hatch for `withdraw_all` (`hatchHealth` ARMED, allowance 0.25 NEAR).
    `fireFunctionCallHatch`: [FuYGKi…](https://testnet.nearblocks.io/txns/FuYGKigHRLkMhUuCAxEpgxszA3cX6S6Rp9yLswjrRoZ3),
    `ok: true`. Pool unstaked balance went to 0; the user's NEAR rose by 99691363914460200000000 yocto
    (0.1 NEAR minus 308636085539800000000 yocto of gas the user's own account paid in this mode).

**Cleanup.** `storage_unregister` on `wrap.testnet`
([9f7gYQ…](https://testnet.nearblocks.io/txns/9f7gYQdseZA8TiXNv2iEsnE968P6Ew942U24nPxD3otD)), all hatch
keys deleted, user account deleted
([CuW8gk…](https://testnet.nearblocks.io/txns/CuW8gk7yGXSrpA6ZbzG2scfVEJUHnEkjukKSFDeA54DL)).

All transactions of the run, by step name, are in `live-run.json` under `txs`.

## Reproduce

```sh
npm ci
npx vitest run packages/hatch                                   # offline, replays recorded answers
NODE_USE_ENV_PROXY=1 npx tsx packages/hatch/test/record-fixtures.ts  # re-record the view-call probes
NODE_USE_ENV_PROXY=1 npx tsx scripts/hatch-live.ts              # testnet; needs a keyhole.testnet key
```

The live script signs on testnet only (`scripts/lib/near.ts` refuses any other network). It reads keys
from `~/.near-credentials/testnet/` and writes the temporary user's key there (removed when the account
is deleted); nothing secret enters the repository.
