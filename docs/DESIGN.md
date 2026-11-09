# Keyhole design system

Keyhole should read like a precise instrument: calm, dense with evidence, nothing decorative that
carries no meaning. This file is the contract for `web/`. The Playwright smoke test
(`web/tests/smoke.spec.ts`) checks the rules that a machine can check.

## 1. Visual direction (revised 2026-11-09 at the owner's request)

Soft lavender and periwinkle, generous whitespace and rounded cards. Images are illustrations
generated with **FLUX.2 on NEAR AI Cloud** (`npm run gen:images`, prompts in
`scripts/gen-images.ts`): a meadow hero, a key, a vault, a pavilion, a glowing keyhole. The site
uses only real, dated numbers. No customer counts, no partner logos, no implied endorsements:
the "Reads public data from" row names, in plain text, the services Keyhole actually queries.

- **Hero:** a rounded card (28 px) over the generated meadow.
  - Three SVG keyhole coins sit *in* the flowers: a masked copy of the image is layered on top of them.
  - The headline is serif, with the last word in italics.
  - It has one supporting sentence and a glass search pill with a dark "Inspect" button, plus at most two quiet links.
- **Below:** "What is Keyhole?" (serif H2 plus a pill), then three cards, one per question Keyhole answers: a light card with the key image and two deep-indigo cards. Then a stats band (real numbers, count-up), then the live ASCII keyhole card.
- **The ASCII keyhole** (base58 characters of a live code hash, with the live feed inside) moves into a dark "Live from NEAR mainnet" card.

## 2. Rules

### Accessibility
- The ASCII art is real text inside `<pre aria-hidden="true">`. The H1 and a visually hidden
  description carry the meaning. Decorative images have `alt=""`.
- WCAG 2.2 AA: text contrast ≥ 4.5:1, UI components ≥ 3:1. Focus rings are always visible. Everything works
  from the keyboard. Targets are at least 44 × 44 px.
- A verdict is never shown by colour alone: `[OK] OK`, `[!!] CAUTION`, `[XX] STOP`.

### Responsive
- The ASCII art uses a 72-column grid on desktop and a 36-column grid at ≤ 480 px. It is swapped, not shrunk.
- No horizontal scroll at 360 px. Gutters are 16 px on phones and 24 px from 768 px up. The max content width is 1240 px.
- Below 640 px the search pill stacks. Below 1100 px the small floating coin is hidden.

### Motion
Purposeful and quiet. **Everything stops under `prefers-reduced-motion: reduce`**, which shows the
final state.
- **Hero:** the copy rises in on load (staggered, ≤ 1 s). The coins float and catch a light sweep. The meadow
  drifts slowly (26 s). The coins follow the pointer with a few pixels of parallax (fine pointers only).
- **Page:** sections fade up as they enter the viewport (IntersectionObserver). The stats count up.
  The nav turns to frosted glass on scroll. Cards lift on hover, and images zoom slightly.
- **Signals:** the STOP badge pulses. The sources row scrolls as a marquee and pauses on hover. The attack replay
  can auto-play.
- **ASCII hero:** one `<pre>`, updated in `requestAnimationFrame` at ≤ 30 fps. It pauses when hidden or off-screen.

### Type
- Display: **Instrument Serif**, for H1, H2, card titles and step numbers.
- UI and body: **Manrope** (variable).
- Data, art and code: **JetBrains Mono**.
- All three are self-hosted through `@fontsource` with `font-display: swap`. The H1 is `clamp(2.6rem, 6.4vw, 5.6rem)`.

### Colour
Tokens live on `:root`. There are light and dark themes: the system theme by default, plus a toggle.
- **Neutral and structural colours:** lavender neutrals (`--page #eceaf6`, `--surface #fff`, `--surface-2 #f0eefb`), deep indigo
  `--ink #1c1935` and `--night #221e3d` for dark cards and buttons.
- **Verdict colours:** `--ok`, `--caution` and `--stop` are reserved for verdicts and keep the same values (checked with
  `scratch/contrast.py`: ≥ 5.7:1 on their badges).
- **The hero card** stays light in both themes, like a picture on the page.

### Layout
- A 12-column grid.
- The spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Radii: 12 / 20 / 28 px.
- Shadows are soft, lavender-tinted and single-layer.

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
- Fetching and compiling the inspected wasm happens after first paint. The hero image is preloaded
  (WebP, 84 KB at 1600 px). Other images are lazy-loaded.
- Lighthouse accessibility ≥ 95. The redesign measured 100, with performance 95 on mobile.

## 3. Verification
`npm run test:web` builds the site and runs Playwright at 360, 768 and 1366 px, in light and
dark. It checks for no horizontal overflow, no console errors, a hero that renders with reduced motion,
and the correct verdict for an inspected fixture account. Screenshots are saved to
`web/test-results/screens/`.
