//! Sandbox test of the Keyhole demo: an honest v1 vault is silently replaced by v2 using the
//! full-access key left on the vault account, v2 reads v1 state as-is, and the owner drains it.
//! Reads contracts/out/demo_vault_v{1,2}.wasm (contracts/test.sh builds them).

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const V1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/demo_vault_v1.wasm");
const V2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/demo_vault_v2.wasm");

fn read(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; run contracts/test.sh first"))
}

fn u128_of(v: Value) -> u128 {
    v.as_str().expect("U128 string").parse().unwrap()
}

#[tokio::test]
async fn silent_upgrade_drains_vault() -> anyhow::Result<()> {
    let (v1, v2) = (read(V1)?, read(V2)?);
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&v1).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;

    let meta: Value = vault.view("contract_source_metadata").await?.json()?;
    println!("demo-vault-v1 contract_source_metadata: {meta}");
    assert_eq!(meta["version"], "1.0.0");
    assert_eq!(vault.view("version").await?.json::<String>()?, "1.0.0");

    for (who, near) in [(&alice, 5), (&bob, 3)] {
        who.call(vault.id(), "deposit").deposit(NearToken::from_near(near)).transact().await?.into_result()?;
    }
    // v1 is honest: withdraw works and the private callback cannot be called directly.
    let ok: bool = alice
        .call(vault.id(), "withdraw")
        .args_json(json!({"amount": NearToken::from_near(1).as_yoctonear().to_string()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(ok);
    let res = bob
        .call(vault.id(), "on_withdraw")
        .args_json(json!({"account_id": bob.id(), "amount": "1"}))
        .transact()
        .await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("is private"));
    let res = owner.call(vault.id(), "sweep").args_json(json!({"to": owner.id()})).transact().await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("MethodNotFound"));
    let total = u128_of(vault.view("get_total").await?.json()?);
    assert_eq!(total, NearToken::from_near(7).as_yoctonear());

    // The silent upgrade: the vault account's own full-access key redeploys the code.
    let before = vault.view_account().await?.contract_state;
    vault.as_account().deploy(&v2).await?.into_result()?;
    let after = vault.view_account().await?.contract_state;
    println!("code v1 {before:?} -> v2 {after:?}");
    assert_ne!(before, after);

    let meta: Value = vault.view("contract_source_metadata").await?.json()?;
    println!("demo-vault-v2 contract_source_metadata: {meta}");
    assert_eq!(vault.view("version").await?.json::<String>()?, "2.0.0");
    // v2 reads v1 state with no migration.
    assert_eq!(vault.view("get_owner").await?.json::<String>()?, owner.id().as_str());
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), total);
    let alice_balance = u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?);
    assert_eq!(alice_balance, NearToken::from_near(4).as_yoctonear());

    // Only the owner can sweep.
    let res = alice.call(vault.id(), "sweep").args_json(json!({"to": alice.id()})).transact().await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("Only the owner can sweep"));

    let owner_before = owner.view_account().await?.balance;
    owner.call(vault.id(), "sweep").args_json(json!({"to": owner.id()})).transact().await?.into_result()?;
    let owner_after = owner.view_account().await?.balance;
    let gained = owner_after.as_yoctonear() - owner_before.as_yoctonear();
    println!("owner gained {} yoctoNEAR from sweep", gained);
    assert!(gained > NearToken::from_millinear(6990).as_yoctonear(), "sweep should move ~7 NEAR minus gas");
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), 0);

    // Balances are stale; the money behind them is gone.
    let res = alice
        .call(vault.id(), "withdraw")
        .args_json(json!({"amount": alice_balance.to_string()}))
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("Vault is empty"));
    Ok(())
}
