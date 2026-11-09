// Grade a *pending* upgrade: what can the new code do that the live code cannot, and is the new
// code verified? A pure function, so the guardian's decision to fire a hatch can be re-run by
// anyone from the same inputs. Rules: docs/GRADING.md "Upgrade grading" (and GUARDIAN_DESIGN.md).
//
// The diff only sees wasm exports and host-call reachability. A logic change inside an existing
// method (e.g. withdraw sending half) is invisible to it; that is why unverified code is never OK.
import { exportDiff, type Capability, type ExportDiff, type WasmAnalysis } from "./wasm.ts";

export type UpgradeFlag =
  | "PENDING_CODE_UNAVAILABLE"
  | "UNVERIFIED_PENDING_CODE"
  | "NEW_CODE_CHANGE_PATH"
  | "NEW_MONEY_PATH"
  | "EXIT_METHOD_REMOVED"
  | "NEW_KEY_PATH"
  | "AI_REVIEW_HIGH"
  | "NO_CHANGE";

export interface UpgradeGradeInput {
  target: string;
  live_hash: string;
  pending_hash: string | null;
  live: WasmAnalysis | null;
  pending: WasmAnalysis | null;
  verified: { reproducible: boolean | null; sourcescan: boolean | null; registry_review?: string | null };
  review?: { risk: "high" | "medium" | "low" | "none"; summary: string } | null;
}

export interface UpgradeGrade {
  verdict: "OK" | "CAUTION" | "STOP";
  flags: UpgradeFlag[];
  reasons: { severity: "stop" | "caution" | "info" | "ok"; text: string }[];
  diff: ExportDiff | null;
  /** What the default "strict" auto-fire policy would do. */
  fire: boolean;
  headline: string;
}

export const UPGRADE_CODE_CHANGE_CAPS: Capability[] = ["deploy_contract", "use_global_contract", "add_full_access_key", "delete_account"];
export const UPGRADE_KEY_CAPS: Capability[] = ["add_function_call_key", "delete_key"];
/** Flags that make unverified code a STOP. */
const DANGER: UpgradeFlag[] = ["NEW_CODE_CHANGE_PATH", "NEW_MONEY_PATH", "EXIT_METHOD_REMOVED", "NEW_KEY_PATH"];

/** The analysis of "no code": every capability of the pending code counts as new against it. */
const EMPTY: WasmAnalysis = {
  size: 0,
  imports: [],
  exports: [],
  capabilities: {},
  codeChangeEntrypoints: [],
  codeChangeViaDispatcher: [],
  dispatchers: 0,
  upgradeLikeNames: [],
  reachability: { available: true, functions: 0, indirectTargets: 0 },
};

const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
const human = (c: Capability) => c.replace(/_/g, " ");

/** What the pending code adds for one capability: newly added at import level, and exported
 *  methods with a specific (non-dispatcher) path to it that had none before. */
function gained(live: WasmAnalysis, pending: WasmAnalysis, addedMethods: string[], cap: Capability) {
  const p = pending.capabilities[cap];
  if (!p) return null;
  const l = live.capabilities[cap];
  const added = !l;
  if (p.reachableFrom === null) {
    // Reachability unavailable for the pending code: assume the worst for an added capability
    // or for added methods (they may reach it); nothing can be claimed about existing methods.
    if (added || addedMethods.length) return { added, methods: added ? [] : addedMethods, assumed: true };
    return null;
  }
  // Live reachability unavailable: compare only methods that are new in the pending code.
  const before = l?.reachableFrom ?? (l ? null : []);
  const methods = before === null ? p.reachableFrom.filter((m) => addedMethods.includes(m)) : p.reachableFrom.filter((m) => !before.includes(m));
  if (!added && !methods.length) return null;
  return { added, methods, assumed: false };
}

export function gradeUpgrade(i: UpgradeGradeInput): UpgradeGrade {
  const flags: UpgradeFlag[] = [];
  const reasons: UpgradeGrade["reasons"] = [];
  const flag = (f: UpgradeFlag) => flags.includes(f) || flags.push(f);

  // AI review: an explicit review wins; otherwise a registry AiReview summary "<risk>: <text>".
  const regRisk = i.verified.registry_review?.match(/^(high|medium|low|none)\b/)?.[1] as "high" | "medium" | "low" | "none" | undefined;
  const review = i.review ?? (regRisk ? { risk: regRisk, summary: i.verified.registry_review!.replace(/^\w+:\s*/, "") } : null);
  const aiHigh = review?.risk === "high";
  const aiReasons = () => {
    if (!review) return;
    if (review.risk === "high") reasons.push({ severity: "stop", text: `AI review of the pending code reports high risk: ${review.summary}` });
    else if (review.risk === "medium") reasons.push({ severity: "caution", text: `AI review of the pending code reports medium risk (shown, does not change the verdict): ${review.summary}` });
    else reasons.push({ severity: "info", text: `AI review of the pending code reports ${review.risk} risk: ${review.summary}` });
  };

  // ── Same code: the upgrade changes nothing. ──
  if (i.pending_hash !== null && i.pending_hash === i.live_hash) {
    flag("NO_CHANGE");
    reasons.push({ severity: "ok", text: `The proposed code ${short(i.pending_hash)} is the code ${i.target} already runs; deploying it changes nothing.` });
    if (aiHigh) flag("AI_REVIEW_HIGH");
    aiReasons();
    const verdict = aiHigh ? "STOP" : "OK";
    return { verdict, flags, reasons, diff: i.live && i.pending ? exportDiff(i.live, i.pending) : null, fire: verdict === "STOP", headline: aiHigh ? `STOP: no code change, but an AI review of this code reports high risk.` : `OK: the proposed code is already live on ${i.target}.` };
  }

  // ── Is the pending code verified? ──
  const verified = i.pending_hash !== null && (i.verified.reproducible === true || i.verified.sourcescan === true);
  if (!verified) {
    flag("UNVERIFIED_PENDING_CODE");
    const what = [i.verified.reproducible === false ? "a reproducible build did not match" : "no matching reproducible build", i.verified.sourcescan === null ? "SourceScan not checked" : "no SourceScan verification"].join(", ");
    reasons.push({ severity: "caution", text: i.pending_hash ? `Pending code ${short(i.pending_hash)} is not verified (${what}). Nobody has shown which source it was built from.` : "The pending code hash is unknown, so it cannot be verified." });
  } else {
    reasons.push({ severity: "ok", text: `Pending code ${short(i.pending_hash!)} is verified (${[i.verified.reproducible === true && "reproducible build matches", i.verified.sourcescan === true && "SourceScan"].filter(Boolean).join(", ")}).` });
  }

  // ── Can we see the bytes? ──
  let diff: ExportDiff | null = null;
  if (!i.pending) {
    flag("PENDING_CODE_UNAVAILABLE");
    reasons.push({ severity: "caution", text: `The pending code${i.pending_hash ? ` ${short(i.pending_hash)}` : ""} could not be fetched, so what it can do is unknown.` });
  } else {
    const live = i.live ?? EMPTY;
    if (!i.live) reasons.push({ severity: "info", text: `No analysis of the live code of ${i.target}; every capability of the pending code counts as new.` });
    const d = exportDiff(live, i.pending);
    diff = i.live ? d : null;

    // NEW_CODE_CHANGE_PATH / NEW_KEY_PATH / NEW_MONEY_PATH
    const groups: [UpgradeFlag, Capability[], string][] = [
      ["NEW_CODE_CHANGE_PATH", UPGRADE_CODE_CHANGE_CAPS, "replace the code or the account"],
      ["NEW_KEY_PATH", UPGRADE_KEY_CAPS, "change the account's access keys"],
    ];
    for (const [f, caps, why] of groups) {
      for (const cap of caps) {
        const g = gained(live, i.pending, d.addedMethods, cap);
        if (!g) continue;
        flag(f);
        const parts = [g.added && `adds the ${human(cap)} host function`, g.methods.length && `${g.assumed ? "may reach" : "reaches"} ${human(cap)} from ${list(g.methods)}`].filter(Boolean).join(" and ");
        reasons.push({ severity: verified ? "caution" : "stop", text: `New code ${parts}${g.assumed ? " (call graph unavailable; assumed)" : ""}: a new way to ${why}.` });
      }
    }
    const money = gained(live, i.pending, d.addedMethods, "transfer");
    if (money && money.methods.length) {
      flag("NEW_MONEY_PATH");
      const fresh = money.methods.filter((m) => d.addedMethods.includes(m));
      const old = money.methods.filter((m) => !d.addedMethods.includes(m));
      const parts = [fresh.length && `added method${fresh.length > 1 ? "s" : ""} ${list(fresh)}`, old.length && `existing method${old.length > 1 ? "s" : ""} ${list(old)}`].filter(Boolean).join(" and ");
      reasons.push({ severity: verified ? "caution" : "stop", text: `New money path: ${parts} ${money.assumed ? "may reach" : "reach"} transfer through a specific call path${money.assumed ? " (call graph unavailable; assumed)" : ""}.` });
    }

    // EXIT_METHOD_REMOVED: a method that could move funds out in the live code is gone. Without a
    // live call graph, any removed export of code that imports transfer may have been one (assumed,
    // as gained() assumes for the pending side).
    const lt = live.capabilities.transfer;
    const liveUnknown = Boolean(lt) && lt!.reachableFrom === null;
    const exits = d.removedMethods.filter((m) => liveUnknown || lt?.reachableFrom?.includes(m) || lt?.viaDispatcherOnly?.includes(m));
    if (exits.length) {
      flag("EXIT_METHOD_REMOVED");
      reasons.push({ severity: verified ? "caution" : "stop", text: liveUnknown ? `Removes ${list(exits)}, which may have reached transfer in the live code (live call graph unavailable; assumed): a way to get funds out may disappear.` : `Removes ${list(exits)}, which reached transfer in the live code: a way to get funds out disappears.` });
    }
    // Other differences are informational: they do not set a flag.
    const other = [
      d.addedMethods.length && `+${d.addedMethods.length} method${d.addedMethods.length > 1 ? "s" : ""} (${d.addedMethods.slice(0, 6).join(", ")}${d.addedMethods.length > 6 ? ", …" : ""})`,
      d.removedMethods.length && `-${d.removedMethods.length} method${d.removedMethods.length > 1 ? "s" : ""} (${d.removedMethods.slice(0, 6).join(", ")}${d.removedMethods.length > 6 ? ", …" : ""})`,
      d.addedHostImports.length && `+host imports ${d.addedHostImports.join(", ")}`,
    ].filter(Boolean);
    if (other.length && i.live) reasons.push({ severity: "info", text: `Export diff vs live: ${other.join("; ")}.` });
    if (!DANGER.some((f) => flags.includes(f))) reasons.push({ severity: "info", text: "No new code-change, key or NEAR transfer path, and no exit method removed (wasm export and call-graph diff). Not compared: logic inside existing methods, and token transfers, which are cross-contract calls (e.g. ft_transfer), not transfer actions." });
  }

  if (aiHigh) flag("AI_REVIEW_HIGH");
  aiReasons();

  const danger = DANGER.filter((f) => flags.includes(f));
  const unverified = flags.includes("UNVERIFIED_PENDING_CODE");
  let verdict: UpgradeGrade["verdict"];
  if ((unverified && danger.length) || aiHigh) verdict = "STOP";
  else if (flags.some((f) => f !== "NO_CHANGE")) verdict = "CAUTION";
  else verdict = "OK";

  let headline: string;
  if (verdict === "STOP") {
    headline = aiHigh && !(unverified && danger.length) ? `STOP: an AI review of the pending code for ${i.target} reports high risk.` : `STOP: unverified code for ${i.target} ${describe(danger)}.`;
  } else if (verdict === "CAUTION") {
    headline = flags.includes("PENDING_CODE_UNAVAILABLE")
      ? `CAUTION: the pending code for ${i.target} could not be read${unverified ? " and is not verified" : ""}.`
      : unverified
        ? `CAUTION: the pending code for ${i.target} is not verified; its export diff shows no new dangerous path.`
        : `CAUTION: verified code for ${i.target} ${describe(danger)}.`;
  } else headline = `OK: the pending code for ${i.target} is verified and adds no new code-change, key or NEAR transfer path.`;

  return { verdict, flags, reasons, diff, fire: verdict === "STOP", headline };
}

function describe(danger: UpgradeFlag[]): string {
  const t: Record<string, string> = {
    NEW_CODE_CHANGE_PATH: "adds a new way to replace code",
    NEW_MONEY_PATH: "adds a new path to move funds",
    EXIT_METHOD_REMOVED: "removes a withdraw path",
    NEW_KEY_PATH: "adds a new way to change keys",
  };
  const parts = danger.map((f) => t[f]);
  return parts.length ? parts.join(", ") : "changes code";
}

function short(h: string): string {
  return h.length > 12 ? `${h.slice(0, 8)}…` : h;
}
