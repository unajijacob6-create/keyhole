// Build a labelled TESTNET fixture corpus for the Keyhole accuracy eval. Each fixture's expected
// class follows from how the account was built, not from what Keyhole says about it.
//   NODE_USE_ENV_PROXY=1 npx tsx scripts/eval-fixtures.ts
// Idempotent: accounts that already reached their final state are re-checked and kept, along with
// their recorded evidence; half-built ones are finished. Writes eval/testnet-fixtures.json.
// Funds come from the script's own faucet master account(s), never from other Keyhole accounts.
// Keys go to ~/.near-credentials/testnet/ and are never printed. Testnet only (scripts/lib/near.ts).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { actions, KeyPair, PublicKey } from "near-api-js";
import { account, accountExists, hasKey, log, NEAR, provider, saveKey, TGAS, txLink, view, yoctoToNear } from "./lib/near.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "eval/testnet-fixtures.json");
const EMPTY = "11111111111111111111111111111111";
const FAUCET_GRANT = 10; // NEAR per faucet account (helper.nearprotocol.com)

const wasmFile = {
  vault: "contracts/repro/demo_vault_v1.wasm",
  upgradable: "contracts/fixtures/out/fixture_upgradable.wasm",
  hidden: "contracts/fixtures/out/fixture_upgradable_hidden.wasm",
} as const;
type WasmName = keyof typeof wasmFile;
const wasm = Object.fromEntries(
  Object.entries(wasmFile).map(([k, f]) => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, f)));
    return [k, { file: f, bytes, hash: bs58.encode(createHash("sha256").update(bytes).digest()) }];
  }),
) as Record<WasmName, { file: string; bytes: Uint8Array; hash: string }>;

// Known testnet Sputnik DAOs to try first (checked on every run); then the factory's full list.
const STRONG_DAOS = ["kdd1794191632.sputnik-v2.testnet", "koperasi-mw80aczw.sputnik-v2.testnet", "payroll-demo.sputnik-v2.testnet"];
const WEAK_DAOS = ["agora-arbiter.sputnik-v2.testnet", "kdy1794161239.sputnik-v2.testnet", "bursar-bursar-demo-00784fb4.sputnik-v2.testnet"];

interface Fixture {
  account: string;
  network: "testnet";
  expected_class: "IMMUTABLE" | "GOVERNED" | "CUSTODIAL" | "UNRESOLVED" | "NO_CODE";
  construction: string;
  evidence: string[];
  details?: Record<string, unknown>;
}
interface Corpus {
  master: string;
  funders?: string[];
  createdAt: string;
  updatedAt?: string;
  helpers?: Fixture[];
  skipped?: { account: string; reason: string }[];
  fixtures: Fixture[];
}

const prev: Partial<Corpus> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const prevEvidence = (id: string) => [...(prev.fixtures ?? []), ...(prev.helpers ?? [])].find((f) => f.account === id)?.evidence ?? [];
const prevDetails = (id: string) => [...(prev.fixtures ?? []), ...(prev.helpers ?? [])].find((f) => f.account === id)?.details ?? {};

// ── chain helpers ───────────────────────────────────────────────────────────────────────────
async function state(id: string) {
  try {
    const a: any = await provider.viewAccount({ accountId: id });
    const keys: any = await provider.viewAccessKeyList({ accountId: id });
    const list = (keys.keys ?? []) as { public_key: string; access_key: { permission: any } }[];
    return {
      exists: true,
      amount: BigInt(a.amount),
      storage: Number(a.storage_usage),
      codeHash: String(a.code_hash),
      global: a.global_contract_hash ?? a.global_contract_account_id ?? null,
      fak: list.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key),
      fc: list.filter((k) => k.access_key.permission !== "FullAccess").map((k) => ({ key: k.public_key, ...k.access_key.permission.FunctionCall })),
    };
  } catch {
    return { exists: false, amount: 0n, storage: 0, codeHash: EMPTY, global: null, fak: [] as string[], fc: [] as any[] };
  }
}
const available = async (id: string) => {
  const s = await state(id);
  return s.amount - BigInt(s.storage) * 10n ** 19n; // 1e19 yocto per byte
};
const hashOf = (r: any): string => r.transaction?.hash ?? r.transaction_outcome?.id;

async function send(signer: string, receiverId: string, acts: any[]): Promise<string> {
  const r = await account(signer).signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL", throwOnFailure: true });
  const h = hashOf(r);
  log(`tx ${signer} → ${receiverId}`, txLink(h));
  return h;
}

async function faucetAccount(prefix: string): Promise<string> {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`testnet faucet refused to create ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  saveKey(id, kp);
  for (let i = 0; i < 60 && !(await accountExists(id)); i++) await new Promise((res) => setTimeout(res, 1000));
  log("faucet account", `${id} (key saved in ~/.near-credentials/testnet/)`);
  return id;
}

// ── corpus state ────────────────────────────────────────────────────────────────────────────
let master: string;
if (prev.master && hasKey(prev.master) && (await accountExists(prev.master))) {
  master = prev.master;
  log("reusing master", master);
} else {
  master = await faucetAccount("kh-fx");
}
const corpus: Corpus = {
  master,
  funders: prev.master === master ? (prev.funders ?? []) : [],
  createdAt: prev.master === master && prev.createdAt ? prev.createdAt : new Date().toISOString(),
  helpers: [],
  skipped: [],
  fixtures: [],
};
const save = () => {
  corpus.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(corpus, null, 2) + "\n");
};

/** Top up the master from a fresh faucet account when it cannot cover `need` NEAR. */
async function ensureFunds(need: number) {
  if ((await available(master)) >= NEAR(need + 0.3)) return;
  const funder = await faucetAccount("kh-fx-fund");
  const amount = (await available(funder)) - NEAR(0.05);
  const h = await send(funder, master, [actions.transfer(amount)]);
  corpus.funders!.push(funder);
  log("topped up master", `${yoctoToNear(amount)} NEAR from ${funder} (${txLink(h)})`);
}

// ── independent Sputnik policy check (ground truth; does not use Keyhole's analyzer) ─────────
const SPUTNIK_KINDS = [
  "config", "policy", "add_member_to_role", "remove_member_from_role", "call", "upgrade_self", "upgrade_remote", "transfer", "set_vote_token",
  "add_bounty", "bounty_done", "vote", "factory_info_update", "policy_add_or_update_role", "policy_remove_role", "policy_update_default_vote_policy", "policy_update_parameters",
];
interface DaoCheck { dao: string; approvals: number | null; of: number | null; role: string | null; kind: string | null; tokenWeighted: boolean; everyoneApproves: boolean; keys: number; members: string[] }
/** Fewest approvals that pass a proposal of any of `kinds`, over every group role allowed to approve it. */
async function checkDao(dao: string, kinds: string[]): Promise<DaoCheck | null> {
  let policy: any;
  try {
    policy = await view<any>(dao, "get_policy");
  } catch {
    return null;
  }
  const s = await state(dao);
  const c: DaoCheck = { dao, approvals: null, of: null, role: null, kind: null, tokenWeighted: false, everyoneApproves: false, keys: s.fak.length + s.fc.length, members: [] };
  for (const role of policy.roles ?? []) {
    for (const p of (role.permissions ?? []) as string[]) {
      const [k, a] = p.split(":");
      if (a !== "VoteApprove" && a !== "*") continue;
      for (const kind of kinds.filter((x) => k === "*" || k === x)) {
        if (role.kind === "Everyone") { c.everyoneApproves = true; continue; }
        if (!role.kind?.Group) { c.tokenWeighted = true; continue; }
        const vp = role.vote_policy?.[kind] ?? policy.default_vote_policy;
        if (vp.weight_kind !== "RoleWeight") { c.tokenWeighted = true; continue; }
        const n: number = role.kind.Group.length;
        const t = Array.isArray(vp.threshold) ? Math.min(Math.floor((n * Number(vp.threshold[0])) / Number(vp.threshold[1])) + 1, n) : Math.min(Number(vp.threshold), n);
        const req = Math.max(t, Number(vp.quorum ?? 0));
        if (c.approvals === null || req < c.approvals) Object.assign(c, { approvals: req, of: n, role: role.name, kind, members: role.kind.Group });
      }
    }
  }
  return c;
}
/** GOVERNED owner: every approving role needs >= 2 approvals for every proposal kind; no keys, no token or Everyone votes. */
const strongOk = (c: DaoCheck | null) => !!c && c.approvals !== null && c.approvals >= 2 && !c.tokenWeighted && !c.everyoneApproves && c.keys === 0;
/** CUSTODIAL owner: one member alone passes a "call" proposal, and that member signs with a full-access key. */
async function weakOk(c: DaoCheck | null) {
  if (!c || c.approvals !== 1 || c.keys !== 0) return false;
  return (await Promise.all(c.members.map(async (m) => (await state(m)).fak.length > 0))).every(Boolean);
}
async function findDao(candidates: string[], kinds: string[], ok: (c: DaoCheck | null) => boolean | Promise<boolean>): Promise<DaoCheck | null> {
  for (const d of candidates) {
    const c = await checkDao(d, kinds);
    if (await ok(c)) return c;
  }
  const all = await view<string[]>("sputnik-v2.testnet", "get_dao_list").catch(() => [] as string[]);
  for (const d of all.filter((x) => !candidates.includes(x)).reverse()) {
    const c = await checkDao(d, kinds);
    if (await ok(c)) return c;
  }
  return null;
}

// ── fixture builder ─────────────────────────────────────────────────────────────────────────
interface Spec {
  prefix: string;
  expected: Fixture["expected_class"];
  fund: number;
  code?: WasmName;
  initArgs?: Record<string, unknown>;
  fcKey?: { methods: string[] };
  deleteKeys: boolean;
  construction: string;
  details?: Record<string, unknown>;
}

async function build(spec: Spec): Promise<Fixture> {
  const id = `${spec.prefix}.${master}`;
  const evidence = [...prevEvidence(id)];
  const add = (h: string) => evidence.push(txLink(h));
  let s = await state(id);

  if (!s.exists) {
    await ensureFunds(spec.fund);
    const kp = KeyPair.fromRandom("ed25519");
    saveKey(id, kp);
    add(await send(master, id, [actions.createAccount(), actions.transfer(NEAR(spec.fund)), actions.addFullAccessKey(kp.getPublicKey())]));
    s = await state(id);
  }

  if (spec.code && s.codeHash !== wasm[spec.code].hash) {
    if (s.codeHash !== EMPTY) throw new Error(`${id} runs ${s.codeHash}, expected ${wasm[spec.code].hash}; fix by hand`);
    if (!hasKey(id) || !s.fak.length) throw new Error(`${id} has no code and no usable full-access key`);
    const acts: any[] = [actions.deployContract(wasm[spec.code].bytes), actions.functionCall("new", spec.initArgs ?? {}, TGAS(30), 0n)];
    if (spec.fcKey) acts.push(actions.addFunctionCallAccessKey(KeyPair.fromRandom("ed25519").getPublicKey(), id, spec.fcKey.methods, NEAR(0.25)));
    if (spec.deleteKeys) for (const k of s.fak) acts.push(actions.deleteKey(PublicKey.fromString(k)));
    add(await send(id, id, acts));
    s = await state(id);
  }
  if (spec.deleteKeys && s.fak.length) {
    // Leftover full-access keys (e.g. an earlier run stopped between steps): delete them all.
    add(await send(id, id, s.fak.map((k) => actions.deleteKey(PublicKey.fromString(k)))));
    s = await state(id);
  }

  // Check the final state; the expected class rests on these facts.
  const facts = {
    code_hash: s.codeHash,
    full_access_keys: s.fak.length,
    function_call_keys: s.fc.map((k) => ({ receiver: k.receiver_id, methods: k.method_names })),
    ...(spec.code === "upgradable" ? { get_owner: await view<string>(id, "get_owner") } : {}),
  };
  if (spec.code && s.codeHash !== wasm[spec.code].hash) throw new Error(`${id}: code hash ${s.codeHash} != ${wasm[spec.code].hash}`);
  if (!spec.code && s.codeHash !== EMPTY) throw new Error(`${id}: expected no code`);
  if (spec.deleteKeys && s.fak.length) throw new Error(`${id}: still has full-access keys`);
  if (!spec.deleteKeys && !s.fak.length) throw new Error(`${id}: expected a full-access key`);
  if (spec.code === "upgradable" && facts.get_owner !== spec.initArgs?.owner_id) throw new Error(`${id}: owner ${facts.get_owner} != ${spec.initArgs?.owner_id}`);
  log(`${spec.expected.padEnd(10)} ${id}`, `code ${s.codeHash.slice(0, 8)}…, ${s.fak.length} FAK, ${s.fc.length} FC key(s)`);
  return { account: id, network: "testnet", expected_class: spec.expected, construction: spec.construction, evidence: [...new Set(evidence)], details: { ...spec.details, wasm: spec.code ? wasm[spec.code].file : null, checked_at: new Date().toISOString(), ...facts } };
}

// ── the corpus ──────────────────────────────────────────────────────────────────────────────
const VAULT_FUND = 1.3; // 111 KB of code + vault state
const UPG_FUND = 1.1; //  88 KB of code + owner state

// Helper: a plain account that holds one full-access key; owner of fx-owner-key and fx-hidden-owner.
const ownerId = `fx-owner.${master}`;
corpus.helpers!.push(await build({ prefix: "fx-owner", expected: "NO_CODE", fund: 0.05, deleteKeys: false, construction: "Helper: plain account with one full-access key, no code; owner of fx-owner-key and fx-hidden-owner." }));
save();

const fixtures: Spec[] = [
  { prefix: "fx-immutable", expected: "IMMUTABLE", fund: VAULT_FUND, code: "vault", initArgs: { owner_id: master }, deleteKeys: true,
    construction: "demo_vault_v1 (imports no deploy/global/add-full-access-key host function) deployed and initialised, then every access key deleted in the same transaction." },
  { prefix: "fx-fak", expected: "CUSTODIAL", fund: VAULT_FUND, code: "vault", initArgs: { owner_id: master }, deleteKeys: false,
    construction: "demo_vault_v1 deployed and initialised; the account keeps its full-access key, which alone can deploy new code." },
  { prefix: "fx-fconly", expected: "IMMUTABLE", fund: VAULT_FUND, code: "vault", initArgs: { owner_id: master }, fcKey: { methods: ["deposit"] }, deleteKeys: true,
    construction: "demo_vault_v1 deployed and initialised, a function-call key (receiver itself, method deposit, private key discarded) added and the full-access key deleted; function-call keys cannot deploy." },
  { prefix: "fx-owner-key", expected: "CUSTODIAL", fund: UPG_FUND, code: "upgradable", initArgs: { owner_id: ownerId }, deleteKeys: true,
    construction: `fixture-upgradable with owner ${ownerId}, a plain account holding one full-access key; the fixture's own keys deleted, so that one key can call upgrade().` },
];
for (const f of fixtures) {
  corpus.fixtures.push(await build(f));
  save();
}

// e/f: Sputnik DAO owners. On a re-run the owner is read back from the chain and re-checked (DAO policies can change).
async function daoFixture(prefix: string, expected: "GOVERNED" | "CUSTODIAL", candidates: string[], kinds: string[], ok: (c: DaoCheck | null) => boolean | Promise<boolean>) {
  const id = `${prefix}.${master}`;
  let dao: DaoCheck | null;
  if ((await state(id)).codeHash === wasm.upgradable.hash) {
    const owner = await view<string>(id, "get_owner");
    dao = await checkDao(owner, kinds);
    if (!(await ok(dao))) log("WARNING", `${owner} no longer meets the ${expected} condition: ${JSON.stringify(dao)}`);
  } else {
    dao = await findDao(candidates, kinds, ok);
  }
  if (!dao) {
    corpus.skipped!.push({ account: id, reason: `no testnet Sputnik DAO found that meets the ${expected} condition` });
    log("skipped", id);
    return;
  }
  const how =
    expected === "GOVERNED"
      ? `every proposal kind needs ${dao.approvals}+ approvals (weakest: ${dao.approvals} of ${dao.of} "${dao.role}" for "${dao.kind}"), no access keys, no token or Everyone votes`
      : `${dao.approvals} of ${dao.of} "${dao.role}" member (${dao.members.join(", ")}, which holds a full-access key) passes a "call" proposal`;
  corpus.fixtures.push(
    await build({
      prefix, expected, fund: UPG_FUND, code: "upgradable", initArgs: { owner_id: dao.dao }, deleteKeys: true,
      construction: `fixture-upgradable with owner the Sputnik DAO ${dao.dao} (${how}); the fixture's own keys deleted.`,
      details: { dao: dao.dao, dao_approvals: dao.approvals, dao_role_size: dao.of, dao_role: dao.role, dao_kind: dao.kind, dao_checked_kinds: kinds.length === SPUTNIK_KINDS.length ? "all" : kinds },
    }),
  );
  save();
}
await daoFixture("fx-owner-dao", "GOVERNED", STRONG_DAOS, SPUTNIK_KINDS, strongOk);
await daoFixture("fx-owner-dao-weak", "CUSTODIAL", WEAK_DAOS, ["call"], weakOk);

corpus.fixtures.push(
  await build({
    prefix: "fx-hidden-owner", expected: "UNRESOLVED", fund: UPG_FUND, code: "hidden", initArgs: { owner_id: ownerId }, deleteKeys: true,
    construction: `fixture-upgradable-hidden (owner-gated upgrade(), no view returns the owner) with owner ${ownerId}; own keys deleted. The real controller is one key, but no view method reveals it.`,
    details: { owner_private: ownerId },
  }),
);
save();

corpus.fixtures.push(await build({ prefix: "fx-nocode", expected: "NO_CODE", fund: 0.1, deleteKeys: false, construction: "Plain account with one full-access key and no contract code." }));
save();

// i: owner is a top-level testnet name that does not exist (anyone could register it later).
{
  const id = `fx-owner-gone.${master}`;
  let nobody: string = (prevDetails(id).owner_absent as string) ?? `fx-nobody-${Math.random().toString(36).slice(2, 10)}.testnet`;
  if ((await state(id)).codeHash === wasm.upgradable.hash) nobody = await view<string>(id, "get_owner");
  while (!(await state(id)).exists && (await accountExists(nobody))) nobody = `fx-nobody-${Math.random().toString(36).slice(2, 10)}.testnet`;
  const gone = !(await accountExists(nobody));
  if (!gone) log("WARNING", `${nobody} now exists; fx-owner-gone's expected class no longer holds`);
  corpus.fixtures.push(
    await build({
      prefix: "fx-owner-gone", expected: "UNRESOLVED", fund: UPG_FUND, code: "upgradable", initArgs: { owner_id: nobody }, deleteKeys: true,
      construction: `fixture-upgradable with owner ${nobody}, a top-level name that did not exist when checked (anyone may register it later); own keys deleted.`,
      details: { owner_absent: nobody, owner_absent_at_check: gone },
    }),
  );
  save();
}

// Spend report: faucet grants minus what the master and funders still hold.
const grants = (1 + corpus.funders!.length) * FAUCET_GRANT;
let left = 0n;
for (const a of [master, ...corpus.funders!]) left += (await state(a)).amount;
log("done", `${corpus.fixtures.length} fixtures, ${corpus.skipped!.length} skipped → ${path.relative(ROOT, OUT)}`);
log("NEAR", `faucet grants ${grants}, left on master+funders ${yoctoToNear(left)}, spent ≈ ${(grants - Number(yoctoToNear(left))).toFixed(4)}`);
