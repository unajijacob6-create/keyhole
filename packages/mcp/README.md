# @keyhole/mcp

A stdio [MCP](https://modelcontextprotocol.io) server that gives an AI agent Keyhole's trust check
before it moves money on NEAR: who can change the contract's code, is an upgrade about to land, and
would `guardCall` let the call through. **Read-only.** No tool takes a key, signs, or sends a
transaction; the server holds no credentials.

Built on the official `@modelcontextprotocol/sdk`, pinned to `1.32.2` (published 2026-10-23, per
`npm view @modelcontextprotocol/sdk time --json`).

## Tools

Every result is JSON text with the evidence fields Keyhole already produces (each reason carries the
RPC request that re-checks it).

| tool | input | what it answers |
|---|---|---|
| `keyhole_inspect` | `contract`, `network?`, `history?` | The `inspect()` report, condensed: `verdict` (OK / CAUTION / STOP), `class`, `headline`, `who_can_change_the_code` (keys, owner method, DAO threshold, global-contract publisher, each with evidence), `owners`, `reasons`, code hash, verification (SourceScan, NEP-330, registry). |
| `keyhole_pending` | `contract?` or `dao?`, `network?`, `limit?` (default 5) | Upgrade proposals of the Sputnik DAO that controls `contract` (resolved by `resolveController`) or of `dao`, newest first, plus near-plugins staged code. Every upgrade that can still execute (core `isLive`) is graded with the guardian's `assessPending`: `verdict`, `flags`, `headline`, `pending_hash`, `code_source` (the `store_blob` tx, `up_staged_code`, or `null` when the bytes could not be read), verification, diff summary. Settled proposals are listed with `state` and `is_current_code`, not graded. `live_verdict` is the worst live grade; it is CAUTION when older live proposals were not ruled out (`live_complete: false`). |
| `keyhole_check_call` | `contract`, `method`, `deposit?`, `network?`, `expect_code_hash?`, `check_pending?` | What `@keyhole/guard`'s `guardCall` would decide, **without executing anything**: `decision` OK / CAUTION / STOP, `reason`, the live code's grade, the pending-upgrade check (`pending.upgrades`, `pending.errors`), and `pending_stop` (DAO, proposal id, pending hash, headline) when a pending upgrade is the reason for STOP. |
| `keyhole_verify_hatch` | `hatch` (object or JSON string) | Offline `verifyHatch` + `decodeHatch` of a `keyhole.hatch/1` record: the checks, and what the signed delegate action actually says (sender, receiver, method, args, deposit, nonce, max block height). No network. |

An agent's loop: call `keyhole_check_call` before a deposit. OK: proceed. CAUTION: ask the human.
STOP: do not proceed. Then send the transaction through `guardCall` itself, because the chain can
change between the check and the transaction.

## Run it

From the repository root, after `npm install`:

```sh
npm run mcp                                   # tsx packages/mcp/src/server.ts
node packages/mcp/bin/keyhole-mcp.mjs         # the keyhole-mcp bin (registers tsx, then starts)
```

stdout carries the protocol only; one start-up line goes to stderr. Behind an HTTP proxy, set
`NODE_USE_ENV_PROXY=1` so Node's `fetch` uses `HTTPS_PROXY`.

### Claude Code

```sh
claude mcp add keyhole -- npx tsx /path/to/keyhole/packages/mcp/src/server.ts
# behind a proxy:
claude mcp add -e NODE_USE_ENV_PROXY=1 keyhole -- npx tsx /path/to/keyhole/packages/mcp/src/server.ts
```

### Any MCP client (command + args)

```json
{
  "mcpServers": {
    "keyhole": {
      "command": "node",
      "args": ["/path/to/keyhole/packages/mcp/bin/keyhole-mcp.mjs"]
    }
  }
}
```

## Live smoke (mainnet, read-only RPC, 2026-11-09)

The server started over stdio with `node packages/mcp/bin/keyhole-mcp.mjs`, called by an SDK
`StdioClientTransport` client. Output trimmed.

```text
tools: keyhole_inspect, keyhole_pending, keyhole_check_call, keyhole_verify_hatch

keyhole_inspect {"contract":"v2.ref-finance.near"}                       (2.1 s)
  verdict CAUTION, class GOVERNED
  headline "Code can be replaced only with multiple approvals (3 of 5). Current code is not source-verified."
  who_can_change_the_code: contract-method `upgrade`, control governed, owner
    ref-finance.sputnik-dao.near via get_owner(): 3 of 5 "council" members can pass a "call" proposal
  code GZmkbfVLcN7ErxU9RDxP24YTaKmoVixhM6XyycP15Qvi, 897024 bytes; 0 full-access keys
  flags UNVERIFIED_CODE, NO_SOURCE_METADATA; 14 RPC calls

keyhole_pending {"dao":"ref-finance.sputnik-dao.near"}                   (0.5 s)
  live_count 0, live_complete true, live_verdict OK: "No upgrade that can still execute was found."
  #1022 UpgradeRemote dclv2.ref-labs.near  executed  3G34Nhji…  is_current_code true
  #1018 UpgradeRemote v2.ref-finance.near  executed  GZmkbfVL…  is_current_code true
  #1016 UpgradeRemote dclv2.ref-labs.near  executed  BzhtCCGJ…  is_current_code false
  #969  UpgradeRemote dclv2.ref-labs.near  executed  FvsWeo3Z…  is_current_code false
  #923  UpgradeRemote dclv2.ref-labs.near  executed  8FYiayAi…  is_current_code false

keyhole_check_call {"contract":"v2.ref-finance.near","method":"deposit","deposit":"1"}   (3.0 s)
  decision CAUTION, would_execute_by_default false, executed false
  reason "Code can be replaced only with multiple approvals (3 of 5). Current code is not
          source-verified. (policy: deny on CAUTION)"
  pending: verdict OK, "No upgrade of v2.ref-finance.near is pending (proposals of
           ref-finance.sputnik-dao.near)." 20 settled proposals read and ignored, 0 errors
```

Re-run: start the server as above and call the same two tools; the proposal list will have moved on.

## Limits

- **Read-only.** The tools read public RPC, the FastNEAR transactions index (for `store_blob`
  bytes) and the Keyhole registry on testnet. They cannot sign, deposit, arm or fire a hatch.
  `keyhole_check_call` describes a decision; it does not make the call.
- **Verdicts describe trust assumptions, they do not accuse anyone.** CAUTION and STOP say what an
  owner, a DAO or new code *could* do, from public on-chain data. A STOP is a grade, not proof of
  malice: the upgrade eval ([docs/EVAL_UPGRADES.md](../../docs/EVAL_UPGRADES.md)) graded 101 real
  mainnet upgrades and 23 of them would have been STOP, with no known incident attached to any.
  One of them is Ref proposal #1018 (STOP: `UNVERIFIED_PENDING_CODE NEW_MONEY_PATH`), whose code is
  what `v2.ref-finance.near` runs now (`is_current_code: true` in the smoke above).
- **The structural diff misses logic-only changes.** A pending upgrade is graded on new methods and
  privileged host-call reachability against the live code, plus verification of the new hash. A
  change inside an existing method is invisible to it: of the 6 seeded cases in
  [docs/EVAL_UPGRADES.md](../../docs/EVAL_UPGRADES.md), 4 are graded as expected; "withdraw keeps
  half (logic only)" and "unchecked set_owner" are graded CAUTION where STOP was expected.
- **Controller resolution is inspect's** (owner views, near-plugins ACL roles, Sputnik policy). A
  DAO that controls the target through another controller contract, or a global-contract publisher,
  is not searched for proposals.
- **Bounded reads.** `keyhole_pending` lists the newest `limit` upgrade proposals per DAO and spends
  at most 120 tx-index requests per call looking for bytes; bytes not found count as not readable
  (CAUTION, never OK).
- `network` defaults to mainnet, or testnet for account ids ending in `.testnet`.
