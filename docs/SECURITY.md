# Keyhole trust model

Keyhole is **not a security audit**. It describes trust assumptions: who can change a contract's
code, and whether the code running now is the code that was built, verified and reviewed. It does
not find bugs in business logic, and a good grade is not a statement that a contract is safe.

## What you have to trust, and how to avoid trusting it

| component | what it claims | how to re-check it without trusting Keyhole |
|---|---|---|
| `@keyhole/core` (`inspect`, `grade`) | facts read from public NEAR RPC, then a deterministic grade | Run it yourself: the CLI and the website run the same open-source library against public RPC, with no Keyhole server involved. Every reason prints the RPC request that re-checks it (`--evidence`). |
| Wasm analysis | which host functions the deployed code imports, and which exported methods reach them | `view_code`, then decode base64 and list `WebAssembly.Module.imports/exports`. The call-path part is an over-approximation. A "no import" proof is exact; "reachable" only means a path exists. |
| Owner inference | who gates an upgrade method | Heuristic and labelled **inferred**. It relies on the contract's own view methods (`get_owner`, `acl_get_super_admins`, `get_policy`, …), which a contract can implement dishonestly. |
| `ChangeObserved` / `KeyAdded` attestations | the Keyhole watcher saw a code change or a full-access key at block H (found by polling the watchlist over RPC and bisecting archival state, or from the block stream) | `view_account` (or `view_access_key_list`) at H−1 and H on an archival RPC. Anyone can repeat it. |
| `ReproducibleBuild` attestations | the declared source at rev R, built in the pinned image, produces exactly this code hash | Rebuild it: `verifier/src/rebuild.ts` and `.github/workflows/verify.yml` do this on a **public GitHub Actions runner**, and the logs are public. Our own contracts' builds also carry GitHub artifact attestations (Sigstore). **The build does not run in a TEE.** OutLayer does not compile inside its TEE either. |
| `AiReview` attestations | source with sha256 X was reviewed by model M inside an attested NEAR AI Cloud TEE; the response hashes to Y | Check the signed receipt (`data/reviews/*.json`): the EIP-191 signature over `M:sha256(request):sha256(response)` recovers to the TEE signing address in a fresh attestation report that echoed our 32-byte nonce. Verify the report itself per docs.near.ai/cloud/verification. |
| Keyhole registry contract | stores the attestations above, keyed by code hash | It stores only hashes and short summaries, never source code or full reviews. It has no upgrade method and imports no deploy host function. Keyhole grades the registry itself, so `npx keyhole inspect registry.keyhole.testnet` shows who could still redeploy it. |

## Attesters

Attestations are **signed claims by named attesters**, not facts.
- The registry owner (`keyhole.testnet`) manages the attester list.
- The current attester is `watcher.keyhole.testnet`.
- The `ReproducibleBuild` and `AiReview` entries it posts relay public CI results and TEE receipts. Each one names what to re-run.

A consumer that does not trust our attester can run its own registry. `npm run demo:attack`
deploys a private one on a fresh clone.

## The AI review: what it proves and what it does not

- The source is sent only inside the request to the TEE-hosted model. The reviewer never writes it to
  disk, and only hashes and a ≤ 280-character summary go on-chain.
- **Binding to deployed code.** The receipt proves "this source (sha256 X) was reviewed by model M
  in an attested TEE". It binds to a deployed code hash only when a reproducible build of the same
  source matches that hash. For private source the binding is labelled **owner-claimed**: nobody else
  can rebuild it.
- AI reviews miss things. Keyhole's eval (`docs/EVAL_REVIEW.md`) covers seven small seeded diffs. That is
  evidence about one model, not proof of review quality.
- A high-risk review can make the verdict stricter. A clean review only lifts STOP for a fresh,
  otherwise unverified change to CAUTION, never to OK.

## Limits, stated plainly

- Controller resolution is heuristic. It goes one level deep (two for near-plugins controllers), and
  anything not understood is reported as **unresolved**, never as safe.
- The deploy import is not proof of upgradeability. Its absence, together with no full-access keys and
  no global-by-account reference, is proof of immutability.
- Wasm analysis cannot see business logic, price-oracle trust, admin pause powers, or what a
  `function_call` to another contract will do.
- The archival search for the last code change can miss an A → B → A sequence.
- The reproducible-build verifier runs on a public CI runner, not in a TEE.
- No simulation of state changes. NEAR has no public `eth_call`-for-writes. "Before you sign" decodes
  actions and grades the contracts involved. It does not predict outcomes.
- The watcher and the website depend on public infrastructure: FastNEAR RPC, neardata.xyz,
  GitHub Actions and GitHub Pages. If they are down, Keyhole says "unknown" rather than guessing.
  - neardata's free tier allows 180 requests per minute per IP, and GitHub runners share IPs. The
    network-wide deploy feed is therefore best effort, and skipped ranges are logged.
  - Watched accounts are polled over RPC, so their changes do not depend on the block stream.
  - The poll interval (60–120 s) bounds how quickly a change on a watched account is reported.

## Responsible disclosure

If Keyhole's analysis ever surfaces something that looks like an exploitable vulnerability in a live
contract, we do not publish it. We contact the team privately first. Grades and flags describe
control and provenance only.

## Keys

- No private key is in this repository or in the website.
- Testnet scripts read keys from `~/.near-credentials` or `KEY_*` environment variables.
- The always-on watcher can post to the registry only if the repository owner adds a
  function-call key (limited to `attest`) as the `KEYHOLE_ATTESTER_KEY` secret.
