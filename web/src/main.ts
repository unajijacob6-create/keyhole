import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./styles.css";
import { inspect, decodeTransactions, Rpc, type KeyholeReport } from "@keyhole/core";
import { mountHero } from "./hero.ts";
import { renderReport, verdictBadge, esc, wireCopy } from "./render.ts";
import survey from "../../data/survey.json";
import demoRun from "../../data/demo-run.json";

type Row = (typeof survey.rows)[number];
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const mainnet = new Rpc({ network: "mainnet" });

// ── theme ──
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("kh-theme", next);
  } catch {
    /* storage may be unavailable */
  }
});
wireCopy(document.body);

// ── hero ──
const hero = mountHero($<HTMLPreElement>("#art"), $("#art-caption"));
const short = (a: string, n: number) => (a.length > n ? a.slice(0, n - 1) + "…" : a);
const hhmm = () => new Date().toISOString().slice(11, 19);
let feedEvents: string[] = [];
let statusLines: string[] = [];
let blockLine = "connecting to mainnet RPC…";
const compact = () => matchMedia("(max-width: 480px)").matches;
function pushFeed() {
  hero.setFeed([blockLine, ...feedEvents.slice(0, 2), ...statusLines].slice(0, compact() ? 4 : 6));
}
function statusLine(r: Row) {
  const lc = r.lastChange?.status === "found" ? `chg ${r.lastChange.date?.slice(5)}` : r.lastChange?.status === "unchanged-since" ? "" : "";
  const n = r.controller.match(/(\d+) of (\d+)/);
  const ctl =
    r.class === "CUSTODIAL" ? (r.fullAccessKeys ? `${r.fullAccessKeys} FA key${r.fullAccessKeys > 1 ? "s" : ""}` : "1 key") : r.class === "GOVERNED" ? (n ? `${r.controller.startsWith("multisig") ? "msig" : "DAO"} ${n[1]}/${n[2]}` : "governed") : r.class === "IMMUTABLE" ? "immutable" : "unresolved";
  return compact() ? `${short(r.account, 14)} ${ctl}` : `${short(r.account, 20).padEnd(20)} ${ctl}${lc ? " " + lc : ""}`;
}
async function startHero() {
  const rows = survey.rows.filter((r) => r.codeHash && r.codeSource === "local");
  let i = Math.floor(Math.random() * rows.length);
  const show = async () => {
    const r = rows[i % rows.length];
    try {
      const a = await mainnet.viewAccount(r.account);
      hero.setHash(a.code_hash, r.account);
    } catch {
      hero.setHash(r.codeHash!, `${r.account} (snapshot)`);
    }
    statusLines = [...rows.slice(i % rows.length), ...rows].slice(0, 4).map(statusLine);
    pushFeed();
    i++;
  };
  await show();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setInterval(show, 15000);
  // Live block height (header only) and the watcher's public deploy feed.
  const tick = async () => {
    try {
      const b = await mainnet.call<any>("block", { finality: "final" });
      blockLine = compact() ? `block ${b.header.height.toLocaleString("en-US")}` : `${hhmm()} final #${b.header.height.toLocaleString("en-US")}`;
    } catch {
      blockLine = "mainnet RPC unreachable";
    }
    pushFeed();
  };
  // A fresh Rpc per tick so finality reads are not cached.
  setInterval(() => {
    (mainnet as any).cache?.clear?.();
    tick();
  }, 5000);
  tick();
  try {
    const r = await fetch("https://raw.githubusercontent.com/unajijacob6-create/keyhole/feed/feed-mainnet.jsonl", { cache: "no-store" });
    if (r.ok) {
      const lines = (await r.text()).trim().split("\n").filter(Boolean).slice(-20).reverse();
      feedEvents = lines.map((l) => JSON.parse(l)).filter((e) => e.kind !== "AddFullAccessKey").slice(0, 2).map((e) => `${new Date(e.timestampMs).toISOString().slice(5, 16).replace("T", " ")} ${short(e.account, compact() ? 10 : 22)} ${e.kind === "DeployContract" ? "deployed code" : e.kind}`);
      pushFeed();
    }
  } catch {
    /* feed is optional */
  }
}
startHero();

// ── inspect ──
const resultEl = $("#result");
const SPIN = ["|", "/", "-", "\\"];
async function runInspect(account: string) {
  resultEl.hidden = false;
  const steps = ["fetching account and keys", "fetching code", "analysing wasm imports and call paths", "resolving owner", "checking NEP-330 and SourceScan", "querying the Keyhole registry", "searching archival history for the last code change"];
  let n = 0;
  const t0 = performance.now();
  const paint = () => {
    resultEl.innerHTML = `<div class="panel"><p class="spinner" role="status">[${SPIN[n % 4]}] Inspecting ${esc(account)}… ${((performance.now() - t0) / 1000).toFixed(0)} s</p><div class="skeleton">${steps.map((s, i) => `${i <= n / 4 ? "▸" : "·"} ${esc(s)}`).join("<br>")}</div></div>`;
  };
  paint();
  const timer = setInterval(() => (n++, paint()), 250);
  try {
    const network = account.endsWith(".testnet") ? "testnet" : "mainnet";
    const r: KeyholeReport = await inspect(account, { network });
    clearInterval(timer);
    resultEl.innerHTML = renderReport(r);
    document.title = `${r.grade.verdict} · ${account} — Keyhole`;
  } catch (e) {
    clearInterval(timer);
    resultEl.innerHTML = `<div class="panel error" role="alert"><p><strong>Could not inspect ${esc(account)}.</strong> ${esc((e as Error).message)}</p><p class="muted">The public RPC may be rate-limiting or unreachable. Nothing was concluded.</p><button class="secondary" type="button" id="retry">Retry</button></div>`;
    $("#retry").addEventListener("click", () => runInspect(account));
  }
  resultEl.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function route() {
  const m = location.hash.match(/^#\/inspect\/(.+)$/);
  if (m) {
    const acct = decodeURIComponent(m[1]).trim().toLowerCase();
    $<HTMLInputElement>("#q").value = acct;
    runInspect(acct);
  }
}
$("#inspect-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("#q").value.trim();
  if (!q) {
    resultEl.hidden = false;
    resultEl.innerHTML = `<div class="panel"><p>Paste a NEAR account, e.g. <a href="#/inspect/intents.near">intents.near</a>, <a href="#/inspect/usdt.tether-token.near">usdt.tether-token.near</a> or <a href="#/inspect/vault.keyhole.testnet">vault.keyhole.testnet</a>. Or paste a transaction JSON to decode it before signing.</p></div>`;
    return;
  }
  if (q.startsWith("{") || q.startsWith("[")) {
    $<HTMLTextAreaElement>("#tx-input").value = q;
    location.hash = "#sign";
    runDecode();
    return;
  }
  const target = `#/inspect/${encodeURIComponent(q.toLowerCase())}`;
  if (location.hash === target) route();
  else location.hash = target;
});
addEventListener("hashchange", route);

// ── trust table ──
const tableEl = $("#table");
let sortKey: keyof Row | "verdictRank" = "verdictRank";
let sortDir = 1;
const rank: Record<string, number> = { STOP: 0, CAUTION: 1, OK: 2 };
const live = new Map<string, Partial<Row>>();
function renderTable() {
  const rows = survey.rows.map((r) => ({ ...r, ...live.get(r.account) }));
  rows.sort((a, b) => {
    const va = sortKey === "verdictRank" ? rank[a.verdict] * 10 + ["CUSTODIAL", "UNRESOLVED", "GOVERNED", "IMMUTABLE", "NO_CODE"].indexOf(a.class) : String(a[sortKey] ?? "");
    const vb = sortKey === "verdictRank" ? rank[b.verdict] * 10 + ["CUSTODIAL", "UNRESOLVED", "GOVERNED", "IMMUTABLE", "NO_CODE"].indexOf(b.class) : String(b[sortKey] ?? "");
    return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
  });
  const th = (k: string, label: string) => `<th scope="col" aria-sort="${sortKey === k ? (sortDir > 0 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${k}">${label}${sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : ""}</button></th>`;
  const lc = (r: Row) => (r.lastChange?.status === "found" ? `${r.lastChange.date}` : r.lastChange?.status === "unchanged-since" ? `before ${r.lastChange.sinceDate}` : "unknown");
  const liveCount = live.size;
  tableEl.innerHTML = `
    <h2 id="table-h">Trust table: ${survey.rows.length} NEAR contracts</h2>
    <p class="muted">Who can replace the code, and whether the code running now is source-verified. Neutral description, not an audit or a judgement of the teams. Owner resolution is inferred from each contract's own view methods.</p>
    <div class="table-meta"><span>Snapshot ${esc(survey.generatedAt.slice(0, 16).replace("T", " "))} UTC, block ${survey.atBlock.toLocaleString("en-US")}.</span><span role="status">${liveCount ? `Re-checked live in your browser: ${liveCount}/${survey.rows.length}.` : "Live re-check starts after load."}</span></div>
    <div class="table-wrap"><table>
      <thead><tr>${th("account", "Contract")}${th("verdictRank", "Verdict")}${th("controller", "Who can change the code")}${th("sourcescan", "Verified source")}${th("nep330", "NEP-330")}<th scope="col">Last code change</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
        <td class="acct" data-label="Contract"><a href="#/inspect/${encodeURIComponent(r.account)}">${esc(short(r.account, 34))}</a></td>
        <td data-label="Verdict">${verdictBadge(r.verdict)} <span class="class-tag">${esc(r.class)}</span></td>
        <td class="ctl" data-label="Who">${esc(r.controller)}</td>
        <td data-label="Verified">${esc(r.sourcescan ?? "-")}</td>
        <td data-label="NEP-330">${esc(r.nep330 ?? "-")}</td>
        <td data-label="Last change">${esc(lc(r))}</td></tr>`,
        )
        .join("")}</tbody></table></div>
    <p class="small muted">Verdict rules: <a href="https://github.com/unajijacob6-create/keyhole/blob/main/docs/GRADING.md">GRADING.md</a>. Re-run with <code>npm run survey</code>; each row: <code>npx keyhole inspect &lt;account&gt; --evidence</code>.</p>`;
  tableEl.querySelectorAll<HTMLButtonElement>("button[data-sort]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.sort as typeof sortKey;
      sortDir = sortKey === k ? -sortDir : 1;
      sortKey = k;
      renderTable();
    }),
  );
}
renderTable();
async function liveRecheck() {
  const queue = [...survey.rows];
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift()!;
      try {
        const r = await inspect(row.account, { network: "mainnet", history: false });
        live.set(row.account, { verdict: r.grade.verdict, class: r.grade.class, sourcescan: r.sourcescan?.status ?? row.sourcescan });
        renderTable();
      } catch {
        /* keep the snapshot row */
      }
    }
  };
  await Promise.all([worker(), worker()]);
}
// Start live re-checks once the page is idle, so first paint and the hero stay fast.
setTimeout(() => ("requestIdleCallback" in window ? (window as any).requestIdleCallback(() => liveRecheck(), { timeout: 5000 }) : liveRecheck()), 2500);

// ── how it works ──
$("#how").innerHTML = `
  <h2 id="how-h">How it works</h2>
  <ol class="steps">
    <li><h3>Read the chain</h3><p>Your browser asks public NEAR RPC for the account, its access keys and its code. No Keyhole server is involved; the same library runs in the CLI.</p></li>
    <li><h3>Analyse the wasm</h3><p>Keyhole lists the host functions the code imports (deploy, add full-access key, global contracts), traces which methods reach them, and asks the contract who owns it.</p></li>
    <li><h3>Grade it, with receipts</h3><p>A deterministic rule set grades who can change the code and whether it is the verified code. Each reason comes with the RPC call that re-checks it.</p></li>
  </ol>`;

// ── attack replay ──
const attackEl = $("#attack");
type DemoStep = { t: number; step: number; title: string; lines: string[]; state?: { verdict: string; class: string; flags: string[]; headline: string; reasons: string[] } };
const run = demoRun as unknown as { recordedAt: string; vault: string; steps: DemoStep[]; links: Record<string, string> };
let replayIdx = 0;
function renderReplay() {
  if (!run.steps?.length) {
    attackEl.innerHTML = `<h2 id="attack-h">The upgrade attack, replayed</h2><p class="muted">No recorded run yet. Run <code>npm run demo:attack</code>.</p>`;
    return;
  }
  const upto = run.steps.slice(0, replayIdx + 1);
  const lastState = [...upto].reverse().find((s) => s.state)?.state;
  attackEl.innerHTML = `
    <h2 id="attack-h">The upgrade attack, replayed</h2>
    <p>A real run of <code>npm run demo:attack</code> on testnet, recorded ${esc(run.recordedAt.slice(0, 16).replace("T", " "))} UTC. An honest vault keeps one full-access key; that key silently redeploys it with a <code>sweep</code> method. Step through it, or <a href="#/inspect/${esc(run.vault)}">inspect ${esc(run.vault)} live</a>.</p>
    <div class="replay-controls" role="group" aria-label="Replay controls">
      <button class="secondary" type="button" id="rp-prev" ${replayIdx === 0 ? "disabled" : ""}>← Previous</button>
      <button class="secondary" type="button" id="rp-next" ${replayIdx >= run.steps.length - 1 ? "disabled" : ""}>Next step →</button>
      <button class="secondary" type="button" id="rp-all">Show all</button>
      <span class="muted small" role="status">Step ${replayIdx + 1} of ${run.steps.length}: ${esc(run.steps[replayIdx].title)}</span>
    </div>
    <div class="replay">
      <div class="term-col"><pre class="term" aria-label="Terminal output">${upto.map((s) => `<span class="dim">── ${s.step}. ${esc(s.title)}</span>\n${s.lines.map(esc).join("\n")}`).join("\n\n")}</pre></div>
      <div class="state-col">${lastState ? `<div class="panel" data-testid="replay-state">${verdictBadge(lastState.verdict, "lg")} <span class="class-tag">${esc(lastState.class)}</span><p class="headline">${esc(lastState.headline)}</p>${lastState.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(" ")}<ul class="reasons">${lastState.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <p class="small muted">${Object.entries(run.links ?? {}).map(([k, v]) => `<a href="${esc(v)}">${esc(k)}</a>`).join(" · ")}</p></div>
    </div>`;
  $("#rp-prev").addEventListener("click", () => ((replayIdx = Math.max(0, replayIdx - 1)), renderReplay()));
  $("#rp-next").addEventListener("click", () => ((replayIdx = Math.min(run.steps.length - 1, replayIdx + 1)), renderReplay()));
  $("#rp-all").addEventListener("click", () => ((replayIdx = run.steps.length - 1), renderReplay()));
}
renderReplay();

// ── before you sign ──
const SAMPLE = JSON.stringify(
  { signerId: "alice.near", receiverId: "usdt.tether-token.near", actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer_call", args: { receiver_id: "intents.near", amount: "25000000", msg: '{"receiver_id":"alice.near"}' }, gas: "100000000000000", deposit: "1" } }] },
  null,
  2,
);
$("#sign").innerHTML = `
  <h2 id="sign-h">Before you sign</h2>
  <p>Paste a transaction (wallet-selector or RPC JSON). Keyhole decodes each action, including <code>ft_transfer_call</code> messages and meta-transactions, and grades every contract the transaction will run.</p>
  <label for="tx-input" class="sr-only">Transaction JSON</label>
  <textarea id="tx-input" spellcheck="false">${esc(SAMPLE)}</textarea>
  <div class="replay-controls"><button class="primary" type="button" id="tx-go">Decode and check</button></div>
  <div id="tx-out" aria-live="polite"></div>`;
async function runDecode() {
  const out = $("#tx-out");
  let txs;
  try {
    txs = decodeTransactions(JSON.parse($<HTMLTextAreaElement>("#tx-input").value));
  } catch (e) {
    out.innerHTML = `<div class="panel error" role="alert">Could not read that transaction: ${esc((e as Error).message)}</div>`;
    return;
  }
  out.innerHTML = txs.map((t, i) => `<div class="panel"><h3>Transaction ${i + 1}: ${esc(t.signer ?? "?")} → ${esc(t.receiver)}</h3><ul class="reasons">${t.actions.map((a) => `<li><span class="sev ${a.risk === "high" ? "stop" : a.risk === "medium" ? "caution" : "info"}">[${a.risk}]</span>${esc(a.text)}</li>`).join("")}</ul><div class="verdicts" data-tx="${i}">${t.inspect.map((acc) => `<p data-acc="${esc(acc)}"><span class="spinner">[|]</span> checking ${esc(acc)}…</p>`).join("")}</div></div>`).join("");
  for (const [i, t] of txs.entries()) {
    for (const acc of t.inspect) {
      const slot = out.querySelector(`[data-tx="${i}"] [data-acc="${CSS.escape(acc)}"]`)!;
      try {
        const r = await inspect(acc, { network: acc.endsWith(".testnet") ? "testnet" : "mainnet", history: false });
        slot.innerHTML = `${verdictBadge(r.grade.verdict)} <a href="#/inspect/${encodeURIComponent(acc)}">${esc(acc)}</a> — ${esc(r.grade.headline)}`;
      } catch (e) {
        slot.innerHTML = `<span class="sev caution">[!!]</span> ${esc(acc)}: could not check (${esc((e as Error).message)})`;
      }
    }
  }
}
$("#tx-go").addEventListener("click", runDecode);

// ── API / SDK ──
$("#api").innerHTML = `
  <h2 id="api-h">Use it from code</h2>
  <p>The website is a thin UI over <code>@keyhole/core</code>. Wallets, dApps and agents can call it directly. It needs no server and no API key.</p>
  <pre class="code"><code>import { inspect } from "@keyhole/core";
const r = await inspect("intents.near");          // public RPC, deterministic grade
r.grade.verdict;   // "OK" | "CAUTION" | "STOP"
r.grade.reasons;   // [{ code, severity, text, evidence: [rpc re-check] }]

import { guardCall } from "@keyhole/guard";        // agents: refuse in code, not in a prompt
await guardCall("vault.near", { methodName: "deposit", deposit }, { execute, policy: { onCaution: "deny" } });</code></pre>
  <pre class="code"><code>npx keyhole inspect usdt.tether-token.near --json</code></pre>`;

route();
