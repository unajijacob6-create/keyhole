// Rendering of reports and verdicts. Verdict first, then reasons grouped by question, then raw
// evidence in <details>. Every reason carries its re-check command.
import { recheckCommand, explorerAccount, type KeyholeReport, type Reason, type Evidence } from "@keyhole/core";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function verdictBadge(v: string, size: "" | "lg" = ""): string {
  const map: Record<string, [string, string]> = { OK: ["ok", "[OK]"], CAUTION: ["caution", "[!!]"], STOP: ["stop", "[XX]"] };
  const [cls, glyph] = map[v] ?? ["caution", "[??]"];
  return `<span class="verdict ${cls} ${size}" data-verdict="${esc(v)}"><span aria-hidden="true">${glyph}</span> ${esc(v)}</span>`;
}

const SEV: Record<string, string> = { stop: "XX", caution: "!!", info: "--", ok: "ok" };
const QUESTION: Record<string, "who" | "code" | "change"> = {
  PATH_FULL_ACCESS_KEY: "who",
  PATH_CONTRACT_METHOD: "who",
  PATH_GLOBAL_CONTRACT_PUBLISHER: "who",
  IMMUTABLE: "who",
  KEYS: "who",
  VERIFIED: "code",
  UNVERIFIED_CODE: "code",
  STALE_VERIFICATION: "code",
  NO_SOURCE_METADATA: "code",
  NO_BUILD_INFO: "code",
  SOURCE_REPO_UNREACHABLE: "code",
  AI_REVIEWED: "code",
  CHANGED_24H: "change",
  FULL_ACCESS_KEY_ADDED_24H: "change",
};

function evidenceHtml(ev: Evidence[]): string {
  if (!ev.length) return "";
  const items = ev.slice(0, 3).map((e) => {
    const cmd = recheckCommand(e);
    return `<div class="recheck"><code>${esc(cmd)}</code><button class="secondary" type="button" data-copy="${esc(cmd)}" aria-label="Copy re-check command">copy</button></div>`;
  });
  return `<details class="ev"><summary class="small">Re-check (${ev.length})</summary>${items.join("")}</details>`;
}

function reasonLi(r: Reason): string {
  return `<li><span class="sev ${r.severity}" aria-label="${r.severity}">[${SEV[r.severity]}]</span>${esc(r.text)}${evidenceHtml(r.evidence)}</li>`;
}

function changeText(r: KeyholeReport): string {
  const lc = r.lastChange;
  const obs = r.registry?.latestChange;
  const parts: string[] = [];
  if (lc?.status === "found") parts.push(`Last code change at block ${lc.height?.toLocaleString("en-US")} (${lc.timestamp?.slice(0, 10)}), found by archival search. Previous hash ${esc(lc.previousHash?.slice(0, 10))}…`);
  else if (lc?.status === "unchanged-since") parts.push(`Code unchanged since at least block ${lc.sinceHeight?.toLocaleString("en-US")} (${lc.sinceTimestamp?.slice(0, 10)}).`);
  else if (lc?.status === "unknown") parts.push(`Last code change unknown (${esc(lc.note)}).`);
  if (obs && obs.attestation.kind === "ChangeObserved") parts.push(`Keyhole watcher observed ${esc((obs.attestation as any).old_hash.slice(0, 8))}… → ${esc((obs.attestation as any).new_hash.slice(0, 8))}… at block ${(obs.attestation as any).block_height.toLocaleString("en-US")} (registry record #${obs.id}).`);
  return parts.length ? parts.map((p) => `<li><span class="sev info">[--]</span>${p}</li>`).join("") : `<li><span class="sev info">[--]</span>Not checked.</li>`;
}

function verifiedPanel(r: KeyholeReport): string {
  const rows: [string, string, string][] = []; // [status glyph, check, detail]
  const ok = "[ok]", no = "[--]", bad = "[!!]";
  if (r.code) rows.push([r.code.hashMatchesBytes ? ok : bad, "Fetched code hashes to the on-chain code hash", `${r.code.hash.slice(0, 12)}… (${(r.code.size / 1024).toFixed(0)} KiB, ${r.code.source})`]);
  if (r.sourcescan) rows.push([r.sourcescan.status === "verified" ? ok : r.sourcescan.status === "stale" ? bad : no, "Source verified on SourceScan at this hash", r.sourcescan.status]);
  const builds = r.registry?.forHash.filter((a) => a.attestation.kind === "ReproducibleBuild") ?? [];
  rows.push([builds.some((b) => (b.attestation as any).matches) ? ok : no, "Reproducible rebuild of the declared source matches", builds.length ? builds.map((b) => `${esc((b.attestation as any).repo).replace("https://github.com/", "")}@${esc(String((b.attestation as any).rev).slice(0, 8))} → ${(b.attestation as any).matches ? "match" : "no match"} (registry #${b.id}, by ${esc(b.attester)})`).join("; ") : "no rebuild attested for this hash"]);
  const reviews = r.registry?.forHash.filter((a) => a.attestation.kind === "AiReview") ?? [];
  for (const rv of reviews) {
    const a = rv.attestation as any;
    rows.push([/^(high|medium)/.test(a.verdict_summary) ? bad : ok, `Private AI review in a NEAR AI Cloud TEE (${esc(a.model)})`, `${esc(a.verdict_summary)} · TEE signer ${esc(String(a.signer).slice(0, 10))}… · response sha256 ${esc(String(a.response_sha256).slice(0, 10))}… (registry #${rv.id})`]);
  }
  if (!reviews.length) rows.push([no, "Private AI review in a NEAR AI Cloud TEE", "none for this hash"]);
  if (r.nep330) rows.push([r.nep330.hasBuildInfo ? ok : no, "NEP-330 build metadata (reproducible build recipe)", r.nep330.present ? (r.nep330.hasBuildInfo ? `${esc(r.nep330.metadata?.build_info?.build_environment?.split("@")[0])}` : "metadata without build_info") : "not published"]);
  if (r.lastChange) rows.push([r.lastChange.status === "unknown" ? no : ok, "Last code change found from archival RPC", r.lastChange.status === "found" ? `block ${r.lastChange.height?.toLocaleString("en-US")}` : r.lastChange.status === "unchanged-since" ? `unchanged since block ${r.lastChange.sinceHeight?.toLocaleString("en-US")}` : "unknown"]);
  return `<section class="panel verified" aria-label="What was verified"><h3>What was verified</h3><ul class="reasons">${rows.map(([g, c, d]) => `<li><span class="sev ${g === ok ? "ok" : g === bad ? "caution" : "info"}">${g}</span><strong>${c}</strong> <span class="muted small">${d}</span></li>`).join("")}</ul></section>`;
}

export function renderReport(r: KeyholeReport): string {
  const g = r.grade;
  const groups: Record<"who" | "code" | "change", Reason[]> = { who: [], code: [], change: [] };
  for (const reason of g.reasons) groups[QUESTION[reason.code] ?? "code"].push(reason);
  const w = r.wasm;
  const methods = w?.exports ?? [];
  const caps = w ? Object.entries(w.capabilities).map(([k, v]) => `${k}${v?.reachableFrom?.length ? ` (specific path from ${v.reachableFrom.slice(0, 4).join(", ")}${v.reachableFrom.length > 4 ? "…" : ""})` : ""}`) : [];
  return `
  <div class="panel" data-testid="report">
    <div class="result-head">
      ${verdictBadge(g.verdict, "lg")}
      <span class="class-tag">${esc(g.class)}</span>
      <h2>${esc(r.account)}</h2>
      <span class="muted small">${esc(r.network)} · block ${r.at.height.toLocaleString("en-US")}</span>
    </div>
    <p class="headline">${esc(g.headline)}</p>
    ${g.flags.length ? `<p>${g.flags.map((f) => `<span class="flag">${esc(f)}</span>`).join(" ")}</p>` : ""}
    <div class="groups">
      <section class="group" aria-label="Who can change it?"><h3>Who can change it?</h3><ul class="reasons">${groups.who.map(reasonLi).join("") || '<li><span class="sev info">[--]</span>No code on this account.</li>'}</ul></section>
      <section class="group" aria-label="Is it the reviewed code?"><h3>Is it the reviewed code?</h3><ul class="reasons">${groups.code.map(reasonLi).join("") || '<li><span class="sev info">[--]</span>No code.</li>'}</ul></section>
      <section class="group" aria-label="What changed?"><h3>What changed?</h3><ul class="reasons">${groups.change.map(reasonLi).join("")}${changeText(r)}</ul></section>
    </div>
    ${r.code ? verifiedPanel(r) : ""}
    <details><summary>Evidence: code, keys, owner</summary>
      <dl class="kv">
        ${r.code ? `<dt>code hash</dt><dd>${esc(r.code.hash)} (${esc(r.code.source)}${r.code.globalAccount ? " " + esc(r.code.globalAccount) : ""}, ${(r.code.size / 1024).toFixed(0)} KiB${r.code.hashMatchesBytes ? ", sha256 of the fetched bytes matches" : ", bytes do NOT match the served hash"})</dd>` : ""}
        <dt>full-access keys</dt><dd>${r.keys.fullAccess.length ? r.keys.fullAccess.slice(0, 7).map(esc).join("<br>") + (r.keys.fullAccess.length > 7 ? `<br>… ${r.keys.fullAccess.length - 7} more` : "") : "none"}</dd>
        <dt>function-call keys</dt><dd>${r.keys.functionCall.length ? r.keys.functionCall.slice(0, 7).map((k) => `${esc(k.receiver)} [${esc(k.methods.join(", ") || "any method")}]`).join("<br>") + (r.keys.functionCall.length > 7 ? `<br>… ${r.keys.functionCall.length - 7} more` : "") : "none"}</dd>
        ${r.owners.length ? `<dt>owner (inferred)</dt><dd>${r.owners.map((o) => `${esc(o.account)} via ${esc(o.source)}${o.actor ? ": " + esc(o.actor.summary) : o.note ? ": " + esc(o.note) : ""}`).join("<br>")}</dd>` : ""}
        ${r.sourcescan ? `<dt>SourceScan</dt><dd>${esc(r.sourcescan.status)}${r.sourcescan.accountEntry ? ` (entry at hash ${esc(r.sourcescan.accountEntry.code_hash.slice(0, 10))}…, block ${r.sourcescan.accountEntry.block_height})` : ""}</dd>` : ""}
        ${r.nep330 ? `<dt>NEP-330</dt><dd>${r.nep330.present ? `version ${esc(r.nep330.metadata?.version)}, build_info ${r.nep330.hasBuildInfo ? "yes" : "no"}${r.nep330.github ? `, <a href="https://github.com/${esc(r.nep330.github.owner)}/${esc(r.nep330.github.repo)}${r.nep330.github.rev ? "/tree/" + esc(r.nep330.github.rev) : ""}">${esc(r.nep330.github.owner)}/${esc(r.nep330.github.repo)}</a> (${esc(r.nep330.repoStatus)})` : ""}` : "not published"}</dd>` : ""}
        ${r.registry ? `<dt>Keyhole registry</dt><dd>${r.registry.available ? `${r.registry.forHash.length} attestation(s) for this hash${r.registry.forHash.length ? ": " + r.registry.forHash.map((a) => `#${a.id} ${esc(a.attestation.kind)} by ${esc(a.attester)}`).join(", ") : ""}` : esc(r.registry.error)}</dd>` : ""}
      </dl>
    </details>
    ${w ? `<details><summary>Evidence: wasm (${methods.length} methods, ${caps.length} action host functions)</summary>
      <dl class="kv"><dt>action host functions</dt><dd>${caps.map(esc).join("<br>") || "none"}</dd>
      <dt>methods</dt><dd>${methods.map(esc).join(", ")}</dd>
      <dt>call-path analysis</dt><dd>${w.reachability.available ? `${w.reachability.functions} functions, ${w.dispatchers} generic action dispatcher(s)` : esc(w.reachability.reason)}</dd></dl>
    </details>` : ""}
    <p class="small muted">${r.rpcCalls} public RPC calls, made by your browser. <a href="${explorerAccount(r.network, r.account)}">Explorer</a> · CLI: <code>npx keyhole inspect ${esc(r.account)} --evidence</code>. ${esc(r.disclaimer)}</p>
  </div>`;
}

export function wireCopy(root: HTMLElement) {
  root.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest("button[data-copy]") as HTMLButtonElement | null;
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy!);
      b.textContent = "copied";
      setTimeout(() => (b.textContent = "copy"), 1200);
    } catch {
      b.textContent = "select";
    }
  });
}
