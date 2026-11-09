//! Keyhole eval fixture "fixture-upgradable" (testnet only).
//!
//! State: `owner_id`. `upgrade()` lets the owner, and only the owner, replace this account's code
//! with the raw bytes passed as the call's input. It deploys with the low-level
//! `env::promise_batch_create` + `env::promise_batch_action_deploy_contract`, so the wasm imports
//! `promise_batch_action_deploy_contract`. With no access keys on the account, the owner is the
//! only path to new code, which makes the expected Keyhole class follow from who the owner is.

use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Fixture {
    owner_id: AccountId,
}

#[near]
impl Fixture {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id }
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// Owner only. The call's raw input (not JSON) is the new wasm.
    pub fn upgrade(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can upgrade");
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "Pass the new wasm as the call input");
        let promise = env::promise_batch_create(&env::current_account_id());
        env::promise_batch_action_deploy_contract(promise, &code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: usize, input: &[u8]) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("fx.testnet".parse().unwrap()).predecessor_account_id(accounts(predecessor));
        b.context.input = input.into();
        testing_env!(b.build());
    }

    #[test]
    fn owner_view() {
        ctx(0, b"");
        assert_eq!(Fixture::new(accounts(1)).get_owner(), accounts(1));
    }

    #[test]
    fn owner_can_upgrade() {
        ctx(0, b"");
        let mut f = Fixture::new(accounts(1));
        ctx(1, b"\0asm-new-code");
        f.upgrade();
        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].receiver_id, "fx.testnet".parse::<AccountId>().unwrap());
        assert!(matches!(&receipts[0].actions[..], [MockAction::DeployContract { code, .. }] if code == b"\0asm-new-code"));
    }

    #[test]
    #[should_panic(expected = "Only the owner can upgrade")]
    fn stranger_cannot_upgrade() {
        ctx(0, b"");
        let mut f = Fixture::new(accounts(1));
        ctx(2, b"\0asm-new-code");
        f.upgrade();
    }

    #[test]
    #[should_panic(expected = "Only the owner can upgrade")]
    fn contract_itself_cannot_upgrade() {
        ctx(0, b"");
        let mut f = Fixture::new(accounts(1));
        let mut b = VMContextBuilder::new();
        b.current_account_id("fx.testnet".parse().unwrap()).predecessor_account_id("fx.testnet".parse().unwrap());
        b.context.input = b"\0asm".as_slice().into();
        testing_env!(b.build());
        f.upgrade();
    }

    #[test]
    #[should_panic(expected = "Pass the new wasm")]
    fn empty_code_rejected() {
        ctx(0, b"");
        let mut f = Fixture::new(accounts(1));
        ctx(1, b"");
        f.upgrade();
    }
}
