# Keyhole design system

Keyhole should read like a precise instrument: calm, dense with evidence, nothing decorative that
carries no meaning. This file is the contract for `web/`. The Playwright smoke test
(`web/tests/smoke.spec.ts`) checks the rules that a machine can check.

## 1. Hero

- A large ASCII keyhole drawn with **base58 characters of a real code hash** fetched live from
  mainnet (it rotates through the watchlist). On load the characters resolve from noise into the
  keyhole in ≤ 1.2 s.
- The keyhole's aperture holds a 4–6 line monospace **live feed**: real events only (mainnet
  `DeployContract` actions from the neardata block stream, and watchlist status lines computed
  from RPC). There is never placeholder data. While nothing is loaded the feed says so.
- Copy: H1 "Who can change the contract you're about to trust?" plus one supporting sentence under 25
  words that states a fact. One primary action: an input ("Paste a NEAR account or transaction")
  and an **Inspect** button. At most two quiet secondary links: "Watch the upgrade attack" and
  "Trust table".
- Below the fold: the trust table, how it works (3 steps), the attack replay, the before-you-sign
  decoder, and the API/SDK snippet.

## 2. Rules

### Accessibility
- The ASCII art is real text inside `<pre aria-hidden="true">`. The H1 and a visually hidden
  description carry the meaning. Text is never rendered as an image.
- WCAG 2.2 AA: text contrast ≥ 4.5:1, UI components and large text ≥ 3:1. Focus rings are always
  visible (`:focus-visible`, 2 px outline in the accent colour, 2 px offset). Everything works from the
  keyboard. Targets are at least 44 × 44 px.
- A verdict is never shown by colour alone. The same component always shows glyph and word:
  `[OK] OK`, `[!!] CAUTION`, `[XX] STOP`.

### Responsive ASCII
- The art is authored on a fixed grid: 72 columns on desktop, plus a separate 36-column art for
  viewports ≤ 480 px. The art is swapped, never scaled below about 9 px.
- `font-size: min(14px, calc((100vw - 32px) / (COLS * 0.6)))`, `line-height: 1.05`,
  `letter-spacing: 0`.
- No horizontal scroll at 360 px. Side gutters are 16 px on phones.

### Motion
- Only two things move: the hero's resolve animation and the live feed.
- One `<pre>`, whose `textContent` is updated in `requestAnimationFrame`, throttled to ≤ 30 fps.
- Paused when the tab is hidden (`visibilitychange`) or the hero is off-screen (`IntersectionObserver`).
- With `prefers-reduced-motion: reduce`: the final frame is drawn immediately and nothing animates.
  The feed text only changes when new data arrives.

### Type
- Two families, both self-hosted through `@fontsource` with `font-display: swap`: **JetBrains Mono**
  for data and art, **Inter** for prose.
- Modular scale 1.25: 12.8 / 16 / 20 / 25 / 31.25 px. H1 is `clamp(2rem, 5vw, 4rem)`. Body text is 17 px.
  Prose is at most 68ch wide.

### Colour
Tokens live on `:root`. There is a light theme and a dark theme: the system theme by default, plus a
toggle stored in `localStorage`.

| token | light | dark | use |
|---|---|---|---|
| `--bg` | #fbfbfa | #0f1112 | page |
| `--surface` | #ffffff | #161a1c | panels |
| `--border` | #d9dcdf | #2a3033 | panel borders |
| `--text` | #16191b | #e6e8e9 | body (≥ 13:1) |
| `--muted` | #545b61 | #a2a9ae | secondary text (≥ 6:1) |
| `--faint` | #8a9196 | #6b7378 | ASCII noise only (decorative, aria-hidden) |
| `--accent` | #1f5fbf | #7fb0ff | primary action, links, focus |
| `--ok` | #1d6b3a | #5fd38d | OK verdict only |
| `--caution` | #8a5a00 | #f2c14e | CAUTION verdict only |
| `--stop` | #b42318 | #ff7a6e | STOP verdict only |

Neutral greys carry the page. Green, amber and red are reserved for verdicts, and the accent for the
primary action and links. There are no decorative gradients.

### Layout
- A 12-column grid, max content width 1200 px, gutters 16 px on phones and 24 px from 768 px up.
- Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96. Nothing else.
- Panels use 1 px CSS borders in `--border` with a 6 px radius. Box-drawing characters (┌─┐) appear
  only as small accents inside monospace text, never as layout.

### Hierarchy and disclosure
- An inspection shows the **verdict first**, then the reasons, then the raw evidence (keys,
  exports, hashes, blocks) in `<details>` sections.
- Reasons are grouped by the question they answer: **Who can change it? / Is it the reviewed code?
  / What changed?**
- Every claim links to its evidence: an RPC re-check command (copyable `curl`), an explorer link
  or a block height.

### UX laws applied
- **Jakob:** the input behaves like a search bar. Enter submits, and the URL (`#/inspect/<account>`)
  can be shared.
- **Hick:** the hero offers three choices or fewer.
- **Fitts:** the Inspect button is the largest target in the hero.
- **Miller:** results come in groups of seven or fewer. Longer lists collapse ("show all 38 methods").
- **Gestalt (proximity and similarity):** signals are grouped by question, and the same verdict
  component is used everywhere.
- **Aesthetic-usability:** restraint over ornament.

### Feedback states
- Loading: an ASCII spinner `[|/-\]` and monospace skeleton lines that name the step running
  ("fetching code… analysing wasm… resolving owner…").
- Errors: the cause in plain words plus a Retry button.
- Empty states teach: "Try intents.near, usdt.tether-token.near or vault.keyhole.testnet".

### Performance
- LCP < 2.5 s on a mid-range phone. The hero text and the static frame of the art are in the HTML. JS stays
  under 200 KB gzip, excluding the inspected wasm.
- Fetching and compiling the inspected wasm happens after first paint.
- Lighthouse accessibility ≥ 95.

## 3. Verification
`npm run test:web` builds the site and runs Playwright at 360, 768 and 1366 px, in light and
dark. It checks for no horizontal overflow, no console errors, a hero that renders with reduced motion,
and the correct verdict for an inspected fixture account. Screenshots are saved to
`web/test-results/screens/`.
