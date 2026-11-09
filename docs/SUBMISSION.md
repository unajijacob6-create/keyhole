# Submission draft (no personal data in this file)

Re-read https://nearhackathon.com/HACKATHON.md before submitting. The deadline is 2026-11-14 23:59 UTC; we plan to submit by 18:00 UTC.

**Fields the human decides.** Never guess these, and never commit them:
- project name
- lead name
- email
- team size
- NEAR payout account (mainnet)
- demo post URL
- consent to the contact notice

**Proposed by the builder** (confirm before sending):
- **projectName:** Keyhole
- **projectUrl:** https://github.com/unajijacob6-create/keyhole
- **tracks:** `security` (primary), `privacy` (TEE review ships), `open`
- **idea** (≈ 1,000 characters; ≤ 2,000 allowed):

> On NEAR, a contract with no keys can still replace its own code, and no wallet or explorer tells you who holds that power. Keyhole does. For any account it reads public RPC in your browser or CLI and answers two questions:
> 1. Who can change this code? It reports full-access keys, upgrade methods found in the wasm call graph, and owners resolved to Sputnik DAO thresholds, multisigs or near-plugins roles.
> 2. Is this the code that was verified and reviewed? It checks NEP-330 build info, SourceScan at the current hash, a CI rebuild from on-chain build info, and a private AI review in a NEAR AI Cloud TEE with a re-verifiable receipt.
>
> A deterministic grade gives OK, CAUTION or STOP, with the RPC call behind every reason. A watcher follows the block stream, including receipts and meta-transactions, and records code changes in a registry contract keyed by code hash. guardCall makes agents refuse STOP in code. In the testnet demo, a silent redeploy is caught within seconds and the agent refuses. The eval shows 0 dangerous misses. Not an audit.

The submission request is sent only after the human confirms the exact JSON payload in chat. `requestId` is generated once and reused on any retry.
