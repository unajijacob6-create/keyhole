// Playwright smoke test for the built site (docs/DESIGN.md §3). Offline and deterministic: every
// RPC request is answered from the recorded fixtures in packages/core/test/fixtures.
//   node web/tests/smoke.mjs [baseUrl]   (default http://localhost:4173/keyhole/)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
    ok(/Who can change the contract/.test(h1 ?? ""), `${width}px ${scheme}: H1 present`);
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
