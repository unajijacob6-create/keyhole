// Playwright smoke test for the built site (docs/DESIGN.md §3). Offline and deterministic: every
// RPC request is answered from the recorded fixtures in packages/core/test/fixtures.
//   node web/tests/smoke.mjs [baseUrl]   (default http://localhost:4173/keyhole/)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { checkClaims, gradeable, read } from "./claims.mjs";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("@playwright/test"));
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? "http://localhost:4173/keyhole/";
const SHOTS = path.join(HERE, "..", "test-results", "screens");
fs.mkdirSync(SHOTS, { recursive: true });

// Merge all recorded fixtures into one request-key → answer map.
const FIX = {};
const fxDir = path.join(HERE, "../../packages/core/test/fixtures");
// usdt is loaded last so its recorded final block (which its archival answers depend on) wins.
for (const f of fs.readdirSync(fxDir).filter((f) => f.endsWith(".json.gz")).sort((a, b) => (a.startsWith("usdt") ? 1 : b.startsWith("usdt") ? -1 : 0))) Object.assign(FIX, JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(fxDir, f)))).fixtures);
const key = (body) => {
  const { method, params } = JSON.parse(body);
  return `${method} ${JSON.stringify(params)}`;
};
const fixedBlock = { header: { height: 223800000, timestamp_nanosec: String(BigInt(Date.parse("2026-11-09T18:00:00Z")) * 1_000_000n), hash: "x" } };

async function route(page) {
  await page.route(/(fastnear\.com|near\.org)/, async (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const k = key(req.postData() ?? "{}");
    const f = FIX[k];
    let body;
    if (f?.error?.result_error) body = { jsonrpc: "2.0", id: "keyhole", result: { error: f.error.result_error, logs: [] } };
    else if (f) body = f.error ? { jsonrpc: "2.0", id: "keyhole", error: f.error } : { jsonrpc: "2.0", id: "keyhole", result: f.result };
    else if (k.startsWith("block ")) body = { jsonrpc: "2.0", id: "keyhole", result: fixedBlock };
    else body = { jsonrpc: "2.0", id: "keyhole", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, message: "no fixture: UNKNOWN_ACCOUNT" } };
    await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  await page.route(/raw\.githubusercontent\.com|api\.github\.com|neardata\.xyz/, (r) => r.fulfill({ status: 200, contentType: "text/plain", headers: { "access-control-allow-origin": "*" }, body: "" }));
}

const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? "[ok]  " : "[FAIL]"} ${msg}`);
  if (!cond) failures.push(msg);
};

checkClaims(ok);
const radarProps = JSON.parse(read("data/radar.json")).daos.flatMap((d) => d.proposals);

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
for (const width of [360, 768, 1366]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await route(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    const art = await page.locator("#art").textContent();
    ok(art && art.replace(/\s/g, "").length > 300, `${width}px ${scheme}: hero art rendered (${art?.replace(/\s/g, "").length} chars) with reduced motion`);
    ok(await page.locator("#art").getAttribute("aria-hidden") === "true", `${width}px ${scheme}: art is aria-hidden`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 0, `${width}px ${scheme}: no horizontal overflow (${overflow}px)`);
    const h1 = await page.locator("h1").textContent();
    ok(/See the upgrade coming/.test(h1 ?? ""), `${width}px ${scheme}: H1 present`);
    // Guardian sections render from the recorded run and the radar snapshot, with no network.
    const replay = page.locator('[data-testid="guardian-replay"]');
    ok(await replay.count() === 1, `${width}px ${scheme}: guardian replay rendered`);
    const lead = await page.locator(".g-lead span").textContent();
    ok(/^\d+ blocks ahead$/.test(lead ?? ""), `${width}px ${scheme}: replay shows the hatch's lead over the deciding vote (${lead})`);
    await page.click("#g-next").catch(() => {});
    ok((await page.locator(".prop").count()) >= 6, `${width}px ${scheme}: radar lists proposals (${await page.locator(".prop").count()})`);
    ok((await page.locator('[data-testid="hatch-card"] .hatch-fields div').count()) === 7, `${width}px ${scheme}: hatch card decodes 7 fields`);
    // Claims on the rendered page (#15, #16, #17, #18) and the grade-button rule (#13).
    const limitsText = ((await page.locator("#limits").textContent()) ?? "").replace(/\s+/g, " ");
    ok(/ft_transfer/.test(limitsText) && /high-risk AI review alone/.test(limitsText), `${width}px ${scheme}: limits state the token-transfer gap and the AI rule`);
    const hatchText = ((await page.locator("#hatch").textContent()) ?? "").replace(/\s+/g, " ");
    ok(!/nowhere else/.test(hatchText) && /decides where the funds go/.test(hatchText) && /already landed/.test(hatchText), `${width}px ${scheme}: hatch copy says the venue's code decides where funds go, and that it fires on landed code`);
    const radarHead = ((await page.locator("#radar .g-head").textContent()) ?? "").replace(/\s+/g, " ");
    ok(/latest 12 per DAO/.test(radarHead) && !/Every upgrade proposal/.test(radarHead), `${width}px ${scheme}: radar scopes its list (latest 12 per DAO)`);
    const cards = await page.locator(".prop").evaluateAll((els) => els.map((e) => ({ dao: e.dataset.dao, id: Number(e.dataset.id), btn: Boolean(e.querySelector(".grade-btn")) })));
    const wrong = cards.filter((c) => c.btn !== gradeable(radarProps.find((p) => p.dao === c.dao && p.id === c.id)));
    ok(cards.length > 0 && wrong.length === 0, `${width}px ${scheme}: "Grade it in your browser" only on open proposals or executed ones with a known replaced-code block (${cards.filter((c) => c.btn).length} of ${cards.length})${wrong.length ? `; wrong: ${wrong.map((c) => c.id).join(",")}` : ""}`);
    for (const id of ["watch", "radar", "hatch", "limits"]) await page.locator(`#${id}`).screenshot({ path: path.join(SHOTS, `${id}-${width}-${scheme}.png`) });
    await page.screenshot({ path: path.join(SHOTS, `home-${width}-${scheme}.png`), fullPage: false });
    // Inspect a fixture account through the search box.
    await page.fill("#q", "usdt.tether-token.near");
    await page.press("#q", "Enter");
    await page.waitForSelector('[data-testid="report"]', { timeout: 30000 });
    const verdict = await page.locator('[data-testid="report"] .verdict').first().getAttribute("data-verdict");
    const cls = await page.locator('[data-testid="report"] .class-tag').first().textContent();
    ok(verdict === "CAUTION" && cls === "GOVERNED", `${width}px ${scheme}: usdt.tether-token.near → ${verdict} ${cls} (expected CAUTION GOVERNED)`);
    const glyph = await page.locator('[data-testid="report"] .verdict').first().textContent();
    ok(/\[!!\]\s*CAUTION/.test(glyph ?? ""), `${width}px ${scheme}: verdict shows glyph and word`);
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow2 <= 0, `${width}px ${scheme}: no horizontal overflow on the report (${overflow2}px)`);
    await page.locator('[data-testid="report"]').screenshot({ path: path.join(SHOTS, `report-${width}-${scheme}.png`) });
    ok(errors.length === 0, `${width}px ${scheme}: no console errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
    await ctx.close();
  }
}
// The replay's first step qualifies the Ref/Burrow comparison (#18).
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await route(page);
  await page.goto(BASE, { waitUntil: "networkidle" });
  for (let k = 0; k < 8; k++) await page.click("#g-prev");
  const detail = (await page.locator("#g-detail").textContent()) ?? "";
  ok(/Ref and Burrow/.test(detail) && /not a token one/.test(detail), `replay step 1 qualifies the Ref and Burrow comparison`);
  await ctx.close();
}
// Keyboard: Tab reaches the input and the Inspect button with a visible focus ring.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await route(page);
  await page.goto(BASE, { waitUntil: "networkidle" });
  let reached = false;
  for (let i = 0; i < 15 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.id === "q");
  }
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  ok(reached && outline !== "none", `keyboard reaches the search input with a visible focus ring (outline ${outline})`);
  const size = await page.locator("#inspect-form button").boundingBox();
  ok(size && size.height >= 44 && size.width >= 44, `Inspect button is at least 44x44 (${size?.width.toFixed(0)}x${size?.height.toFixed(0)})`);
  await ctx.close();
}
await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall smoke checks passed");
process.exit(failures.length ? 1 : 0);
