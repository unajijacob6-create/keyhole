# @keyhole/hatch

An escape hatch a depositor arms in advance: a withdraw-to-self that the Keyhole guardian can submit
later, when it sees a dangerous upgrade of the venue coming. Interface contract:
[docs/GUARDIAN_DESIGN.md](../../docs/GUARDIAN_DESIGN.md#packageshatch-keyholehatch). What a hatch can
and cannot do, the threat model and the live testnet proof: [docs/HATCH.md](../../docs/HATCH.md).

```ts
import { armDelegateHatch, verifyHatch, hatchHealth, fireHatch, probeDeposit } from "@keyhole/hatch";
import { Rpc } from "@keyhole/core";

// Does the venue's withdraw need 1 yoctoNEAR? (Then only delegate mode can call it.)
await probeDeposit(new Rpc({ network: "testnet" }), "wrap.testnet", "near_withdraw", { amount: "1" });
// => { need: "one-yocto", ... }

// User side: sign the withdraw once. The dedicated key's secret never leaves memory.
const hatch = await armDelegateHatch({ owner: userAccount, provider, venue: "wrap.testnet",
  method: "near_withdraw", args: { amount: "100000000000000000000000" } });
verifyHatch(hatch);                               // { ok: true, checks: [...] }  offline
await hatchHealth(new Rpc({ network: "testnet" }), hatch); // { state: "ARMED", blocks_left, ... }

// Guardian side, when the radar says STOP:
await fireHatch(hatch, relayerAccount);           // { tx, ok: true }  relayer pays gas + deposit
```

| Function | What it does |
| --- | --- |
| `prepareDelegateHatch` | Pure, offline. Signs `method(args)` on `venue` as a NEP-366 delegate action with nonce `keyNonce + 1` and `max_block_height = headHeight + ttlBlocks`. |
| `armDelegateHatch` | Fresh ed25519 key → owner adds it as FULL ACCESS → reads its nonce → `prepareDelegateHatch` → drops the key. Deletes the key again if signing fails. |
| `decodeHatch` | What the signed bytes say (borsh `SignedDelegate`), independent of the record's fields. |
| `verifyHatch` | Signature over the NEP-461 hash `sha256(u32le(2^30+366) ‖ borsh(DelegateAction))`, and every record field (sender, receiver, method, args, deposit, gas, nonce, max_block_height, public key, id) equals the signed bytes. fc-key records (nothing signed): deposit 0 and the id matches the record. |
| `hatchHealth` | `view_access_key` → REVOKED / STALE / USED / EXPIRED / ARMED. A delegate hatch is EXPIRED once fewer than `MIN_LANDING_BLOCKS` (4) blocks are left, since it executes after the final head; an fc-key hatch is STALE when its allowance cannot cover one call (one extra `gas_price` request). Pass a fresh `Rpc` per check: `Rpc` memoizes identical requests. |
| `fireHatch` | Relayer sends one `SignedDelegate` action to the user's account; `ok` only if no receipt failed and the venue's receipts succeeded. Refuses a record that does not verify, before spending gas. |
| `armFunctionCallHatch` / `fireFunctionCallHatch` | fc-key mode: a key limited to (venue, methods), default allowance 0.25 NEAR, always 0 deposit. The guardian keeps the key. Arming refuses an allowance below the up-front cost of one call (`fcAllowanceNeeded`, measured on testnet: ~0.101 NEAR at 100 Tgas); firing refuses a record that does not verify. |
| `probeDeposit` | View-call probe: `one-yocto` (exactly or at least 1 yoctoNEAR) / `none-before-state` / `inconclusive` (also for any other "attached deposit" demand). |
| `judgeOutcome` | The outcome check `fireHatch` uses, exported for replaying recorded outcomes. |

Tests: `npx vitest run packages/hatch`. Fixtures in `test/fixtures/` are real RPC answers:
`probe-*.json` from `test/record-fixtures.ts` (view calls only), `live-run.json` from
`scripts/hatch-live.ts` (public testnet data: records, tx hashes, outcomes; no secret keys).
