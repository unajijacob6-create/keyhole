// Claims checks, run by smoke.mjs before the browser starts. Offline, file reads only.
// Every number the README, docs/GUARDIAN.md and the site copy state about the upgrade eval and the
// survey must equal the data file it comes from, and statements the adversarial review found false
// or unsourced must not come back.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");
// The same formatting as the upgrade eval report (docs/EVAL_UPGRADES.md).
const fmt = (x) => (x < 120 ? `${x} s` : x < 7200 ? `${(x / 60).toFixed(1)} min` : `${(x / 3600).toFixed(1)} h`);

/** True when the in-browser grader may grade this radar proposal (web/src/guardian.ts canGrade). */
export const gradeable = (p) => Boolean(p?.code_hash) && !p?.registers_release && (p?.state === "pending" || (p?.state === "executed" && Boolean(p?.changed_at_height)));

// ── Intra-repo markdown links (README.md and docs/*.md) ──────────────────────────────────────
// GitHub's heading slug: drop markup, lower-case, keep letters, digits, space, '-' and '_', spaces → '-'.
const slug = (h) => h.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
const outsideFences = (src) => {
  let fence = false;
  return src.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) return (fence = !fence), "";
    return fence ? "" : line;
  });
};
/** The anchors a markdown file defines: heading slugs (with GitHub's -1, -2 for repeats) and explicit <a id>/<a name>. */
export function mdAnchors(file) {
  const out = new Set();
  const seen = {};
  for (const line of outsideFences(read(file))) {
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const s = slug(h[1]);
      const n = seen[s] ?? 0;
      seen[s] = n + 1;
      out.add(n ? `${s}-${n}` : s);
    }
  }
  return out;
}
/** Every relative link in `file` whose target file, or whose #anchor in a .md target, does not exist. */
export function brokenLinks(file) {
  const bad = [];
  outsideFences(read(file)).forEach((line, i) => {
    for (const m of line.replace(/`[^`]*`/g, "").matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const t = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // http:, https:, mailto:
      const [p, a] = t.split("#");
      const target = p ? path.posix.join(path.posix.dirname(file), decodeURIComponent(p)) : file;
      if (!fs.existsSync(path.join(ROOT, target))) bad.push(`${file}:${i + 1} ${t} (no such file)`);
      else if (a && target.endsWith(".md") && !mdAnchors(target).has(a)) bad.push(`${file}:${i + 1} ${t} (no such anchor)`);
    }
  });
  return bad;
}
export function checkLinks(ok) {
  const files = ["README.md", ...fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`), "packages/guard/README.md", "packages/mcp/README.md"];
  const bad = files.flatMap(brokenLinks);
  ok(bad.length === 0, `claims: every relative link in README.md, docs/*.md and the guard/mcp READMEs resolves (${files.length} files)${bad.length ? `; broken: ${bad.join("; ")}` : ""}`);
}

/** The deposits data/guardian-run.json records (step 1's line "vault total X NEAR (alice A, bob B)"), in NEAR. */
export function recordedDeposits() {
  const run = JSON.parse(read("data/guardian-run.json"));
  for (const s of run.steps ?? []) for (const l of s.lines ?? []) {
    const m = /\(alice (\d+(?:\.\d+)?), bob (\d+(?:\.\d+)?)\)/.exec(l);
    if (m) return { alice: Number(m[1]), bob: Number(m[2]) };
  }
  return null;
}

// Second-round review items (C1-C9): wording that was too strong must not come back, and the
// replacements must say what the code and data support.
export function checkRound2(ok) {
  const flatRead = (f) => flat(read(f));
  const html = flatRead("web/index.html");
  const gts = read("web/src/guardian.ts");
  const readme = flatRead("README.md");
  const guardianMd = flatRead("docs/GUARDIAN.md");
  const banned = [
    // C1: the hatch is not guaranteed to land before execution.
    [/gets you out before the vote lands/i, ["web/index.html", "README.md", "docs/GUARDIAN.md"], "C1 'gets you out before the vote lands'"],
    // C2: the blob precedes execution, not necessarily the deciding vote (sputnikdao2 v3 Finalize can re-execute).
    [/on chain before the deciding vote|reads them before the vote|reads those bytes before the deciding vote/i, ["web/index.html", "web/src/guardian.ts", "README.md", "docs/GUARDIAN.md"], "C2 blob 'before the deciding vote'"],
    // C3: the eval table label.
    [/public before the vote/i, ["scripts/eval-upgrades.ts", "docs/EVAL_UPGRADES.md"], "C3 'store_blob tx (public before the vote)'"],
    // C4: stale AI-grade and hatch statements outside the copy checked above.
    [/AI never sets/i, ["packages/core/src/grade.ts", "scripts/eval-review.ts", "docs/EVAL_REVIEW.md"], "C4 'AI never sets it/the grade'"],
    [/cannot redirect funds/i, ["packages/hatch/src/index.ts"], "C4 hatch 'cannot redirect funds'"],
    [/only when an upgrade is graded STOP/i, ["packages/hatch/package.json"], "C4 hatch description 'only when an upgrade is graded STOP'"],
    // C6: a stale fixed check count, and "re-derives every claim".
    [/\b\d+\/\d+ checks\b/, ["docs/GUARDIAN.md", "README.md"], "C6 fixed 'N/N checks' count"],
    [/re-derives every claim/i, ["web/src/guardian.ts", "web/index.html"], "C6 're-derives every claim'"],
    // C7: the replaced code is read just before the change block, possibly a few blocks earlier.
    [/block \$\{p\.changed_at_height - 1\}/, ["web/src/guardian.ts"], "C7 'block changed_at_height-1'"],
    // C8: amounts in the replay come from data/guardian-run.json, not literals.
    [/["'`][^"'`\n]*\b\d+\.\d{2} NEAR/, ["web/src/guardian.ts"], "C8 hard-coded NEAR amounts in the replay"],
  ];
  for (const [re, fs_, what] of banned) {
    const hits = fs_.filter((f) => re.test(read(f)));
    ok(hits.length === 0, `claims: no ${what}${hits.length ? ` (found in ${hits.join(", ")})` : ""}`);
  }
  // C1: the intro says the head start is not guaranteed and points at the limits.
  ok(/before the upgrade executes when the window allows; that is not guaranteed/.test(html) && /href="#limits"/.test(html), "claims: index.html intro says the hatch can land before execution, not guaranteed");
  // C2: the blob claim is "before the proposal executes" where it is made.
  ok(/must be on chain before the proposal executes/.test(html) && /must be on chain before the proposal executes/.test(flat(gts)) && /on chain before execution/.test(gts), "claims: index.html and the radar say the store_blob precedes execution");
  // C3: the generated eval report explains the label.
  ok(/so the `store_blob` always precedes execution/.test(flatRead("docs/EVAL_UPGRADES.md")), "claims: EVAL_UPGRADES.md explains that a store_blob precedes execution");
  // C4: the replacements are precise.
  ok(/fixes receiver, method, args and deposit/.test(read("packages/hatch/src/index.ts")) && /decides where the funds go/.test(read("packages/hatch/src/index.ts")), "claims: hatch source comment says the signature fixes the call and the venue's code decides where funds go");
  ok(/decides where the funds go/.test(JSON.parse(read("packages/hatch/package.json")).description), "claims: hatch package description says the venue's code decides where funds go");
  for (const f of ["scripts/eval-review.ts", "docs/EVAL_REVIEW.md"]) ok(/an AI review changes a grade only by the fixed rules/.test(read(f)), `claims: ${f} says the AI review counts only by the fixed rules`);
  // C6: the check count is dated, and the replay copy names what it checks.
  ok(/all checks pass \(\d+ on \d{4}-\d{2}-\d{2}\)/.test(guardianMd), "claims: GUARDIAN.md states the replay check count with its date");
  ok(/fetches each recorded transaction from testnet archival RPC and checks its signer, receiver, call and block/.test(flat(gts)), "claims: the site says what the replay checks");
  // C7: the radar text says what "All" shows.
  ok(/"All" shows the \$\{RADAR_SHOWN\} most recent across/.test(gts) && /slice\(0, RADAR_SHOWN\)/.test(gts), "claims: the radar text and its 'All' filter use the same count");
  ok(/just before block \$\{p\.changed_at_height\}/.test(gts), "claims: the in-browser grade says 'the code just before block <changed_at_height>'");
  // C8: the recording has the amounts the replay shows.
  ok(recordedDeposits() !== null, `claims: data/guardian-run.json records the deposits the replay shows (${JSON.stringify(recordedDeposits())})`);
  // C9: README "For agents" names what exists in the code.
  const mcpSrc = read("packages/mcp/src/tools.ts") + read("packages/mcp/src/server.ts");
  const tools = ["keyhole_inspect", "keyhole_pending", "keyhole_check_call", "keyhole_verify_hatch"];
  ok(/## For agents/.test(readme) && tools.every((t) => readme.includes(t) && mcpSrc.includes(`name: "${t}"`)), "claims: README 'For agents' names the four MCP tools, each registered in packages/mcp/src");
  ok(/\(packages\/guard\/README\.md\)/.test(readme) && /\(packages\/mcp\/README\.md\)/.test(readme), "claims: README links the guard and MCP READMEs");
  const guardSrc = read("packages/guard/src/index.ts");
  ok(/checkPending/.test(guardSrc) && /policy\.checkPending/.test(readme) && /auto-hatch is testnet-only/.test(guardSrc), "claims: README's guardCall statements (checkPending, testnet-only auto-hatch) match packages/guard/src");
}

export function checkClaims(ok) {
  checkLinks(ok);
  checkRound2(ok);
  const ev = JSON.parse(read("eval/upgrades.json"));
  const S = ev.summary;
  const readme = read("README.md");
  const guardianMd = read("docs/GUARDIAN.md");
  const hatchMd = read("docs/HATCH.md");
  const html = read("web/index.html");

  // Upgrade eval numbers (README Results, GUARDIAN.md proof table and limits).
  const win = `shortest ${fmt(S.window_min_s)}, median ${fmt(S.window_median_s)}, longest ${fmt(S.window_max_s)}`;
  for (const [name, doc] of [["README.md", flat(readme)], ["docs/GUARDIAN.md", flat(guardianMd)]]) {
    ok(doc.includes(`${S.executed_with_measured_window} executed`) && doc.includes(win), `claims: ${name} upgrade windows match eval/upgrades.json (${S.executed_with_measured_window} executed; ${win})`);
    ok(doc.includes(`${S.under_10_min} executed in under 10 minutes`) || doc.includes(`${S.under_10_min} under 10 minutes`), `claims: ${name} says ${S.under_10_min} under 10 minutes`);
    ok(new RegExp(`${S.release_registrations} (more are )?release registrations`).test(doc), `claims: ${name} names the ${S.release_registrations} release registrations`);
    ok(doc.includes(`${S.real_stop} of`) && doc.includes(`${S.real_graded} real upgrades`) && /grade STOP/.test(doc), `claims: ${name} says ${S.real_stop} STOP of ${S.real_graded} graded`);
    ok(doc.includes(`All ${S.real_stop} STOPs were on code without a verified build`), `claims: ${name} says all ${S.real_stop} STOPs were on unverified code`);
    ok(/counted as a false alarm/.test(doc) && /assumption, not a proof/.test(doc), `claims: ${name} states the false-alarm assumption`);
    ok(doc.includes(`${S.seeded_correct} of ${S.seeded}`) && /evil-owner/.test(doc) && /evil-fee/.test(doc), `claims: ${name} says ${S.seeded_correct} of ${S.seeded} seeded cases and names both misses`);
  }
  if (S.upgrade_proposals_with_hash !== undefined) ok(flat(readme).includes(`${S.upgrade_proposals_with_hash} real mainnet upgrade proposals`), `claims: README says ${S.upgrade_proposals_with_hash} upgrade proposals with a hash`);

  // The data behind "all STOPs were unverified; verification would have downgraded them".
  const graded = ev.real.filter((r) => r.pending && r.live);
  const stops = graded.filter((r) => r.verdict === "STOP");
  ok(stops.length === S.real_stop && stops.every((r) => r.flags.includes("UNVERIFIED_PENDING_CODE")), `claims: data backs "all STOPs on unverified code" (${stops.length} STOP rows, each UNVERIFIED_PENDING_CODE)`);
  ok(stops.every((r) => !r.flags.includes("AI_REVIEW_HIGH")), "claims: no real STOP came from an AI review, so a verified build alone would have made each CAUTION");
  const unverified = graded.filter((r) => r.flags.includes("UNVERIFIED_PENDING_CODE")).length;
  ok(flat(guardianMd).includes(`${unverified} of the ${S.real_graded} real upgrades`), `claims: GUARDIAN.md "most real upgrades are unverified" matches the data (${unverified} of ${S.real_graded})`);
  const blobs = ev.real.filter((r) => r.blob_tx).length;
  for (const [name, doc] of [["README.md", readme], ["docs/GUARDIAN.md", guardianMd]]) ok(flat(doc).includes(`${blobs} of ${ev.real.length} real proposals`),`claims: ${name} store_blob count matches the data (${blobs} of ${ev.real.length})`);

  // The radar footnote: every STOP shown on a past upgrade is unverified code with no AI review, so
  // verification alone would make it CAUTION.
  const radarStops = JSON.parse(read("data/radar.json")).daos.flatMap((d) => d.proposals).filter((p) => p.grade?.verdict === "STOP");
  ok(radarStops.every((p) => p.grade.flags.includes("UNVERIFIED_PENDING_CODE") && !p.grade.flags.includes("AI_REVIEW_HIGH")), `claims: data backs the radar's STOP footnote (${radarStops.length} STOP cards, all unverified, none from AI)`);

  // #19: the opening sentence is the survey's count, not an unsourced statement about money.
  const sv = JSON.parse(read("data/survey.json")).rows;
  const daoGoverned = sv.filter((r) => r.class === "GOVERNED" && /^DAO /.test(r.controller)).length;
  const immutable = sv.filter((r) => r.class === "IMMUTABLE").length;
  for (const [name, doc] of [["README.md", readme], ["docs/GUARDIAN.md", guardianMd], ["web/index.html", html]]) {
    const d = flat(doc);
    ok(d.includes(`${sv.length} major NEAR contracts`) && d.includes(`${daoGoverned} are governed by a Sputnik DAO`) && (immutable > 0 || d.includes("none is immutable")), `claims: ${name} opening uses the survey (${daoGoverned} of ${sv.length} DAO-governed, ${immutable} immutable)`);
  }

  // Statements found false or unsourced must not come back.
  const banned = [
    [/most of the money/i, "#19 unsourced 'most of the money'"],
    [/nowhere else/i, "#16 'nowhere else'"],
    [/cannot change where the money goes/i, "#16 'cannot change where the money goes'"],
    [/cannot redirect funds/i, "#16 'cannot redirect funds'"],
    [/only when Keyhole grades a pending change/i, "#16 'only when ... a pending change'"],
    [/to your own account, early/i, "#16 'to your own account, early'"],
    [/is about to change/i, "#16 'only when the contract is about to change'"],
    [/AI never sets the grade|never the grade|never sets the grade/i, "#17 'AI never sets the grade'"],
    [/for every DAO that controls/i, "#15 'for every DAO that controls a contract you use'"],
    [/Every upgrade proposal of/i, "#15 'Every upgrade proposal'"],
    [/before anyone votes/i, "#15 'before anyone votes'"],
    [/like Ref and Burrow\./, "#18 unqualified 'like Ref and Burrow'"],
    [/adds reading and diffing the pending wasm, verification of the\s+proposed hash/, "#20 imprecise X-Ray credit"],
  ];
  const docs = fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md") && !["EVAL_UPGRADES.md", "EVAL_REVIEW.md"].includes(f)).map((f) => `docs/${f}`);
  const files = ["README.md", "web/index.html", "web/src/guardian.ts", "web/src/main.ts", "packages/hatch/README.md", ...docs];
  for (const [re, what] of banned) {
    const hits = files.filter((f) => re.test(read(f)));
    ok(hits.length === 0, `claims: no ${what}${hits.length ? ` (found in ${hits.join(", ")})` : ""}`);
  }

  // #18: the fungible-token limitation is stated wherever the limits are.
  for (const [name, doc] of [["docs/GUARDIAN.md", guardianMd], ["docs/HATCH.md", hatchMd], ["web/index.html", html], ["README.md", readme]]) ok(/ft_transfer(?!_)[\s\S]{0,240}(no flag covers|does not flag|not a new money\s+path|is not `NEW_MONEY_PATH`)/.test(doc), `claims: ${name} states the fungible-token (ft_transfer) limitation`);
  // #17: the docs say what gradeUpgrade does with a high-risk AI review.
  for (const f of ["docs/GRADING.md", "docs/GUARDIAN.md", "README.md", "web/index.html"]) ok(/high-risk (AI )?review alone/i.test(flat(read(f))), `claims: ${f} says a high-risk AI review alone is enough for STOP`);
  // #20: Proposal X-Ray is credited for what it does.
  ok(/Proposal X-Ray\]\([^)]*\) decodes .*?flags upgrade proposals.*?checks `UpgradeSelf` hashes against the releases `sputnik-dao\.near` publishes/.test(flat(guardianMd)), "claims: GUARDIAN.md credits X-Ray's UpgradeSelf hash check");
  ok(/flags upgrade proposals, and checks `UpgradeSelf` hashes/.test(flat(readme)), "claims: README credits X-Ray's UpgradeSelf hash check");
}
