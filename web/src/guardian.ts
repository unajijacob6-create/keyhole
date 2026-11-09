// Keyhole Guardian sections: the recorded testnet run (replay), the mainnet upgrade radar (live,
// graded in the visitor's browser), the escape-hatch explainer, and the honest limits.
import {
  analyzeWasm,
  ARCHIVAL_RPC,
  codeHash,
  fetchPendingCode,
  gradeUpgrade,
  listUpgradeProposals,
  Rpc,
  sourceMetadataFromWasm,
  sourcescan,
  txApi,
  type UpgradeGrade,
} from "@keyhole/core";
import { esc, verdictBadge } from "./render.ts";
import guardianRun from "../../data/guardian-run.json";
import radarData from "../../data/radar.json";

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;
const short = (s: string | null | undefined, n = 8) => (s ? (s.length > n + 1 ? `${s.slice(0, n)}…` : s) : "—");
const nearTx = (net: "mainnet" | "testnet", h: string) => `https://${net === "testnet" ? "testnet." : ""}nearblocks.io/txns/${h}`;
const nearAcct = (net: "mainnet" | "testnet", a: string) => `https://${net === "testnet" ? "testnet." : ""}nearblocks.io/address/${a}`;
export function fmtWindow(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
const yocto = (y: string | bigint) => (Number(BigInt(y) / 10n ** 20n) / 10_000).toFixed(2);

// ── 1. the recorded run ──────────────────────────────────────────────────────────────────────

type Run = typeof guardianRun;
const run = guardianRun as Run & { review?: { risk: string; summary: string; model: string; registry_id?: number } | null };

interface Stage {
  key: string;
  title: string;
  detail: string;
  block: number | null;
  tx?: string;
  alice: { state: string; near: string; tone: "ok" | "warn" | "stop" | "idle" };
  bob: { state: string; near: string; tone: "ok" | "warn" | "stop" | "idle" };
  vault: number | null; // NEAR in the vault, from the recording (null if it was not recorded)
  guardian: string[];
}

/** The deposits the run recorded, in NEAR: step 1's console line "vault total X NEAR (alice A, bob B)". */
export function recordedDeposits(r: { steps?: { lines?: string[] }[] }): { alice: number; bob: number } | null {
  for (const s of r.steps ?? []) for (const l of s.lines ?? []) {
    const m = /\(alice (\d+(?:\.\d+)?), bob (\d+(?:\.\d+)?)\)/.exec(l);
    if (m) return { alice: Number(m[1]), bob: Number(m[2]) };
  }
  return null;
}
const nearAmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${x.toFixed(d)} NEAR`);
const nearShort = (x: number | null) => (x === null ? "some NEAR" : `${x} NEAR`);

function stages(): Stage[] {
  const H = run.heights as Record<string, number>;
  const T = run.tx as Record<string, string>;
  const pend = (run.verdicts as any).pending;
  const firedAlert = (run.alerts as any[]).find((a) => a.fired?.length);
  const summary: string[] = firedAlert?.assessment?.summary ?? [];
  const bytes = firedAlert?.assessment?.pending_size;
  // Amounts come from the recording: deposits from step 1, what is left from run.balances (yocto).
  const dep = recordedDeposits(run as any);
  const A = dep?.alice ?? null, B = dep?.bob ?? null;
  const bal = (run.balances ?? {}) as Record<string, string | undefined>;
  const aliceLeft = bal.alice_in_vault_after_fire != null ? Number(yocto(bal.alice_in_vault_after_fire)) : null;
  const vaultEnd = bal.vault_total_after_sweep != null ? Number(yocto(bal.vault_total_after_sweep)) : null;
  const total = A !== null && B !== null ? A + B : null;
  const afterFire = B !== null && aliceLeft !== null ? B + aliceLeft : null;
  const aliceOut = A !== null && aliceLeft !== null ? A - aliceLeft : null;
  const inVault = (x: number | null) => `${nearAmt(x)} in vault`;
  const home = `${nearAmt(aliceOut)} back home`;
  return [
    { key: "deposits", title: "Two depositors", detail: `Alice deposits ${nearShort(A)}, Bob ${nearShort(B)} into a vault governed by a 2-of-2 Sputnik DAO. Withdrawing needs exactly 1 yoctoNEAR, as Ref and Burrow withdraws do. Unlike them it holds native NEAR: the diff catches a native-NEAR sweep, not a token one.`, block: H.bob_deposit, tx: T.bob_deposit,
      alice: { state: "deposited", near: inVault(A), tone: "idle" }, bob: { state: "deposited", near: inVault(B), tone: "idle" }, vault: total, guardian: ["watching gv-… · controller resolved: kh-guardian.sputnikv2.testnet (2 of 2)"] },
    { key: "armed", title: "Alice arms a hatch", detail: "She signs one withdraw_all to herself with a dedicated key, then drops the key's secret. The guardian keeps only the signed bytes; it cannot change them.", block: run.hatch?.created_height ?? null,
      alice: { state: "hatch ARMED", near: inVault(A), tone: "ok" }, bob: { state: "no hatch", near: inVault(B), tone: "idle" }, vault: total, guardian: [`hatch ${run.hatch?.id ?? ""} · ARMED · ${run.hatch?.method}() · 1 yocto · until block ${run.hatch?.max_block_height}`] },
    { key: "proposed", title: "An upgrade is proposed", detail: `A council member stores ${bytes ? `${bytes.toLocaleString("en")} bytes` : "a new wasm"} and proposes "Vault v1.1: gas optimisations". Nothing has executed yet.`, block: H.add_proposal, tx: T.add_proposal,
      alice: { state: "hatch ARMED", near: inVault(A), tone: "ok" }, bob: { state: "no hatch", near: inVault(B), tone: "idle" }, vault: total, guardian: [`proposal #${run.proposal_id} · UpgradeRemote · 0 of 2 approvals`] },
    { key: "stop", title: "STOP, before any vote", detail: "Keyhole fetches the exact bytes from the store_blob transaction, diffs them against the live code, finds no verified build, and fires Alice's hatch.", block: H.hatch_fired, tx: T.hatch_fired,
      alice: { state: "hatch FIRED", near: home, tone: "ok" }, bob: { state: "no hatch", near: inVault(B), tone: "warn" }, vault: afterFire,
      guardian: [`${pend?.verdict ?? "STOP"}: ${pend?.headline ?? ""}`.replace(/^STOP: STOP:/, "STOP:"), ...summary.map((s) => `diff: ${s}`), ...(run.review ? [`TEE review (${run.review.model.split("/").pop()}): ${run.review.risk} — ${run.review.summary}`] : []), `FIRED hatch ${run.hatch?.id ?? ""}`] },
    { key: "vote1", title: "Vote 1 of 2", detail: "The proposer approves. One more approval executes it, in the same call.", block: H.vote_1, tx: T.vote_1,
      alice: { state: "safe", near: home, tone: "ok" }, bob: { state: "no hatch", near: inVault(B), tone: "warn" }, vault: afterFire, guardian: ["proposal #" + run.proposal_id + " · 1 of 2 · the next approval executes it"] },
    { key: "vote2", title: "Vote 2 of 2 executes it", detail: "Sputnik runs the upgrade in the call that reaches the threshold. The vault now has a sweep method.", block: H.vote_2, tx: T.vote_2,
      alice: { state: "safe", near: home, tone: "ok" }, bob: { state: "exposed", near: inVault(B), tone: "stop" }, vault: afterFire, guardian: ["code changed → " + short(run.code.evil, 10)] },
    { key: "sweep", title: "The sweep", detail: "Anyone calls sweep(). It takes what is left in the vault.", block: H.sweep, tx: T.sweep,
      alice: { state: "safe", near: home, tone: "ok" }, bob: { state: "swept", near: nearAmt(vaultEnd), tone: "stop" }, vault: vaultEnd, guardian: [`vault total ${nearAmt(vaultEnd, 4)}`] },
  ];
}

export function mountReplay(el: HTMLElement) {
  if (!run?.tx?.hatch_fired) {
    el.innerHTML = `<h2 id="watch-h">Watch it happen</h2><p class="muted">No recorded run yet. Run <code>npm run demo:guardian</code>.</p>`;
    return;
  }
  const S = stages();
  const H = run.heights as Record<string, number>;
  const lead = (H.vote_2 ?? 0) - (H.hatch_fired ?? 0);
  let i = S.length - 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  const minB = H.add_proposal - 4;
  const maxB = H.sweep + 4;
  const pos = (b: number) => `${Math.max(0, Math.min(100, ((b - minB) / (maxB - minB)) * 100))}%`;
  const marks = [
    { k: "proposed", label: "proposed", b: H.add_proposal },
    { k: "stop", label: "STOP · hatch fired", b: H.hatch_fired },
    { k: "vote1", label: "vote 1", b: H.vote_1 },
    { k: "vote2", label: "vote 2 · executes", b: H.vote_2 },
    { k: "sweep", label: "sweep", b: H.sweep },
  ];
  el.innerHTML = `
    <div class="g-head">
      <span class="tag"><span class="dot" aria-hidden="true"></span>Recorded on testnet ${esc(run.recordedAt.slice(0, 10))}</span>
      <h2 id="watch-h" class="display">Watch it happen.</h2>
      <p>A real run of <code>npm run demo:guardian</code>: a DAO-governed vault, two depositors, one malicious upgrade. Alice armed a hatch. Bob didn't. Every step is a testnet transaction, re-checkable without keys.</p>
    </div>
    <div class="g-stage panel" data-testid="guardian-replay">
      <div class="g-track" aria-hidden="true">
        <div class="g-rail"></div>
        <div class="g-lead" style="left:${pos(H.hatch_fired)};width:calc(${pos(H.vote_2)} - ${pos(H.hatch_fired)})"><span>${lead} blocks ahead</span></div>
        ${marks.map((m) => `<button class="g-mark g-${m.k}" data-k="${m.k}" style="left:${pos(m.b)}" tabindex="-1"><i></i><span>${esc(m.label)}</span><em>#${m.b}</em></button>`).join("")}
      </div>
      <div class="g-controls" role="group" aria-label="Replay controls">
        <button class="pill dark" type="button" id="g-play">Play</button>
        <button class="secondary" type="button" id="g-prev" aria-label="Previous step">←</button>
        <button class="secondary" type="button" id="g-next" aria-label="Next step">→</button>
        <span class="muted small" id="g-status" role="status"></span>
      </div>
      <div class="g-grid">
        <div class="g-step">
          <p class="g-step-n" id="g-step-n"></p>
          <h3 id="g-title"></h3>
          <p id="g-detail" class="muted"></p>
          <p class="small" id="g-tx"></p>
        </div>
        <div class="g-lanes">
          <div class="lane" id="lane-a"><span class="lane-who">Alice</span><span class="lane-state"></span><strong class="lane-near"></strong></div>
          <div class="lane" id="lane-b"><span class="lane-who">Bob</span><span class="lane-state"></span><strong class="lane-near"></strong></div>
          <div class="vault-meter" aria-label="Vault total"><span class="vault-label">vault</span><div class="vault-bar"><span id="vault-fill"></span></div><strong id="vault-n"></strong></div>
        </div>
        <pre class="term g-console" id="g-console" aria-label="Guardian console"></pre>
      </div>
      <p class="small muted g-verify">Re-check this run with no keys: <code>npm run demo:guardian -- --replay</code> fetches each recorded transaction from testnet archival RPC and checks its signer, receiver, call and block; that the stored bytes hash to the proposal and re-derives their diff; that the guardian's transaction carries Alice's signed delegate byte for byte and her withdraw paid her deposit back; the block order (the hatch landed ${lead} blocks before the deciding vote); the sweep; and that the recorded balances, outcome and alerts match the chain.
        <a href="${nearAcct("testnet", run.vault)}">vault</a> · <a href="${nearAcct("testnet", run.dao)}">DAO</a>${run.review?.registry_id ? ` · registry AiReview #${run.review.registry_id}` : ""}</p>
    </div>`;
  const $ = (s: string) => el.querySelector(s) as HTMLElement;
  const paint = () => {
    const s = S[i];
    $("#g-step-n").textContent = `Step ${i + 1} of ${S.length}${s.block ? ` · block ${s.block}` : ""}`;
    $("#g-title").textContent = s.title;
    $("#g-detail").textContent = s.detail;
    $("#g-tx").innerHTML = s.tx ? `<a href="${nearTx("testnet", s.tx)}">${esc(short(s.tx, 12))} on nearblocks ↗</a>` : "";
    for (const [id, lane] of [["#lane-a", s.alice], ["#lane-b", s.bob]] as const) {
      const l = $(id);
      l.dataset.tone = lane.tone;
      (l.querySelector(".lane-state") as HTMLElement).textContent = lane.state;
      (l.querySelector(".lane-near") as HTMLElement).textContent = lane.near;
    }
    const full = S[0].vault;
    ($("#vault-fill") as HTMLElement).style.width = s.vault !== null && full ? `${(s.vault / full) * 100}%` : "0%";
    $("#vault-n").textContent = nearAmt(s.vault);
    const lines = S.slice(0, i + 1).flatMap((x) => x.guardian.map((g) => `${x.block ? `#${x.block}` : "      "}  ${g}`));
    const con = $("#g-console");
    con.innerHTML = lines.map((l) => `<span class="${/STOP|FIRED/.test(l) ? "hot" : /diff:|TEE/.test(l) ? "dim2" : ""}">${esc(l)}</span>`).join("\n");
    con.scrollTop = con.scrollHeight;
    el.querySelectorAll<HTMLElement>(".g-mark").forEach((m) => m.classList.toggle("on", S.findIndex((x) => x.key === m.dataset.k) <= i));
    $("#g-status").textContent = s.title;
    $("#g-play").textContent = timer ? "Pause" : i === S.length - 1 ? "Replay" : "Play";
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  $("#g-play").addEventListener("click", () => {
    if (timer) return stop(), paint();
    if (i >= S.length - 1) i = 0;
    timer = setInterval(() => {
      if (i >= S.length - 1) stop();
      else i++;
      paint();
    }, 2200);
    paint();
  });
  $("#g-prev").addEventListener("click", () => (stop(), (i = Math.max(0, i - 1)), paint()));
  $("#g-next").addEventListener("click", () => (stop(), (i = Math.min(S.length - 1, i + 1)), paint()));
  el.querySelectorAll<HTMLElement>(".g-mark").forEach((m) => m.addEventListener("click", () => (stop(), (i = S.findIndex((x) => x.key === m.dataset.k)), paint())));
  paint();
  // Autoplay once when the section scrolls into view (not with reduced motion).
  if (!REDUCE && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        i = 0;
        paint();
        $("#g-play").click();
      }
    }, { threshold: 0.45 });
    io.observe(el);
  }
}

// ── 2. the radar ─────────────────────────────────────────────────────────────────────────────

type RadarProp = {
  dao: string; id: number; proposer: string; description: string; kind: string; target: string; method: string | null;
  via?: string | null; registers_release?: boolean;
  code_hash: string | null; status: string; state: string; submitted_at_ms: number; expires_at_ms: number;
  votes: { approve: number; reject: number; remove: number }; required: number | null;
  window_s?: number | null; changed_at_height?: number | null; bytes?: number | null; blob_tx?: string | null;
  grade?: { verdict: string; flags: string[]; headline: string } | null; summary?: string[];
};
type RadarDao = { dao: string; council: number | null; required: number | null; proposal_period_h: number; proposals: RadarProp[] };
const radar = radarData as unknown as { generatedAt: string; atBlock: number; daos: RadarDao[]; staged: any[]; stats: Record<string, number | null>; windows?: { dao: string; id: number; target: string; window_s: number }[] };

const daoName = (d: string) => d.replace(".sputnik-dao.near", "");
const stateChip = (s: string) => `<span class="st st-${esc(s)}">${esc(s)}</span>`;

function votesMeter(p: RadarProp) {
  const req = p.required ?? 0;
  if (!req) return "";
  const cells = Array.from({ length: req }, (_, k) => `<i class="${k < p.votes.approve ? "on" : ""}"></i>`).join("");
  return `<span class="votes" title="${p.votes.approve} of ${req} approvals">${cells}<b>${p.votes.approve}/${req}</b></span>`;
}

function propCard(p: RadarProp) {
  const g = p.grade;
  const age = Math.max(0, Date.now() - p.submitted_at_ms);
  const exp = p.state === "pending" ? `expires in ${fmtWindow(Math.round((p.expires_at_ms - Date.now()) / 1000))}` : "";
  return `<article class="prop" data-dao="${esc(p.dao)}" data-id="${p.id}">
    <header><span class="prop-dao">${esc(daoName(p.dao))} #${p.id}</span>${stateChip(p.state)}</header>
    <h4 class="mono" title="${esc(p.target)}">${esc(p.target)}</h4>
    <p class="prop-kind">${esc(p.kind)}${p.method ? ` · <code>${esc(p.method)}</code>` : ""}${p.via ? ` via <span class="mono">${esc(p.via)}</span>` : ""} · ${votesMeter(p)}</p>
    <dl class="prop-facts">
      <div><dt>new code</dt><dd class="mono" title="${esc(p.code_hash ?? "")}">${esc(short(p.code_hash, 10))}</dd></div>
      ${p.registers_release ? `<div><dt>effect</dt><dd>registers a release; deployed to managed contracts by a later call</dd></div>` : `<div><dt>${p.state === "executed" ? "proposal → live" : "submitted"}</dt><dd>${p.state === "executed" ? (p.window_s != null ? `<strong>${fmtWindow(p.window_s)}</strong>` : "—") : `${fmtWindow(Math.round(age / 1000))} ago`}</dd></div>`}
      ${exp ? `<div><dt>window</dt><dd>${esc(exp)}</dd></div>` : ""}
      ${p.blob_tx ? `<div><dt>bytes</dt><dd><a href="${nearTx("mainnet", p.blob_tx)}">${p.bytes ? `${(p.bytes / 1024).toFixed(0)} KB` : "store_blob"} on chain before execution ↗</a></dd></div>` : ""}
    </dl>
    ${g ? `<div class="prop-grade">${verdictBadge(g.verdict)} <span class="small">${esc(g.flags.slice(0, 3).join(" · "))}</span></div>` : ""}
    <div class="prop-live" hidden></div>
    ${canGrade(p) ? `<button class="secondary small grade-btn" type="button">Grade it in your browser</button>` : ""}
  </article>`;
}

/** Gradeable here: the code is still to be voted on (compare with today's code), or it executed and
 *  the snapshot knows the block where it went live (compare with the code just before). A release
 *  registration does not change the receiver's code, so there is nothing to diff. */
const canGrade = (p: RadarProp) => Boolean(p.code_hash) && !p.registers_release && (p.state === "pending" || (p.state === "executed" && Boolean(p.changed_at_height)));

/** What the in-browser grade diffs the proposal's code against (shown with every result). */
export const comparedWith = (p: Pick<RadarProp, "state" | "changed_at_height" | "target">) =>
  p.state === "executed" && p.changed_at_height ? `the code it replaced (${p.target} just before block ${p.changed_at_height}, archival RPC)` : `the code ${p.target} runs now`;

/** Code at height h; heights with no block step backwards. */
async function codeBefore(arch: Rpc, account: string, h: number): Promise<Uint8Array> {
  for (let i = 0; i < 20; i++) {
    try {
      return (await arch.viewCode(account, h - i)).code;
    } catch (e) {
      if (!/UNKNOWN_BLOCK/.test(String((e as Error).message))) throw e;
    }
  }
  throw new Error(`no block near ${h}`);
}

async function gradeInBrowser(p: RadarProp, out: HTMLElement) {
  out.hidden = false;
  out.innerHTML = `<p class="small muted">Fetching the DAO's store_blob transaction from the FastNEAR tx index…</p>`;
  const rpc = new Rpc({ network: "mainnet" });
  const arch = new Rpc({ network: "mainnet", url: ARCHIVAL_RPC.mainnet });
  const t0 = performance.now();
  try {
    let pending: Uint8Array | null = null;
    let from = "";
    const blob = await fetchPendingCode({ api: txApi("mainnet"), dao: p.dao, hash: p.code_hash!, maxPages: 6 }).catch(() => null);
    if (blob) {
      pending = blob.code;
      from = `store_blob <a href="${nearTx("mainnet", blob.tx)}">${esc(short(blob.tx, 8))}</a> by ${esc(blob.signer)}`;
    }
    let live: Uint8Array | null = null;
    if (p.state === "executed" && p.changed_at_height) {
      out.innerHTML = `<p class="small muted">Reading the code it replaced from archival RPC (just before block ${p.changed_at_height})…</p>`;
      live = await codeBefore(arch, p.target, p.changed_at_height - 1);
      if (!pending) {
        pending = (await arch.viewCode(p.target, p.changed_at_height)).code;
        from = `the code at block ${p.changed_at_height}`;
      }
    } else live = (await rpc.viewCode(p.target)).code;
    const against = comparedWith(p);
    if (!pending) {
      out.innerHTML = `<p class="small">Could not find the pending bytes in the recent transaction index. ${p.state === "executed" ? "" : "Keyhole would grade it CAUTION: the code being voted on is not visible."}</p>`;
      return;
    }
    const h = await codeHash(pending);
    if (h !== p.code_hash) throw new Error(`bytes hash to ${h}, not ${p.code_hash}`);
    const ss = await sourcescan(rpc, p.target, h);
    const g: UpgradeGrade = gradeUpgrade({ target: p.target, live_hash: await codeHash(live), pending_hash: h, live: analyzeWasm(live), pending: analyzeWasm(pending), verified: { reproducible: null, sourcescan: ss.status === "verified" ? true : ss.status === "unknown" ? null : false }, review: null });
    const meta = await sourceMetadataFromWasm(pending);
    const d = g.diff!;
    const ms = Math.round(performance.now() - t0);
    out.innerHTML = `
      <div class="live-grade">${verdictBadge(g.verdict)} <span class="small muted">graded in ${(ms / 1000).toFixed(1)} s, in this tab</span></div>
      <p class="small">${esc(g.headline)}</p>
      <ul class="small diff-list">
        <li>${(pending.length / 1024).toFixed(0)} KB from ${from}; sha256 = proposal hash ✓</li>
        <li>compared with ${esc(against)}</li>
        ${d.addedMethods.length ? `<li>+ ${esc(d.addedMethods.slice(0, 8).join(", "))}${d.addedMethods.length > 8 ? ` (+${d.addedMethods.length - 8})` : ""}</li>` : ""}
        ${d.removedMethods.length ? `<li>− ${esc(d.removedMethods.slice(0, 8).join(", "))}</li>` : ""}
        ${d.newlyReachable.map((n) => `<li>${esc(n.capability)} newly reachable from ${esc(n.methods.slice(0, 5).join(", "))}</li>`).join("")}
        ${!d.addedMethods.length && !d.removedMethods.length && !d.newlyReachable.length ? "<li>no change in exports or privileged reachability</li>" : ""}
        <li>declared source: ${meta?.link ? `<a href="${esc(meta.link)}">${esc(meta.link.replace("https://github.com/", ""))}</a>${meta.build_info ? " (with build_info)" : ""}` : "none in the bytes (no NEP-330)"}</li>
        <li>SourceScan for this hash: ${esc(ss.status)}</li>
      </ul>`;
  } catch (e) {
    out.innerHTML = `<p class="small">Could not grade it here: ${esc(String((e as Error).message).slice(0, 140))}</p>`;
  }
}

function windowChart(rows: { dao: string; id: number; target: string; window_s: number }[]) {
  if (!rows.length) return "";
  const sorted = [...rows].sort((a, b) => a.window_s - b.window_s);
  const lo = Math.log10(30), hi = Math.log10(Math.max(...sorted.map((r) => r.window_s), 86400 * 3));
  const x = (s: number) => ((Math.log10(Math.max(s, 30)) - lo) / (hi - lo)) * 100;
  const ticks = [[60, "1 min"], [600, "10 min"], [3600, "1 h"], [21600, "6 h"], [86400, "1 day"]].filter(([s]) => (s as number) <= 10 ** hi);
  return `<figure class="wchart" aria-labelledby="wchart-cap">
    <figcaption id="wchart-cap"><strong>Time from proposal to live code</strong> · ${sorted.length} executed upgrade proposals, measured by archival bisection (log scale)</figcaption>
    <div class="wplot" role="img" aria-label="Distribution of upgrade windows">
      ${ticks.map(([s, l]) => `<span class="wtick" style="left:${x(s as number)}%"><em>${l}</em></span>`).join("")}
      ${sorted.map((r, k) => `<span class="wdot" tabindex="0" style="left:${x(r.window_s)}%;top:${8 + (k % 5) * 16}px" data-tip="${esc(`${daoName(r.dao)} #${r.id} · ${r.target} · ${fmtWindow(r.window_s)}`)}"></span>`).join("")}
    </div>
    <details class="small"><summary>Table view</summary><table class="wtable"><thead><tr><th>DAO</th><th>proposal</th><th>target</th><th>proposal → live</th></tr></thead><tbody>${sorted.map((r) => `<tr><td>${esc(daoName(r.dao))}</td><td>#${r.id}</td><td class="mono">${esc(r.target)}</td><td>${fmtWindow(r.window_s)}</td></tr>`).join("")}</tbody></table></details>
  </figure>`;
}

/** Cards the radar shows at once, for "All" and for each DAO's filter. */
export const RADAR_SHOWN = 12;

export function mountRadar(el: HTMLElement) {
  const st = radar.stats ?? {};
  const all = radar.daos.flatMap((d) => d.proposals);
  const perDao = Math.max(0, ...radar.daos.map((d) => d.proposals.length));
  let filter = "all";
  el.innerHTML = `
    <div class="g-head">
      <span class="tag"><span class="dot live-dot" aria-hidden="true"></span>NEAR mainnet · snapshot ${esc(radar.generatedAt.slice(0, 16).replace("T", " "))} UTC, refreshed live</span>
      <h2 id="radar-h" class="display">Upgrade radar.</h2>
      <p>Recent upgrade proposals of the DAOs behind Ref, Burrow, NEAR Intents, the Omni bridge and SWEAT: the snapshot holds the latest ${perDao} per DAO. "All" shows the ${RADAR_SHOWN} most recent across the ${radar.daos.length} DAOs; a DAO's filter shows its latest ${RADAR_SHOWN}. Each one names the exact code hash. For <code>UpgradeRemote</code> and <code>UpgradeSelf</code> the code is in a <code>store_blob</code> transaction to the DAO, which must be on chain before the proposal executes; near-plugins deploys use code staged on the target, and a release registration carries only a hash. Pick a proposal that is still open, or an executed one whose replaced code is known, and Keyhole grades it here, in your browser.</p>
    </div>
    <div class="radar-stats">
      <div class="rstat"><strong>${fmtWindow(st.window_min_s as number)}</strong><span>fastest proposal → live code</span></div>
      <div class="rstat"><strong>${fmtWindow(st.window_median_s as number)}</strong><span>median, over ${st.measured_windows ?? 0} executed upgrades</span></div>
      <div class="rstat"><strong>${st.upgradable_zero_delay ?? "—"} of ${st.upgradable_surveyed ?? "—"}</strong><span>near-plugins contracts with no staging delay</span></div>
      <div class="rstat"><strong>${st.pending_now ?? 0}</strong><span>upgrade proposals open right now</span></div>
    </div>
    ${windowChart(radar.windows ?? [])}
    <div class="radar-filters" role="tablist" aria-label="Filter by DAO">
      <button class="chip on" data-f="all" role="tab" aria-selected="true">All</button>
      ${radar.daos.map((d) => `<button class="chip" data-f="${esc(d.dao)}" role="tab" aria-selected="false">${esc(daoName(d.dao))} <span class="muted">${d.required ?? "?"} of ${d.council ?? "?"}</span></button>`).join("")}
    </div>
    <div class="props" id="props"></div>
    <p class="small muted">Sputnik executes a proposal in the call that reaches its threshold; the proposal period (7 days on these DAOs) is an expiry, not a delay. "Proposal → live" is the time between submission and the first block running the new code. A grade here is the deterministic rule set in <a href="https://github.com/unajijacob6-create/keyhole/blob/main/docs/GRADING.md">GRADING.md</a>; it describes what the new code can do, not intent. A STOP on a past upgrade means its code had no verified build and its diff adds a new path (or removes an exit); a reproducible build or SourceScan verification of the new hash would make it CAUTION. No known incident is attached to these upgrades, so the upgrade eval counts every such STOP as a false alarm.</p>`;
  const propsEl = el.querySelector("#props") as HTMLElement;
  const paint = () => {
    const rows = all.filter((p) => filter === "all" || p.dao === filter).sort((a, b) => b.submitted_at_ms - a.submitted_at_ms).slice(0, RADAR_SHOWN);
    propsEl.innerHTML = rows.map(propCard).join("");
    propsEl.querySelectorAll<HTMLElement>(".grade-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const card = b.closest(".prop") as HTMLElement;
        const p = all.find((x) => x.dao === card.dataset.dao && String(x.id) === card.dataset.id)!;
        b.remove();
        void gradeInBrowser(p, card.querySelector(".prop-live") as HTMLElement);
      }),
    );
  };
  el.querySelectorAll<HTMLElement>(".chip[data-f]").forEach((c) =>
    c.addEventListener("click", () => {
      filter = c.dataset.f!;
      el.querySelectorAll(".chip[data-f]").forEach((x) => (x.classList.toggle("on", x === c), x.setAttribute("aria-selected", String(x === c))));
      paint();
    }),
  );
  // Tooltip for the window chart.
  const tip = document.createElement("div");
  tip.className = "wtip";
  tip.hidden = true;
  el.appendChild(tip);
  el.querySelectorAll<HTMLElement>(".wdot").forEach((d) => {
    const show = () => {
      tip.textContent = d.dataset.tip!;
      tip.hidden = false;
      const r = d.getBoundingClientRect(), pr = el.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(8, r.left - pr.left - 80), pr.width - 260)}px`;
      tip.style.top = `${r.top - pr.top - 40}px`;
    };
    d.addEventListener("mouseenter", show);
    d.addEventListener("focus", show);
    d.addEventListener("mouseleave", () => (tip.hidden = true));
    d.addEventListener("blur", () => (tip.hidden = true));
  });
  paint();
  // Refresh states and votes live (cheap: two views per DAO page).
  const rpc = new Rpc({ network: "mainnet" });
  void Promise.all(
    radar.daos.map(async (d) => {
      try {
        const live = await listUpgradeProposals(rpc, d.dao, { last: 12 });
        for (const lp of live) {
          const ex = all.find((p) => p.dao === d.dao && p.id === lp.id);
          if (ex) Object.assign(ex, { state: lp.state, status: lp.status, votes: lp.votes });
          else all.push({ ...(lp as any), window_s: null });
        }
      } catch {
        /* keep the snapshot */
      }
    }),
  ).then(() => paint());
}

// ── 3. the hatch explainer ───────────────────────────────────────────────────────────────────

export function mountHatch(el: HTMLElement) {
  const h = run.hatch;
  el.innerHTML = `
    <div class="g-head">
      <h2 id="hatch-h" class="display">The escape hatch.</h2>
      <p>A withdraw-to-yourself, signed in advance. The guardian holds the signed bytes and submits them when Keyhole grades a code change of that venue STOP: a pending proposal or staged code, and in this build also code that already landed. It pays the gas and the 1 yoctoNEAR. It cannot change a single field. The signature fixes the call, not the outcome: the venue's code at the moment the call runs decides where the funds go, so a hatch fired after an upgrade landed runs the new code.</p>
    </div>
    <div class="hatch-grid">
      <div class="panel hatch-card" data-testid="hatch-card">
        <p class="small muted">The hatch from the recorded run, decoded from its signed bytes</p>
        <dl class="hatch-fields mono">
          <div><dt>sender</dt><dd>${esc(h?.account ?? "")}</dd></div>
          <div><dt>receiver</dt><dd>${esc(h?.venue ?? "")}</dd></div>
          <div><dt>call</dt><dd>${esc(h?.method ?? "")}(${esc(JSON.stringify(h?.args ?? {}))})</dd></div>
          <div><dt>deposit</dt><dd>${esc(h?.deposit ?? "")} yoctoNEAR</dd></div>
          <div><dt>nonce</dt><dd>${esc(h?.nonce ?? "")}</dd></div>
          <div><dt>valid until</dt><dd>block ${esc(h?.max_block_height ?? "")}</dd></div>
          <div><dt>key</dt><dd title="${esc(h?.public_key ?? "")}">${esc(short(h?.public_key, 18))}</dd></div>
        </dl>
        <p class="small">ed25519 signature over sha256(NEP-461 prefix + DelegateAction). Change any byte and nearcore rejects it; submit it twice and the nonce rejects it.</p>
      </div>
      <div class="hatch-cols">
        <div class="panel can"><h3>It can</h3><ul>
          <li>Call <strong>one fixed withdraw</strong>, as you, with the arguments you signed; on the venue's current code that pays <strong>your own account</strong></li>
          <li>Carry the 1 yoctoNEAR that Ref, Burrow, wNEAR and NEP-141 transfers demand (a function-call key cannot: nearcore rejects any deposit from one)</li>
          <li>Be relayed by anyone, and checked by anyone, offline</li>
          <li>Be revoked by you at any time: delete the key</li>
        </ul></div>
        <div class="panel cannot"><h3>It cannot</h3><ul>
          <li>Beat an upgrade that lands in the same transaction it is staged in (no window), or a direct redeploy by a key</li>
          <li>Protect you if a key on <em>your</em> account is compromised</li>
          <li>Exit a venue that checks <code>signer_account_id</code> (the relayer signs)</li>
          <li>Prove its key's secret was erased: you trust the process that armed it, once</li>
          <li>Choose what the venue's code does with the call: fired after an upgrade landed, it runs the new code</li>
          <li>Fire on a token drain the diff does not flag (Ref- and Burrow-style token deposits move with <code>ft_transfer</code>, not native transfers), unless an AI review reports high risk</li>
        </ul></div>
      </div>
    </div>
    <p class="small muted">Also proven on a real token: a hatch for <code>wrap.testnet</code>'s <code>near_withdraw</code> (1 yoctoNEAR) was relayed by a different account and returned 0.1 wNEAR as NEAR; a second submission was refused (<a href="https://testnet.nearblocks.io/txns/HK9VR5NtNUXLUZJXpwva9qxG88e1cw82kfJkyeojyrBP">exit tx</a>, <a href="https://testnet.nearblocks.io/txns/2R7oWFRS8pvDsfzXdePEdpS5t2EWz3xwGfGX8ZtxgbNv">refused replay</a>; outcomes recorded in <code>packages/hatch/test/fixtures/live-run.json</code>). Details: <a href="https://github.com/unajijacob6-create/keyhole/blob/main/docs/HATCH.md">HATCH.md</a>.</p>`;
}

export const guardianStats = () => ({ run, radar, lead: ((run.heights as any).vote_2 ?? 0) - ((run.heights as any).hatch_fired ?? 0), vaultNear: yocto });
