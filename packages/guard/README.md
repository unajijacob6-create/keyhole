# @keyhole/guard

A pre-call check for agents that move money, enforced in code rather than in a prompt.

```ts
import { guardCall, GuardRefusal } from "@keyhole/guard";

await guardCall("vault.example.near", { methodName: "deposit", deposit: 1n }, { execute });
```

| verdict | what guardCall does |
|---|---|
| STOP | throws `GuardRefusal`; `execute` is never called |
| CAUTION | asks a human (`policy.ask`) or follows `policy.onCaution` (`"allow"` / `"deny"`, default deny) |
| OK | calls `execute` |

The verdict is the worst of two grades:

1. **The live code**: `@keyhole/core` `inspect()` (who can replace the code, is it verified).
   `policy.expectCodeHash` pins the hash the agent was configured against.
2. **Upgrades that have not executed yet** (`policy.checkPending`, default on, `src/pending.ts`):
   Sputnik proposals of the DAO(s) that control the target (inspect owners with a DAO actor, the
   rule of `guardian/src/radar.ts` `resolveController`, plus the target itself if it is a DAO) that
   can still execute (core `isLive`: pending, or failed inside its period), and near-plugins staged
   code that differs from the live code. Each is graded by the guardian's `assessPending` from the
   exact bytes (no AI reviewer unless `pending.reviewer` is passed).
   - a live pending upgrade graded STOP refuses the call: `GuardRefusal.pending` carries the DAO,
     proposal id, pending hash, headline and the full assessment, and the message names them too;
   - CAUTION goes to the CAUTION policy (`policy.ask` receives the pending check as a third argument);
   - bytes that cannot be read, an RPC error, an unreadable proposal list, or more recent proposals
     than it reads (`pending.last`, default 20) while the oldest read is still inside its period:
     CAUTION with the reason in `pending.errors`, never OK.

`decide()` returns the same decision without executing (the MCP tool `keyhole_check_call` uses it).

## Auto-hatch (testnet only)

```ts
const { result, hatch, hatchError } = await guardCall("vault.testnet", { methodName: "deposit", deposit }, {
  execute,
  hatch: { owner: aliceAccount, provider, method: "withdraw_all", args: {}, ttlBlocks: 600_000 },
});
```

After a successful `execute`, the guard arms a `@keyhole/hatch` delegate hatch (a withdraw-to-self
`owner` signs in advance; see [docs/HATCH.md](../../docs/HATCH.md)) for the same venue and returns it
with the result. `owner` must be the account that deposited. It refuses before deciding or executing
when the provider's network or the venue is not testnet. If arming fails after the call went through,
the result comes back with `hatch: null` and `hatchError`, and the hatch package takes its key off
again.
