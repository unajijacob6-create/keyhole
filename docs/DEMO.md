# Demo video (≤ 90 s) and X post — drafts

The video is captured with Playwright from the real site and the real terminal run. Nothing in it
is mocked. Every number shown must be re-checked on the day it is published.

## Video script (target 85 s)

| t | screen | narration / caption |
|---|---|---|
| 0–10 s | Site hero: the keyhole drawn from a live code hash, with the feed ticking. Paste `usdt.tether-token.near` → Inspect. | "On NEAR, a contract with no keys can still change its own code. Who holds that power? Paste an account." |
| 10–20 s | Report: **[!!] CAUTION · GOVERNED**. "Upgrade gated by tether.multisafe.near: 2 of 3 must confirm. Current code is not source-verified." Expand Re-check. | "USDT can be upgraded by a 2-of-3 multisig, and the code running now isn't source-verified. Every line comes with the RPC call that proves it." |
| 20–60 s | Terminal: `npm run demo:attack`, recorded run. Side by side with the website's attack replay: **CAUTION → STOP**. | "A vault whose owner kept one key. Keyhole says CAUTION, and the agent deposits. The owner silently redeploys. Seconds later the watcher sees it in the block stream and writes it to the registry, and the diff shows a new `sweep` method. Verdict: STOP. The agent's next deposit is refused in code, before signing." |
| 60–75 s | The vault's **What was verified** panel: the TEE review receipt (model, TEE signer, nonce echoed, signature verified), plus the reproducible build of v1. | "A private review inside a NEAR AI Cloud TEE flags the drain. Its receipt verifies offline, and only hashes go on-chain." |
| 75–85 s | Trust table: 24 NEAR contracts, sorted by verdict. | "Here are NEAR's major contracts: who can change them, and whether the code is verified." |
| 85–90 s | Back to the input. | "Paste any account. Keyhole is open source, and it is not an audit." |

## X post draft

> On NEAR, a contract with no keys can still change its own code. Nobody tells you before you sign.
>
> Keyhole shows who can replace a contract's code (keys, owner, DAO threshold) and whether the code running now is the verified code. It works from public RPC, and every claim comes with its re-check.
>
> In the demo, an owner silently redeploys a vault. The watcher catches it within seconds, Keyhole says STOP, and the agent refuses to deposit, in code.
>
> NEAR makes this possible: access keys vs function-call keys, wasm host functions, NEP-330 build info, Sputnik DAO policies, global contracts, NEAR AI Cloud TEE attestations, and a registry other apps can query.
>
> Built at #NEARHackathon @NEARProtocol
> Live: https://unajijacob6-create.github.io/keyhole/
> Code: https://github.com/unajijacob6-create/keyhole
> Paste your contract, and tell me if the grade is wrong.

Optional tags: @NearBuilders @NearLegion. The human posts it.
