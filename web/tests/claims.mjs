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

export function checkClaims(ok) {
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
