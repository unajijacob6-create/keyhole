// Deliberately malicious demo contract for testnet only.
//
//! Keyhole demo vault v2: the "silent upgrade". It keeps exactly the v1 state layout, so
//! the owner can redeploy it over v1 with their full-access key and it reads v1 state
//! without a migration. It adds `sweep`, which lets the owner take every deposit.
//! Never deploy this anywhere real funds live.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseIndex};

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

    /// Sends `amount` yoctoNEAR back to the caller. Fails if it exceeds the caller's balance.
    /// The balance is restored if the transfer fails. Returns the callback's result.
    pub fn withdraw(&mut self, amount: U128) {
        let amount = amount.0;
        require!(amount > 0, "Amount must be positive");
        let account = env::predecessor_account_id();
        let balance = self.balances.get(&account).copied().unwrap_or(0);
        require!(amount <= balance, "Insufficient balance");
        require!(amount <= self.total, "Vault is empty");
        self.set_balance(&account, balance - amount);
        self.total -= amount;
        env::log_str(&format!("withdraw {account} {amount}"));
        let transfer = transfer(&account, amount);
        let callback = env::promise_batch_then(transfer, &env::current_account_id());
        // Account ids are [a-z0-9._-], so they need no JSON escaping.
        let args = format!(r#"{{"account_id":"{account}","amount":"{amount}"}}"#);
        env::promise_batch_action_function_call(
            callback,
            "on_withdraw",
            args.as_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        );
        env::promise_return(callback);
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            return true;
        }
        let balance = self.balances.get(&account_id).copied().unwrap_or(0);
        self.set_balance(&account_id, balance + amount.0);
        self.total += amount.0;
        env::log_str(&format!("withdraw refunded {account_id} {}", amount.0));
        false
    }

    /// Owner only: sends the vault's whole recorded total to `to` and zeroes `total`.
    /// The per-account balances are left as they were, so they no longer have funds behind
    /// them. This is the drain the Keyhole demo detects.
    pub fn sweep(&mut self, to: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can sweep");
        let amount = self.total;
        require!(amount > 0, "Nothing to sweep");
        self.total = 0;
        env::log_str(&format!("sweep {amount} to {to}"));
        env::promise_return(transfer(&to, amount));
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
        "2.0.0".to_string()
    }
}

/// Sends `amount` yoctoNEAR to `to` with plain host calls. near-sdk's high-level `Promise`
/// type would link every action host function into the wasm, including
/// `promise_batch_action_deploy_contract`, and this vault must not even import it.
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

    #[test]
    fn init_and_views() {
        let v = vault();
        assert_eq!(v.get_owner(), accounts(0));
        assert_eq!(v.get_total(), U128(0));
        assert_eq!(v.get_balance(accounts(1)), U128(0));
        assert_eq!(v.version(), "2.0.0");
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

    #[test]
    fn withdraw_reduces_balance() {
        let mut v = vault();
        ctx(1, 3 * ONE_NEAR);
        v.deposit();
        ctx(1, 0);
        v.withdraw(U128(ONE_NEAR));
        assert_eq!(v.get_balance(accounts(1)), U128(2 * ONE_NEAR));
        assert_eq!(v.get_total(), U128(2 * ONE_NEAR));
        v.withdraw(U128(2 * ONE_NEAR));
        assert_eq!(v.get_balance(accounts(1)), U128(0));
        assert_eq!(v.get_total(), U128(0));
    }

    #[test]
    #[should_panic(expected = "Insufficient balance")]
    fn withdraw_over_balance_fails() {
        let mut v = vault();
        ctx(1, ONE_NEAR);
        v.deposit();
        ctx(2, 5 * ONE_NEAR);
        v.deposit();
        ctx(1, 0);
        v.withdraw(U128(ONE_NEAR + 1));
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn withdraw_zero_fails() {
        let mut v = vault();
        ctx(1, 0);
        v.withdraw(U128(0));
    }

    #[test]
    fn failed_transfer_restores_balance() {
        let mut v = vault();
        ctx(1, 2 * ONE_NEAR);
        v.deposit();
        ctx(1, 0);
        v.withdraw(U128(ONE_NEAR));
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
        assert!(!v.on_withdraw(accounts(1), U128(ONE_NEAR)));
        assert_eq!(v.get_balance(accounts(1)), U128(2 * ONE_NEAR));
        assert_eq!(v.get_total(), U128(2 * ONE_NEAR));
    }

    #[test]
    fn owner_can_sweep() {
        let mut v = vault();
        ctx(1, 3 * ONE_NEAR);
        v.deposit();
        ctx(2, 2 * ONE_NEAR);
        v.deposit();
        ctx(0, 0);
        v.sweep(accounts(3));
        assert_eq!(v.get_total(), U128(0));
        // Balances are stale on purpose: the funds behind them are gone.
        assert_eq!(v.get_balance(accounts(1)), U128(3 * ONE_NEAR));
        assert_eq!(get_logs(), vec![format!("sweep {} to {}", 5 * ONE_NEAR, accounts(3))]);
    }

    #[test]
    #[should_panic(expected = "Vault is empty")]
    fn withdraw_after_sweep_fails() {
        let mut v = vault();
        ctx(1, ONE_NEAR);
        v.deposit();
        ctx(0, 0);
        v.sweep(accounts(3));
        ctx(1, 0);
        v.withdraw(U128(ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "Only the owner can sweep")]
    fn non_owner_cannot_sweep() {
        let mut v = vault();
        ctx(1, ONE_NEAR);
        v.deposit();
        v.sweep(accounts(1));
    }

    #[test]
    #[should_panic(expected = "Nothing to sweep")]
    fn empty_sweep_fails() {
        let mut v = vault();
        v.sweep(accounts(3));
    }

    #[test]
    fn reads_v1_state_layout() {
        // Borsh layout of v1's state: owner_id, balances prefix, total.
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
}
