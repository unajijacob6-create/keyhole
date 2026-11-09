# Escape hatches

A hatch is a withdraw-to-self that a depositor signs now and a guardian submits later, only when the
contract holding the funds is about to change in a way Keyhole grades STOP.

Code: `packages/hatch/src/index.ts`. Tests: `npx vitest run packages/hatch`. Live proof: `npm run hatch:live`.

## Why two modes

One protocol rule decides the design: **a function-call access key cannot attach a deposit**, and a
meta-transaction signed by one cannot either (nearcore `runtime/runtime/src/verifier.rs` and
`actions.rs`, error `DepositWithFunctionCall`). Most withdraw methods on NEAR demand exactly
1 yoctoNEAR. `probeDeposit()` checks a method with a view call (attached deposit is 0 in a view, so
`assert_one_yocto` panics with a recognisable message):

```
$ npm run hatch:live        (2026-11-09)
probe wrap.testnet.near_withdraw: one-yocto (panics: Requires attached deposit of exactly 1 yoctoNEAR)
```

| mode | what is added to the account | who holds what | works for |
|---|---|---|---|
| `delegate` | one dedicated full-access key, used once to sign and then dropped | the guardian holds only the signed bytes | any method, including those that need 1 yoctoNEAR |
| `fc-key` | a function-call key limited to the venue and its exit methods | the guardian holds that key | exits that take no deposit (the key cannot attach one) |

## Delegate mode, step by step

1. A fresh ed25519 key is generated and added to the depositor's account as a full-access key
   (signed by the depositor).
2. With that key, one NEP-366 `DelegateAction` is signed: sender = the depositor, receiver = the
   venue, one `FunctionCall` (method, args, gas, deposit), nonce = the key's nonce + 1, and a
   `max_block_height`.
3. The secret is dropped. It is never written to disk. JavaScript cannot guarantee that memory is
   zeroed, and deletion cannot be proven on chain; the depositor can remove the key at any time with
   `DeleteKey`.
4. The guardian stores the signed bytes. To fire, any account wraps them in a transaction to the
   depositor's account. The relayer pays the gas and the deposit.

What the signature covers (so what the relayer cannot change): sender, receiver, method, args, gas,
deposit, nonce, expiry and the signing key. `verifyHatch()` re-checks the signature and that the
bytes say what the record says; the unit tests flip each field and one byte of the signed blob and
expect a refusal.

`hatchHealth()` is deterministic, from public state: `ARMED` (key present, full access, nonce below
the signed nonce, head at or below `max_block_height`), `USED` (nonce reached), `REVOKED` (key
gone), `EXPIRED`, `STALE` (key permission changed).

## Live run on testnet (2026-11-09)

`npm run hatch:live` against `wrap.testnet`, the wNEAR contract (a real NEP-141 token whose
`near_withdraw` requires 1 yoctoNEAR). A fresh user wrapped 0.1 NEAR and armed a hatch; a different
account, `guardian.keyhole.testnet`, relayed it.

```
armed 79e45e17fd3b7499: hl-mw9rtgxc.keyhole.testnet → wrap.testnet.near_withdraw({"amount":"100000000000000000000000"}) deposit 1 yocto, nonce 276975192000001, valid to block 276978791
verify ok: ed25519 signature over sha256(NEP-461 prefix + delegate) is valid; sender, receiver, method, args, deposit, gas, nonce, expiry and key match the record
fired ok by guardian.keyhole.testnet: https://testnet.nearblocks.io/txns/HaukXFREyvU9FKaVQckGTeDEyuKsrekeD7isgT9Rxrpt
result wNEAR 0.1000 → 0.0000; user NEAR +0.1000; relayer paid 0.0003 NEAR (gas + 1 yocto)
health USED (key nonce 276975192000001 >= signed nonce 276975192000001)
replay refused as expected (DelegateActionInvalidNonce)
PASS
```

## What a hatch does not do

- It does not protect against a compromised key on the depositor's own account. Whoever holds any
  full-access key can delete the hatch key or move funds first.
- It adds a full-access key. Its secret existed for the moment of signing. If the arming process is
  compromised at that moment, that is a full-account compromise, like any key.
- It cannot beat a change that lands with no window: a staged upgrade deployed in the same
  transaction, a direct `DeployContract` by a key, an unrestricted upgrade path. Then Keyhole can
  only alert after the fact.
- Arguments are fixed when signing. Prefer withdraw-all methods; for amount arguments the hatch only
  moves the amount signed.
- A venue that authorises by `signer_account_id` sees the relayer as signer and will refuse.
- The trigger is enforced off chain. A guardian can submit early or never. The worst it can do with
  the bytes is the exit the depositor signed, to the depositor's own account.
- One key, one hatch. Any other transaction signed with the hatch key spends its nonce and the hatch
  becomes `USED`.
