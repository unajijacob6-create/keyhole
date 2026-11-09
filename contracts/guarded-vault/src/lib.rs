//! Keyhole guarded vault (testnet demo venue).
//!
//! This vault mirrors how a real DeFi venue (Ref, Burrow) looks to a depositor: anyone can
//! `deposit`, and `withdraw_all` pulls a caller's whole balance back out. What makes it a
//! *guarded* vault is that an `owner_id` — meant to be a DAO — can replace the contract's code
//! through `upgrade`. That is exactly the surface Keyhole Guardian watches: a DAO vote can swap
//! honest code for code that drains or seizes the account, in the same transaction that passes.
//!
//! `upgrade` reads the new wasm from the call's **raw input** (not JSON). That matches what a
//! Sputnik `UpgradeRemote` proposal sends: the DAO stores the blob and then function-calls the
//! target with the stored bytes as raw input. So this vault can be driven by a real DAO.
//!
//! Cargo features seed the variants Keyhole grades against (see `Cargo.toml`). Every variant keeps
//! the v1 state layout, so it can be deployed over the honest v1 and read its state with no
//! migration. The honest default is v1; the evil variants are deliberately malicious and belong on
//! testnet only. `evil-fee` changes only withdraw *logic* (half the balance is skimmed), with no
//! new export or host call — it exists to measure, honestly, what a wasm export/host-call diff
//! cannot see.
//!
//! Like `demo-vault`, value is moved with the low-level `env::promise_batch_*` host calls rather
//! than near-sdk's high-level `Promise`, which would link every action host function (deploy
//! included) into the wasm and blur which capabilities the code actually uses. The one deploy
//! capability this wasm imports is reached only by `upgrade`; `contracts/test.sh` asserts that.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseIndex,
};

// The seeded variants are mutually exclusive: a build is the honest v1 or exactly one variant.
// Enumerate the pairs so a doubled-up build fails to compile instead of silently merging behaviours.
#[cfg(any(
    all(feature = "benign-v2", feature = "evil-sweep"),
    all(feature = "benign-v2", feature = "evil-addkey"),
    all(feature = "benign-v2", feature = "evil-owner"),
    all(feature = "benign-v2", feature = "evil-fee"),
    all(feature = "evil-sweep", feature = "evil-addkey"),
    all(feature = "evil-sweep", feature = "evil-owner"),
    all(feature = "evil-sweep", feature = "evil-fee"),
    all(feature = "evil-addkey", feature = "evil-owner"),
    all(feature = "evil-addkey", feature = "evil-fee"),
    all(feature = "evil-owner", feature = "evil-fee"),
))]
compile_error!(
    "guarded-vault variant features are mutually exclusive; enable at most one of \
     benign-v2 / evil-sweep / evil-addkey / evil-owner / evil-fee"
);

/// Any seeded variant bumps the reported version to 1.1.0; the honest default is 1.0.0.
#[cfg(not(any(
    feature = "benign-v2",
    feature = "evil-sweep",
    feature = "evil-addkey",
    feature = "evil-owner",
    feature = "evil-fee"
)))]
const VERSION: &str = "1.0.0";
#[cfg(any(
    feature = "benign-v2",
    feature = "evil-sweep",
    feature = "evil-addkey",
    feature = "evil-owner",
    feature = "evil-fee"
))]
const VERSION: &str = "1.1.0";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    balances: LookupMap<AccountId, u128>,
    total: u128,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id, balances: LookupMap::new(b"b"), total: 0 }
    }

    /// Credits the attached deposit to the caller.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach a deposit");
        let account = env::predecessor_account_id();
        let balance = self.balances.get(&account).copied().unwrap_or(0) + amount;
        self.balances.insert(account.clone(), balance);
        self.total += amount;
        env::log_str(&format!("deposit {account} {amount}"));
        U128(balance)
    }

    /// Sends the caller's whole balance back to them and returns the amount sent.
    ///
    /// Requires exactly 1 yoctoNEAR (`assert_one_yocto`), the standard full-access-key gate: a
    /// function-call access key cannot attach a deposit, so only a full-access signature — or a
    /// relayed NEP-366 delegate action the user signed with a full-access key — can call this. Under
    /// a relayed delegate action `predecessor_account_id` is the user (the delegate's sender), so the
    /// funds go to the user, not the relayer. An `on_withdraw` callback restores the balance if the
    /// transfer fails.
    #[payable]
    pub fn withdraw_all(&mut self) -> U128 {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(balance > 0, "Nothing to withdraw");
        require!(balance <= self.total, "Vault is empty");
        // The honest vault sends the whole balance; `evil-fee` skims half and keeps the rest in the
        // account, where the owner can later take it. Either way the caller's record is cleared, so
        // the callback must restore the full `balance` (not just what was sent) on failure.
        let amount_out = withdraw_amount(balance);
        self.set_balance(&account, 0);
        self.total -= balance;
        env::log_str(&format!("withdraw_all {account} {amount_out}"));
        let transfer = transfer(&account, amount_out);
        let callback = env::promise_batch_then(transfer, &env::current_account_id());
        // Account ids are [a-z0-9._-], so they need no JSON escaping.
        let args = format!(r#"{{"account_id":"{account}","amount":"{balance}"}}"#);
        env::promise_batch_action_function_call(
            callback,
            "on_withdraw",
            args.as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        );
        // Return the amount synchronously; the transfer + callback run as scheduled receipts.
        U128(amount_out)
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        let balance = self.balances.get(&account_id).copied().unwrap_or(0);
        self.set_balance(&account_id, balance + amount.0);
        self.total += amount.0;
        env::log_str(&format!("withdraw_all refunded {account_id} {}", amount.0));
        false
    }

    pub fn get_balance(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_total(&self) -> U128 {
        U128(self.total)
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn version(&self) -> String {
        VERSION.to_string()
    }

    /// Owner only. Replaces this account's code with the call's **raw input** bytes (not JSON) and
    /// deploys it to the current account. No migration: every variant keeps the v1 state layout.
    ///
    /// This has no parameters on purpose: the near-sdk `#[near]` wrapper only reads and deserializes
    /// input when a method takes arguments, so a zero-arg method leaves `env::input()` holding the
    /// raw wasm for us. A Sputnik `UpgradeRemote` call sends the stored blob as exactly this raw
    /// input. `contracts/test.sh` verifies that this is the only export reaching the deploy host call.
    pub fn upgrade(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can upgrade");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "Pass the new wasm as the call input");
        let promise = env::promise_batch_create(&env::current_account_id());
        env::promise_batch_action_deploy_contract(promise, &code);
        env::promise_return(promise);
    }

    // --- Seeded variant surface (compiled in only under the matching feature). ---

    /// `benign-v2`: a harmless added view returning `(total, whole NEAR held)`. The vault keeps no
    /// depositor count (a `LookupMap` cannot be iterated), so the second field is derived from
    /// `total` rather than stored — the state layout stays identical to v1. This is the benign
    /// upgrade Keyhole should pass: a new export with no money, code, or key path.
    #[cfg(feature = "benign-v2")]
    pub fn get_stats(&self) -> (U128, u32) {
        let whole_near = (self.total / 10u128.pow(24)) as u32;
        (U128(self.total), whole_near)
    }

    /// `evil-sweep`: callable by **anyone** (no access check). Sends the whole recorded `total` to a
    /// beneficiary fixed at compile time and zeroes `total`. The per-account balances are left
    /// stale, so nothing backs them any more. This is the drain Keyhole must catch: a new export
    /// with a money path.
    #[cfg(feature = "evil-sweep")]
    pub fn sweep(&mut self) {
        let to: AccountId = SWEEP_TO.parse().expect("compiled-in SWEEP_TO is not a valid account id");
        let amount = self.total;
        require!(amount > 0, "Nothing to sweep");
        self.total = 0;
        env::log_str(&format!("sweep {amount} to {to}"));
        env::promise_return(transfer(&to, amount));
    }

    /// `evil-addkey`: callable by **anyone** (no access check). Adds a full-access key to the vault
    /// account, handing permanent control to whoever supplied the key. A new key path.
    #[cfg(feature = "evil-addkey")]
    pub fn add_owner_key(&mut self, public_key: near_sdk::PublicKey) {
        let promise = env::promise_batch_create(&env::current_account_id());
        env::promise_batch_action_add_key_with_full_access(promise, &public_key, 0);
        env::promise_return(promise);
    }

    /// `evil-owner`: callable by **anyone** (no access check). Seizes ownership, after which the new
    /// owner can call `upgrade` and deploy anything. A new code path reached one hop away.
    #[cfg(feature = "evil-owner")]
    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.owner_id = owner_id;
    }
}

/// `evil-sweep` beneficiary, fixed at compile time. Override with `SWEEP_TO=<account>` at build
/// time (the demo and sandbox test point it at an account they control); defaults otherwise.
#[cfg(feature = "evil-sweep")]
const SWEEP_TO: &str = match option_env!("SWEEP_TO") {
    Some(s) => s,
    None => "keyhole-attacker.testnet",
};

/// The honest vault sends the whole balance.
#[cfg(not(feature = "evil-fee"))]
fn withdraw_amount(balance: u128) -> u128 {
    balance
}
/// `evil-fee` skims half: `withdraw_all` sends only half and keeps the rest. No new export or host
/// call — a pure logic change a wasm diff cannot see.
#[cfg(feature = "evil-fee")]
fn withdraw_amount(balance: u128) -> u128 {
    balance / 2
}

/// Sends `amount` yoctoNEAR to `to` with plain host calls. near-sdk's high-level `Promise` type
/// would link every action host function into the wasm, including the deploy action, and blur which
/// capabilities the code really uses.
fn transfer(to: &AccountId, amount: u128) -> PromiseIndex {
    let promise = env::promise_batch_create(to);
    env::promise_batch_action_transfer(promise, NearToken::from_yoctonear(amount));
    promise
}

impl Vault {
    fn set_balance(&mut self, account: &AccountId, balance: u128) {
        if balance == 0 {
            self.balances.remove(account);
        } else {
            self.balances.insert(account.clone(), balance);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};

    const ONE_NEAR: u128 = 10u128.pow(24);

    fn ctx(predecessor: usize, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(accounts(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn vault() -> Vault {
        ctx(0, 0);
        Vault::new(accounts(0))
    }

    /// Expected version for the build under test: honest default 1.0.0, any variant 1.1.0.
    fn expected_version() -> &'static str {
        if cfg!(any(
            feature = "benign-v2",
            feature = "evil-sweep",
            feature = "evil-addkey",
            feature = "evil-owner",
            feature = "evil-fee"
        )) {
            "1.1.0"
        } else {
            "1.0.0"
        }
    }

    #[test]
    fn init_and_views() {
        let v = vault();
        assert_eq!(v.get_owner(), accounts(0));
        assert_eq!(v.get_total(), U128(0));
        assert_eq!(v.get_balance(accounts(1)), U128(0));
        assert_eq!(v.version(), expected_version());
    }

    #[test]
    fn deposit_credits_caller() {
        let mut v = vault();
        ctx(1, 2 * ONE_NEAR);
        assert_eq!(v.deposit(), U128(2 * ONE_NEAR));
        ctx(1, ONE_NEAR);
        assert_eq!(v.deposit(), U128(3 * ONE_NEAR));
        ctx(2, ONE_NEAR);
        v.deposit();
        assert_eq!(v.get_balance(accounts(1)), U128(3 * ONE_NEAR));
        assert_eq!(v.get_balance(accounts(2)), U128(ONE_NEAR));
        assert_eq!(v.get_total(), U128(4 * ONE_NEAR));
        assert!(get_logs()[0].starts_with("deposit charlie"));
    }

    #[test]
    #[should_panic(expected = "Attach a deposit")]
    fn deposit_requires_funds() {
        let mut v = vault();
        ctx(1, 0);
        v.deposit();
    }

    /// `withdraw_all` requires exactly 1 yoctoNEAR: 0 panics.
    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_all_rejects_zero_yocto() {
        let mut v = vault();
        ctx(1, ONE_NEAR);
        v.deposit();
        ctx(1, 0);
        v.withdraw_all();
    }

    /// `withdraw_all` requires exactly 1 yoctoNEAR: 2 panics.
    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_all_rejects_two_yocto() {
        let mut v = vault();
        ctx(1, ONE_NEAR);
        v.deposit();
        ctx(1, 2);
        v.withdraw_all();
    }

    #[test]
    #[should_panic(expected = "Nothing to withdraw")]
    fn withdraw_all_empty_fails() {
        let mut v = vault();
        ctx(1, 1);
        v.withdraw_all();
    }

    /// Honest / most variants: `withdraw_all` clears the balance and reports the whole amount.
    /// `evil-fee` reports (and sends) only half while still clearing the record.
    #[test]
    fn withdraw_all_clears_balance() {
        let mut v = vault();
        ctx(1, 3 * ONE_NEAR);
        v.deposit();
        ctx(2, ONE_NEAR);
        v.deposit();
        ctx(1, 1);
        let got = v.withdraw_all();
        let expected_out = if cfg!(feature = "evil-fee") { 3 * ONE_NEAR / 2 } else { 3 * ONE_NEAR };
        assert_eq!(got, U128(expected_out));
        // The caller's record is cleared and the total drops by the full recorded balance either way.
        assert_eq!(v.get_balance(accounts(1)), U128(0));
        assert_eq!(v.get_total(), U128(ONE_NEAR));
        assert!(get_logs().iter().any(|l| l.starts_with("withdraw_all bob")));
    }

    #[test]
    fn failed_transfer_restores_balance() {
        let mut v = vault();
        ctx(1, 2 * ONE_NEAR);
        v.deposit();
        ctx(1, 1);
        v.withdraw_all();
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("vault.testnet".parse().unwrap())
                .predecessor_account_id("vault.testnet".parse().unwrap())
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        // The callback restores the full recorded balance, not just what was sent.
        assert!(!v.on_withdraw(accounts(1), U128(2 * ONE_NEAR)));
        assert_eq!(v.get_balance(accounts(1)), U128(2 * ONE_NEAR));
        assert_eq!(v.get_total(), U128(2 * ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "Only the owner can upgrade")]
    fn upgrade_is_owner_only() {
        let mut v = vault();
        // predecessor 1 is not the owner (0).
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(accounts(1))
            .build());
        v.upgrade();
    }

    #[test]
    fn owner_upgrade_deploys_raw_input() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let mut v = vault();
        // Owner (0) calls upgrade with raw wasm bytes as input (not JSON).
        let mut b = VMContextBuilder::new();
        b.current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(accounts(0));
        b.context.input = b"\0asm-new-code".as_slice().into();
        testing_env!(b.build());
        v.upgrade();
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, "vault.testnet".parse::<AccountId>().unwrap());
        assert!(matches!(
            &receipts[0].actions[..],
            [MockAction::DeployContract { code, .. }] if code == b"\0asm-new-code"
        ));
    }

    #[test]
    #[should_panic(expected = "Pass the new wasm")]
    fn upgrade_rejects_empty_input() {
        let mut v = vault();
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(accounts(0))
            .build());
        v.upgrade();
    }

    #[test]
    fn reads_v1_state_layout() {
        // Borsh layout of v1's state: owner_id, balances prefix, total. Every variant must read it.
        #[near(serializers = [borsh])]
        struct V1Layout {
            owner_id: AccountId,
            balances: LookupMap<AccountId, u128>,
            total: u128,
        }
        ctx(0, 0);
        let mut v1 = V1Layout { owner_id: accounts(0), balances: LookupMap::new(b"b"), total: 7 };
        v1.balances.insert(accounts(1), 7);
        v1.balances.flush();
        let bytes = near_sdk::borsh::to_vec(&v1).unwrap();
        let v: Vault = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(v.get_owner(), accounts(0));
        assert_eq!(v.get_total(), U128(7));
        assert_eq!(v.get_balance(accounts(1)), U128(7));
    }

    #[cfg(feature = "benign-v2")]
    #[test]
    fn benign_get_stats() {
        let mut v = vault();
        ctx(1, 3 * ONE_NEAR + 5);
        v.deposit();
        let (total, whole) = v.get_stats();
        assert_eq!(total, U128(3 * ONE_NEAR + 5));
        assert_eq!(whole, 3);
    }

    #[cfg(feature = "evil-sweep")]
    #[test]
    fn evil_sweep_zeroes_total_for_anyone() {
        let mut v = vault();
        ctx(1, 5 * ONE_NEAR);
        v.deposit();
        // No access check: a stranger (2), not the owner, can sweep.
        ctx(2, 0);
        v.sweep();
        assert_eq!(v.get_total(), U128(0));
        // The balance is left stale; nothing backs it any more.
        assert_eq!(v.get_balance(accounts(1)), U128(5 * ONE_NEAR));
        assert!(get_logs().iter().any(|l| l.contains(&format!("sweep {} to {}", 5 * ONE_NEAR, SWEEP_TO))));
    }

    #[cfg(feature = "evil-sweep")]
    #[test]
    #[should_panic(expected = "Nothing to sweep")]
    fn evil_sweep_empty_fails() {
        let mut v = vault();
        ctx(2, 0);
        v.sweep();
    }

    #[cfg(feature = "evil-owner")]
    #[test]
    fn evil_set_owner_has_no_access_check() {
        let mut v = vault();
        assert_eq!(v.get_owner(), accounts(0));
        // A stranger (2), not the owner, seizes ownership.
        ctx(2, 0);
        v.set_owner(accounts(2));
        assert_eq!(v.get_owner(), accounts(2));
    }

    #[cfg(feature = "evil-addkey")]
    #[test]
    fn evil_add_owner_key_adds_full_access_key() {
        use near_sdk::mock::MockAction;
        use near_sdk::test_utils::get_created_receipts;
        let mut v = vault();
        // No access check: a stranger (2) adds a full-access key to the vault account.
        ctx(2, 0);
        let pk: near_sdk::PublicKey =
            "ed25519:H9k5eiU4xXS3M4z8HzKJSLaMfu6b1vAkv9MhEbgZ3jKT".parse().unwrap();
        v.add_owner_key(pk.clone());
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, "vault.testnet".parse::<AccountId>().unwrap());
        // MockAction stores a near_crypto::PublicKey; compare by string form.
        assert!(matches!(
            &receipts[0].actions[..],
            [MockAction::AddKeyWithFullAccess { public_key, .. }] if public_key.to_string() == pk.to_string()
        ));
    }
}
