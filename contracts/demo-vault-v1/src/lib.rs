//! Keyhole demo vault v1: an honest, minimal NEAR vault.
//!
//! Anyone can deposit NEAR and withdraw up to their own balance. The contract has no
//! upgrade method and no code-deploy capability. That is the point of the Keyhole demo:
//! the code itself cannot change the code, but the owner still holds a full-access key on
//! the account and can redeploy anything (see `demo-vault-v2`).

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
        "1.0.0".to_string()
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
        assert_eq!(v.version(), "1.0.0");
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
}
