# Control-class eval (2026-11-09)

Run with `npm run eval` at 2026-11-09 18:25 UTC against live public RPC. The corpus has 21 accounts:
- 12 mainnet contracts, hand-labelled only where the controller is established by protocol facts or by source verified to match the deployed code;
- 9 testnet fixtures whose class is true by construction (`scripts/eval-fixtures.ts`).

**19/21 correct (90%); 0 dangerous miss(es)** (Keyhole reporting a stronger assurance than the truth). Conservative misses (a weaker assurance, usually UNRESOLVED) are listed below.

| account | source | expected | Keyhole | result |
|---|---|---|---|---|
| 17208628f84f…e36133a1 | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| aurora | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| social.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| game.hot.tg | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| x.paras.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| tkn.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| sputnik-dao.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| token.sweat | mainnet, hand-labelled | GOVERNED | GOVERNED | ok |
| omni.bridge.near | mainnet, hand-labelled | GOVERNED | GOVERNED | ok |
| ref-finance.sputnik-dao.near | mainnet, hand-labelled | GOVERNED | GOVERNED | ok |
| jau.sputnik-dao.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| v2-verifier.sourcescan.near | mainnet, hand-labelled | CUSTODIAL | CUSTODIAL | ok |
| fx-immutable….testnet | testnet fixture, by construction | IMMUTABLE | IMMUTABLE | ok |
| fx-fak.kh-fx-lcic22.testnet | testnet fixture, by construction | CUSTODIAL | CUSTODIAL | ok |
| fx-fconly.kh-fx-lcic22.testnet | testnet fixture, by construction | IMMUTABLE | IMMUTABLE | ok |
| fx-owner-key….testnet | testnet fixture, by construction | CUSTODIAL | CUSTODIAL | ok |
| fx-owner-dao….testnet | testnet fixture, by construction | GOVERNED | GOVERNED | ok |
| fx-owner-dao….testnet | testnet fixture, by construction | CUSTODIAL | CUSTODIAL | ok |
| fx-hidden-ow….testnet | testnet fixture, by construction | CUSTODIAL | UNRESOLVED | conservative miss |
| fx-nocode.kh-fx-lcic22.testnet | testnet fixture, by construction | NO_CODE | NO_CODE | ok |
| fx-owner-gon….testnet | testnet fixture, by construction | CUSTODIAL | UNRESOLVED | conservative miss |

Ground-truth evidence for every row is in `eval/corpus.json`. Excluded from accuracy because the truth could not be established:
- intents.near: upgrade gated by roles DAO (intents.sputnik-dao.near, 3 of 5) and Upgrader (ctl-intents.near, a controller contract whose own roles were not fully analysed)
- wrap.near: deploy host function linked, no upgrade method in exports; deployed code is not source-verified, so absence of a hidden path cannot be established
- usdt.tether-token.near: owner() is a 2-of-3 multisig, but the source of `upgrade` is not public, so the gate cannot be confirmed

Limits of this eval:
- Labels describe the first level of control. A DAO's own code can itself be upgradable (Sputnik DAOs link `deploy_contract`, and testnet's `sputnik-v2.testnet` factory holds full-access keys); Keyhole resolves one level and says so.
- "2 approvals" counts accounts, not people: two council accounts may be run by one person.
- Two testnet fixtures depend on third-party state (a testnet DAO's policy, an unregistered account name); `scripts/eval-fixtures.ts` re-checks both on every run.
