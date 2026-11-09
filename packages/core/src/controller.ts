// Who can act as an account (and so change code it controls)? Best effort, always labelled
// "inferred" when it rests on a view method's answer rather than on protocol facts.
import type { Rpc } from "./rpc.ts";
import { RpcAnswerError } from "./rpc.ts";
import { EMPTY_CODE_HASH } from "./hash.ts";
import { analyzeWasm } from "./wasm.ts";
import { ev, type Evidence } from "./evidence.ts";

export interface DaoInfo {
  kind: "sputnik";
  /** Smallest number of approvals any role needs to pass the weakest relevant proposal kind. */
  requiredApprovals: number | null;
  /** Size of the role that sets requiredApprovals. */
  roleSize: number | null;
  roleName: string | null;
  proposalKind: string | null;
  tokenWeighted: boolean;
  /** Kept for display only: Sputnik v2 does not count Everyone-role votes towards approval. */
  everyoneCanApprove: boolean;
  roles: { name: string; members: number | "everyone" | "token-holders"; canApprove: string[] }[];
}

export interface ActorInfo {
  account: string;
  exists: boolean;
  hasCode: boolean;
  fullAccessKeys: number;
  dao?: DaoInfo;
  multisig?: { required: number | null; members: number | null };
  /** true: one key alone can act as this account. false: at least 2 independent approvals are
   *  required on every path. null: Keyhole could not tell. */
  singleKey: boolean | null;
  summary: string;
  evidence: Evidence[];
}

// Sputnik proposal kinds through which a DAO can change a contract it owns: a function call
// (e.g. `upgrade`), a remote upgrade, or first rewriting its own policy.
const DAO_KINDS = ["call", "upgrade_remote", "upgrade_self", "policy", "policy_update_default_vote_policy", "policy_add_or_update_role"];

function permits(perms: string[], kind: string): boolean {
  return perms.some((p) => {
    const [k, a] = p.split(":");
    return (k === kind || k === "*") && (a === "VoteApprove" || a === "*");
  });
}

/** Sputnik v2 threshold: Weight(w) → min(w, total); Ratio(n, d) → min(total*n/d + 1, total); then max with quorum. */
export function sputnikRequired(threshold: unknown, quorum: unknown, total: number): number {
  let t: number;
  if (Array.isArray(threshold)) t = Math.min(Math.floor((total * Number(threshold[0])) / Number(threshold[1])) + 1, total);
  else t = Math.min(Number(threshold), total);
  return Math.max(t, Number(quorum ?? 0));
}

export function analyzeSputnikPolicy(policy: any): DaoInfo {
  const info: DaoInfo = { kind: "sputnik", requiredApprovals: null, roleSize: null, roleName: null, proposalKind: null, tokenWeighted: false, everyoneCanApprove: false, roles: [] };
  for (const role of policy?.roles ?? []) {
    const perms: string[] = role.permissions ?? [];
    const canApprove = DAO_KINDS.filter((k) => permits(perms, k));
    const k = role.kind;
    const members = k === "Everyone" ? "everyone" : k?.Group ? k.Group.length : k?.Member !== undefined ? "token-holders" : 0;
    info.roles.push({ name: role.name, members, canApprove });
    if (!canApprove.length) continue;
    if (members === "everyone") info.everyoneCanApprove = true;
    // sputnikdao2 policy.rs proposal_status(): `RoleKind::Everyone => continue` — votes cast
    // under an Everyone role never approve a proposal on their own, so it is not a control path.
    if (members === "everyone") continue;
    for (const kind of canApprove) {
      const vp = role.vote_policy?.[kind] ?? policy.default_vote_policy;
      if (vp?.weight_kind === "TokenWeight" || members === "token-holders") {
        info.tokenWeighted = true;
        continue;
      }
      const n = members as number;
      const req = sputnikRequired(vp?.threshold, vp?.quorum, n);
      if (info.requiredApprovals === null || req < info.requiredApprovals) {
        Object.assign(info, { requiredApprovals: req, roleSize: n, roleName: role.name, proposalKind: kind });
      }
    }
  }
  return info;
}

/** Resolve who can act as `account`. One level: keys, Sputnik DAO policy or multisig config. */
export async function resolveActor(rpc: Rpc, account: string): Promise<ActorInfo> {
  const n = rpc.network;
  const evidence: Evidence[] = [ev.account(n, account)];
  let view;
  try {
    view = await rpc.viewAccount(account);
  } catch (e) {
    if (e instanceof RpcAnswerError) {
      return { account, exists: false, hasCode: false, fullAccessKeys: 0, singleKey: null, summary: `${account} does not exist`, evidence };
    }
    throw e;
  }
  const keys = await rpc.viewAccessKeys(account);
  evidence.push(ev.keys(n, account));
  const fak = keys.filter((k) => k.access_key.permission === "FullAccess").length;
  const hasCode = view.code_hash !== EMPTY_CODE_HASH || Boolean(view.global_contract_hash || view.global_contract_account_id);
  const base = { account, exists: true, hasCode, fullAccessKeys: fak, evidence };
  if (fak > 0) {
    return { ...base, singleKey: true, summary: `${account} has ${fak} full-access key${fak === 1 ? "" : "s"}; any one of them can act alone` };
  }
  if (!hasCode) {
    return { ...base, singleKey: false, summary: `${account} has no full-access keys and no code, so nobody can sign as it` };
  }
  const { code } = await rpc.viewCode(account);
  const exports = analyzeWasm(code).exports;
  if (exports.includes("get_policy")) {
    const policy = await rpc.view<any>(account, "get_policy");
    evidence.push(ev.view(n, account, "get_policy"));
    const dao = analyzeSputnikPolicy(policy);
    let singleKey: boolean | null = null;
    let summary: string;
    if (dao.requiredApprovals !== null) {
      singleKey = dao.requiredApprovals <= 1;
      summary = `Sputnik DAO ${account}: ${dao.requiredApprovals} of ${dao.roleSize} "${dao.roleName}" members can pass a "${dao.proposalKind}" proposal`;
      if (dao.tokenWeighted) summary += " (some roles are token-weighted)";
    } else {
      summary = dao.tokenWeighted ? `Sputnik DAO ${account}: token-weighted voting` : `Sputnik DAO ${account}: no role can approve calls or upgrades`;
      singleKey = dao.tokenWeighted ? null : false;
    }
    return { ...base, dao, singleKey, summary };
  }
  if (exports.includes("get_num_confirmations")) {
    const required = await rpc.tryView<number>(account, "get_num_confirmations");
    evidence.push(ev.view(n, account, "get_num_confirmations"));
    const members = exports.includes("get_members") ? await rpc.tryView<any[]>(account, "get_members") : null;
    const req = typeof required === "number" ? required : null;
    return {
      ...base,
      multisig: { required: req, members: members?.length ?? null },
      singleKey: req === null ? null : req <= 1,
      summary: `multisig ${account}: ${req ?? "?"} of ${members?.length ?? "?"} members must confirm`,
    };
  }
  if (exports.includes("acl_get_super_admins")) {
    // A near-plugins super admin can grant itself any role, so it controls this contract.
    const args = { skip: 0, limit: 20 };
    const admins = ((await rpc.tryView<string[]>(account, "acl_get_super_admins", args)) ?? []).filter((a) => a !== account);
    evidence.push(ev.view(n, account, "acl_get_super_admins", args));
    const withKeys: string[] = [];
    for (const a of admins) {
      try {
        const k = await rpc.viewAccessKeys(a);
        if (k.some((x) => x.access_key.permission === "FullAccess")) withKeys.push(a);
      } catch {
        /* missing account: ignore */
      }
    }
    if (withKeys.length) return { ...base, singleKey: true, summary: `${account} is a near-plugins contract whose super admin ${withKeys.join(", ")} holds full-access keys` };
    return { ...base, singleKey: null, summary: `${account} is a near-plugins contract (super admins: ${admins.join(", ") || "none"}); its other roles were not resolved` };
  }
  return { ...base, singleKey: null, summary: `${account} is a contract with no full-access keys; who controls it was not resolved` };
}

// ── Owner discovery on the inspected contract ─────────────────────────────────────────────────
const DIRECT_OWNER_VIEWS = ["get_owner", "get_owner_id", "owner_id", "owner", "get_owner_account_id", "owner_get", "get_admin", "admin"];
const OBJECT_VIEWS = ["get_config", "get_metadata", "get_contract_state", "get_contract_info", "get_info", "metadata", "get_state", "contract_metadata", "get_contract_metadata"];
const OWNER_KEY = /^(owner|owner_id|owner_account_id|admin|admin_id|admin_account_id|governance|governance_id|governance_account_id|dao|dao_id|dao_account_id|super_admin|manager|manager_id|operator_account_id)$/i;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface OwnerCandidate {
  account: string;
  source: string; // e.g. "get_config().owner_id"
  evidence: Evidence;
  /** true when the source does not prove this account can trigger the upgrade (e.g. an Ownable
   *  owner on a contract whose upgrade method is gated by near-plugins ACL roles). */
  uncertain?: boolean;
}

function findOwnerFields(obj: unknown, prefix: string, out: { path: string; value: string }[], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string" && OWNER_KEY.test(k) && ACCOUNT_ID.test(v)) out.push({ path: `${prefix}.${k}`, value: v });
    else if (v && typeof v === "object" && !Array.isArray(v)) findOwnerFields(v, `${prefix}.${k}`, out, depth + 1);
  }
}

export interface DeployerRoles {
  roles: string[];
  /** Where the role list came from, e.g. the source file URL at the declared rev. */
  source: string;
  /** true when the source is verified to build the deployed code (reproducible build / SourceScan). */
  certain: boolean;
}

/** Read near-plugins `code_deployers(Role::A, Role::B)` from the contract's declared source. */
export async function deployerRolesFromSource(github: { owner: string; repo: string; rev: string | null } | null, contractPath: string | undefined, fetchText: (url: string) => Promise<string | null> = defaultFetchText): Promise<{ roles: string[]; source: string } | null> {
  if (!github?.rev) return null;
  const dir = (contractPath ?? "").replace(/^\/+|\/+$/g, "");
  const url = `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${github.rev}/${dir ? dir + "/" : ""}src/lib.rs`;
  const text = await fetchText(url);
  if (!text) return null;
  const m = text.match(/code_deployers\s*\(([^)]*)\)/);
  if (!m) return null;
  const roles = [...m[1].matchAll(/Role::(\w+)/g)].map((x) => x[1]);
  return roles.length ? { roles, source: url } : null;
}
async function defaultFetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

/** near-plugins role names that deploy the contract's own code in contracts seen on mainnet. */
const KNOWN_DEPLOYER_ROLES = ["UpgradableCodeDeployer", "Upgrader", "CodeDeployer", "UpgradeManager"];
/** Other role names that might deploy code; their grantees can only make a path "unresolved". */
const POSSIBLE_DEPLOYER_ROLE = /upgrad|deploy|^dao$/i;

/** Ask the contract who owns it, using only view methods it actually exports. */
export async function discoverOwners(rpc: Rpc, account: string, exports: string[], deployerRoles?: DeployerRoles | null): Promise<OwnerCandidate[]> {
  const n = rpc.network;
  const found: OwnerCandidate[] = [];
  const add = (acc: string, source: string, evidence: Evidence, uncertain = false) => {
    const prev = found.find((f) => f.account === acc);
    if (!prev) found.push({ account: acc, source, evidence, uncertain });
    else if (prev.uncertain && !uncertain) Object.assign(prev, { source, evidence, uncertain: false });
  };
  // near-plugins ACL: super admins can grant themselves any role; holders of the Upgradable
  // plugin's deployer role can call up_deploy_code directly. Both are read from the chain.
  const acl = exports.includes("acl_get_super_admins");
  if (acl) {
    const args = { skip: 0, limit: 20 };
    const v = await rpc.tryView<string[]>(account, "acl_get_super_admins", args);
    for (const a of v ?? []) add(a, "acl_get_super_admins() (near-plugins ACL super admin)", ev.view(n, account, "acl_get_super_admins", args));
    if (exports.includes("acl_role_variants") && exports.includes("acl_get_grantees")) {
      const roles = (await rpc.tryView<string[]>(account, "acl_role_variants")) ?? [];
      for (const role of roles) {
        // From source: exactly the declared code_deployers. Otherwise: known names (certain) and
        // possible names (uncertain). Names like TokenDeployer on omni.bridge.near deploy *other*
        // contracts; without source they can only make the path "unresolved", never "single-key".
        let certain: boolean;
        let why: string;
        if (deployerRoles) {
          if (!deployerRoles.roles.includes(role)) continue;
          certain = deployerRoles.certain;
          why = `code_deployers in ${deployerRoles.certain ? "verified" : "declared, unverified"} source`;
        } else if (KNOWN_DEPLOYER_ROLES.includes(role)) {
          (certain = true), (why = "near-plugins deployer role");
        } else if (POSSIBLE_DEPLOYER_ROLE.test(role) && !/stag/i.test(role)) {
          (certain = false), (why = "role name suggests it may deploy code; not confirmed");
        } else continue;
        const gArgs = { role, skip: 0, limit: 20 };
        const g = await rpc.tryView<string[]>(account, "acl_get_grantees", gArgs);
        for (const a of g ?? []) add(a, `acl_get_grantees(${role}) (${why})`, ev.view(n, account, "acl_get_grantees", gArgs), !certain);
      }
    }
  }
  for (const m of DIRECT_OWNER_VIEWS.filter((m) => exports.includes(m))) {
    const v = await rpc.tryView<unknown>(account, m);
    // With ACL present, an Ownable owner gates upgrades only in older near-plugins versions.
    if (typeof v === "string" && ACCOUNT_ID.test(v)) add(v, acl ? `${m}() (Ownable owner; upgrade rights depend on ACL config)` : `${m}()`, ev.view(n, account, m), acl);
  }
  if (!found.length) {
    for (const m of OBJECT_VIEWS.filter((m) => exports.includes(m))) {
      const v = await rpc.tryView<unknown>(account, m);
      const fields: { path: string; value: string }[] = [];
      findOwnerFields(v, `${m}()`, fields);
      for (const f of fields) add(f.value, f.path, ev.view(n, account, m));
      if (found.length) break;
    }
  }
  return found;
}
