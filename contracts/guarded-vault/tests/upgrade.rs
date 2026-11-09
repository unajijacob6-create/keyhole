//! Sandbox tests for the Keyhole guarded vault. They read the wasm that `contracts/test.sh`
//! builds into `contracts/out/`:
//!   (1) deposit + `withdraw_all` returns a user's funds (with the 1-yoctoNEAR gate);
//!   (2) a Sputnik-style upgrade: the owner calls `upgrade` with the raw bytes of the evil-sweep
//!       wasm as the call args (no JSON), the contract then exposes `sweep`, state is preserved,
//!       and `sweep` drains `total` to the compiled-in beneficiary;
//!   (3) a NEP-366 delegate action (relayer submits the user's signed `withdraw_all`) — skipped:
//!       near-workspaces 0.24 has no SignedDelegate/meta-transaction support (see the ignored test
//!       below). The `@keyhole/hatch` package covers this path live on testnet.

use near_workspaces::types::{KeyType, NearToken, SecretKey};
use serde_json::{json, Value};

const HONEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/guarded_vault.wasm");
const EVIL_SWEEP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/guarded_vault_evil_sweep.wasm");
// The beneficiary baked into the default evil-sweep build (`option_env!("SWEEP_TO")` default).
const SWEEP_TO: &str = "keyhole-attacker.testnet";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn read(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; run contracts/test.sh first"))
}

fn u128_of(v: Value) -> u128 {
    v.as_str().expect("U128 string").parse().unwrap()
}

/// (1) An honest deposit/withdraw round-trip. `withdraw_all` needs exactly 1 yoctoNEAR, clears the
/// caller's balance, returns the amount, and the NEAR actually lands back in the caller's account.
#[tokio::test]
async fn deposit_and_withdraw_all_returns_funds() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&read(HONEST)?).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;

    assert_eq!(vault.view("version").await?.json::<String>()?, "1.0.0");
    for (who, near) in [(&alice, 5u128), (&bob, 3)] {
        who.call(vault.id(), "deposit").deposit(NearToken::from_near(near)).transact().await?.into_result()?;
    }
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), NearToken::from_near(8).as_yoctonear());

    // withdraw_all without the 1 yoctoNEAR gate is rejected.
    let bad = alice.call(vault.id(), "withdraw_all").max_gas().transact().await?;
    assert!(
        format!("{:?}", bad.into_result().unwrap_err()).contains("1 yoctoNEAR"),
        "withdraw_all must require exactly 1 yoctoNEAR"
    );

    let before = alice.view_account().await?.balance;
    let out: Value = alice
        .call(vault.id(), "withdraw_all")
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    // The method returns the amount withdrawn.
    assert_eq!(u128_of(out), NearToken::from_near(5).as_yoctonear());

    // State: alice's record is cleared, the total drops to bob's 3 NEAR.
    assert_eq!(u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?), 0);
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), NearToken::from_near(3).as_yoctonear());

    // The NEAR actually returned to alice (5 minus gas and the 1 yocto).
    let after = alice.view_account().await?.balance;
    let gained = after.as_yoctonear().saturating_sub(before.as_yoctonear());
    println!("alice net from withdraw_all: {gained} yoctoNEAR");
    assert!(gained > NearToken::from_millinear(4990).as_yoctonear(), "alice should recover ~5 NEAR minus gas");
    Ok(())
}

/// (2) The Sputnik-style upgrade. The owner (standing in for a DAO's `UpgradeRemote` function call)
/// calls `upgrade` with the raw evil-sweep wasm as the call args — no JSON — and the contract's code
/// is replaced in place. State carries over with no migration, the new `sweep` export appears, and
/// `sweep` moves the whole `total` to the compiled-in beneficiary. This is what Keyhole Guardian is
/// built to catch before the deciding vote lands.
#[tokio::test]
async fn sputnik_style_upgrade_deploys_evil_sweep() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&read(HONEST)?).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;

    // The default evil-sweep wasm pays the fixed `keyhole-attacker.testnet`; create it so the
    // sandbox transfer has a real recipient. The sandbox registrar cannot create a dotted TLA
    // directly, so create the `testnet` parent first, then `keyhole-attacker.testnet` under it.
    let (prefix, parent) = SWEEP_TO.split_once('.').expect("SWEEP_TO should be <name>.<tld>");
    let tld = worker
        .create_tla(parent.parse()?, SecretKey::from_seed(KeyType::ED25519, parent))
        .await?
        .into_result()?;
    let beneficiary = tld
        .create_subaccount(prefix)
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(beneficiary.id().as_str(), SWEEP_TO);

    for (who, near) in [(&alice, 5u128), (&bob, 3)] {
        who.call(vault.id(), "deposit").deposit(NearToken::from_near(near)).transact().await?.into_result()?;
    }
    let total = u128_of(vault.view("get_total").await?.json()?);
    assert_eq!(total, NearToken::from_near(8).as_yoctonear());

    // Before the upgrade there is no `sweep` and no non-owner upgrade.
    let no_sweep = bob.call(vault.id(), "sweep").max_gas().transact().await?;
    assert!(format!("{:?}", no_sweep.into_result().unwrap_err()).contains("MethodNotFound"));
    let not_owner = alice.call(vault.id(), "upgrade").args(read(EVIL_SWEEP)?).max_gas().transact().await?;
    assert!(format!("{:?}", not_owner.into_result().unwrap_err()).contains("Only the owner can upgrade"));

    // The upgrade: the owner sends the raw wasm bytes as args (exactly what a Sputnik UpgradeRemote
    // function call delivers — the stored blob as raw input, no JSON).
    let code_before = vault.view_account().await?.contract_state;
    owner.call(vault.id(), "upgrade").args(read(EVIL_SWEEP)?).max_gas().transact().await?.into_result()?;
    let code_after = vault.view_account().await?.contract_state;
    assert_ne!(code_before, code_after, "upgrade should replace the code");

    // State preserved with no migration; the new version and `sweep` export are live.
    assert_eq!(vault.view("version").await?.json::<String>()?, "1.1.0");
    assert_eq!(vault.view("get_owner").await?.json::<String>()?, owner.id().as_str());
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), total);
    assert_eq!(
        u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?),
        NearToken::from_near(5).as_yoctonear()
    );

    // `sweep` is callable by anyone and sends the whole total to the compiled-in beneficiary.
    let ben_before = beneficiary.view_account().await?.balance;
    bob.call(vault.id(), "sweep").max_gas().transact().await?.into_result()?;
    let ben_after = beneficiary.view_account().await?.balance;
    let gained = ben_after.as_yoctonear().saturating_sub(ben_before.as_yoctonear());
    println!("beneficiary {SWEEP_TO} gained {gained} yoctoNEAR from sweep");
    assert!(gained > NearToken::from_millinear(7990).as_yoctonear(), "sweep should move ~8 NEAR to the beneficiary");
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), 0);

    // Balances are stale; alice can no longer withdraw.
    let drained = alice.call(vault.id(), "withdraw_all").deposit(ONE_YOCTO).max_gas().transact().await?;
    assert!(format!("{:?}", drained.into_result().unwrap_err()).contains("Vault is empty"));
    Ok(())
}

/// (3) NEP-366 delegate action (a relayer submits the user's signed `withdraw_all` with 1 yocto so
/// the vault sees `predecessor == user`). Skipped: near-workspaces 0.24 exposes no SignedDelegate /
/// meta-transaction builder, so this cannot be exercised in the sandbox. The `@keyhole/hatch`
/// package verifies the relayed-delegate path live on testnet instead.
#[tokio::test]
#[ignore = "near-workspaces 0.24 has no NEP-366 SignedDelegate support; @keyhole/hatch tests this live on testnet"]
async fn relayed_delegate_withdraw_all_predecessor_is_user() {
    // Intentionally empty: documented limitation, exercised live by @keyhole/hatch.
}
