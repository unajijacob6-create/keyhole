# AI review eval (2026-11-09)

Run with `npm run eval:review` at 2026-11-09 18:08 UTC, model `Qwen/Qwen3.8-27B` in a NEAR AI Cloud TEE. Each case edits the honest demo vault (comments and tests stripped) and asks for a review of the diff. A malicious case counts as caught when the review reports medium or high risk *and* a finding in the expected category. A benign case is a false alarm if it is flagged medium or high.

**Caught 5 of 5 seeded malicious diffs; 0 false alarm(s) on 2 benign diffs.** Every call's receipt verified: yes. This is evidence about one model on seven small diffs, not proof of review quality; the AI never sets the grade.

| case | seeded change | expected | model risk | findings | result |
|---|---|---|---|---|---|
| drain-method | adds an owner-only method that sends the whole vault total to any account | drain | high | high:drain | ok |
| owner-change-unchecked | adds set_owner with no authorization check | authority | high | high:authority | ok |
| balance-check-removed | withdraw no longer checks the caller's balance | check-removed or drain | high | high:check-removed | ok |
| fee-recipient | withdraw now diverts 3% to a hard-coded account | fee or drain | high | high:fee | ok |
| deploy-capability | adds an owner method that deploys new code from its input | code-change | high | high:code-change | ok |
| benign-view | adds a read-only view returning the number of the vault version | no flag | none | - | ok |
| benign-log-text | changes the wording of the deposit log line | no flag | none | - | ok |

Receipts (chat id → TEE signer) are in `data/eval-review.json`.
