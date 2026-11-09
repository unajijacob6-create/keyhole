//! Sandbox tests for the Keyhole registry: deploy the built wasm, attest every kind, read views.
//! Build the wasm first (contracts/test.sh does): it is read from contracts/out/registry.wasm.

use near_workspaces::types::NearToken;
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};

const WASM_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/registry.wasm");
const H1: &str = "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ";
const H2: &str = "EbUFMRSG4E94mAPNeeJbv4zWN9kB46jceM6m3sqf4EfB";
const SHA: &str = "c9fc7c80d653b9a201fa42307d7ba3aebcc0f3a5c0f55790767c8abcb3f003d2";
const NO_CODE: &str = "11111111111111111111111111111111";

struct Env {
    _worker: Worker<Sandbox>,
    registry: Contract,
    owner: Account,
    attester: Account,
    outsider: Account,
    watched: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let wasm = std::fs::read(WASM_PATH).map_err(|e| anyhow::anyhow!("{WASM_PATH}: {e}; run contracts/test.sh first"))?;
    let worker = near_workspaces::sandbox().await?;
    let registry = worker.dev_deploy(&wasm).await?;
    let owner = worker.dev_create_account().await?;
    let attester = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let watched = worker.dev_create_account().await?;
    registry.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;
    let added: bool = owner
        .call(registry.id(), "add_attester")
        .args_json(json!({"account_id": attester.id()}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(added);
    Ok(Env { _worker: worker, registry, owner, attester, outsider, watched })
}

async fn attest(env: &Env, by: &Account, code_hash: &str, attestation: Value) -> anyhow::Result<u64> {
    let res = by
        .call(env.registry.id(), "attest")
        .args_json(json!({"code_hash": code_hash, "attestation": attestation}))
        .transact()
        .await?;
    let logs = res.logs().iter().map(|l| l.to_string()).collect::<Vec<_>>();
    let id: u64 = res.into_result()?.json()?;
    let event: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").expect("event log"))?;
    assert_eq!(event["standard"], "keyhole");
    assert_eq!(event["event"], "attestation");
    assert_eq!(event["data"][0]["id"], id);
    assert_eq!(event["data"][0]["kind"], attestation["kind"]);
    assert_eq!(event["data"][0]["code_hash"], code_hash);
    Ok(id)
}

async fn view(env: &Env, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(env.registry.view(method).args_json(args).await?.json()?)
}

#[tokio::test]
async fn registry_end_to_end() -> anyhow::Result<()> {
    let env = setup().await?;
    let watched = env.watched.id();

    // NEP-330 metadata is embedded by near-sdk; print it for the record.
    let meta = view(&env, "contract_source_metadata", json!({})).await?;
    println!("registry contract_source_metadata: {meta}");
    assert_eq!(meta["link"], "https://github.com/unajijacob6-create/keyhole");
    assert!(meta["standards"].as_array().unwrap().iter().any(|s| s["standard"] == "nep330"));
    assert!(meta["standards"].as_array().unwrap().iter().any(|s| s["standard"] == "keyhole"));

    let storage_before = env.registry.view_account().await?.storage_usage;
    let a = &env.attester;
    let first = attest(
        &env,
        a,
        H1,
        json!({"kind": "ChangeObserved", "account": watched, "old_hash": NO_CODE, "new_hash": H1, "block_height": 100}),
    )
    .await?;
    let second = attest(
        &env,
        a,
        H2,
        json!({"kind": "ChangeObserved", "account": watched, "old_hash": H1, "new_hash": H2, "block_height": 200}),
    )
    .await?;
    let build = attest(
        &env,
        a,
        H1,
        json!({"kind": "ReproducibleBuild", "account": watched, "repo": "https://github.com/unajijacob6-create/keyhole",
               "rev": "0123456789abcdef0123456789abcdef01234567", "image_digest": "sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc",
               "matches": true}),
    )
    .await?;
    let review = attest(
        &env,
        a,
        H2,
        json!({"kind": "AiReview", "model": "deepseek-ai/DeepSeek-V3.1", "request_sha256": SHA, "response_sha256": SHA,
               "signer": "0x319f1b8BB3b723A5d098FAB6f5a0b9a6E2aEeF8F", "chat_id": "chatcmpl-1",
               "verdict_summary": "New code adds sweep(): the owner can take every deposit."}),
    )
    .await?;
    let key = attest(
        &env,
        a,
        H2,
        json!({"kind": "KeyAdded", "account": watched, "public_key": "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", "block_height": 210}),
    )
    .await?;
    assert_eq!((first, second, build, review, key), (1, 2, 3, 4, 5));

    let history = view(&env, "get_history", json!({"account_id": watched})).await?;
    assert_eq!(history.as_array().unwrap().len(), 2);
    assert_eq!(history[0]["attestation"]["new_hash"], H1);
    assert_eq!(history[1]["attestation"]["old_hash"], H1);
    assert_eq!(history[1]["attester"], a.id().as_str());
    assert!(history[1]["block_height"].as_u64().unwrap() > 0);
    assert!(history[1]["timestamp_ms"].as_u64().unwrap() > 0);
    let page = view(&env, "get_history", json!({"account_id": watched, "from_index": 1, "limit": 1})).await?;
    assert_eq!(page[0]["id"], 2);

    let latest = view(&env, "get_latest", json!({"account_id": watched})).await?;
    assert_eq!(latest["id"], 2);
    assert_eq!(latest["code_hash"], H2);
    assert_eq!(view(&env, "get_latest", json!({"account_id": env.outsider.id()})).await?, Value::Null);

    let on_h2 = view(&env, "get_attestations", json!({"code_hash": H2})).await?;
    let kinds: Vec<&str> = on_h2.as_array().unwrap().iter().map(|r| r["attestation"]["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["ChangeObserved", "AiReview", "KeyAdded"]);
    let on_h1 = view(&env, "get_attestations", json!({"code_hash": H1})).await?;
    assert_eq!(on_h1[1]["attestation"]["matches"], true);

    let keys = view(&env, "get_key_events", json!({"account_id": watched})).await?;
    assert_eq!(keys.as_array().unwrap().len(), 1);
    assert_eq!(keys[0]["attestation"]["public_key"], "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp");

    assert_eq!(view(&env, "get_stats", json!({})).await?, json!({"attestations": 5, "accounts": 1}));
    assert_eq!(view(&env, "get_attesters", json!({})).await?, json!([a.id()]));
    assert_eq!(view(&env, "get_owner", json!({})).await?, json!(env.owner.id()));

    // Storage is paid by the registry itself; attesters attach nothing.
    let storage_after = env.registry.view_account().await?.storage_usage;
    println!(
        "registry storage: {storage_after} bytes total, {} bytes for 5 attestations (one per kind, ChangeObserved twice)",
        storage_after - storage_before
    );
    Ok(())
}

#[tokio::test]
async fn unauthorized_calls_fail() -> anyhow::Result<()> {
    let env = setup().await?;
    let review = json!({"kind": "AiReview", "model": "m", "request_sha256": SHA, "response_sha256": SHA,
                        "signer": "s", "chat_id": "c", "verdict_summary": "ok"});

    let res = env
        .outsider
        .call(env.registry.id(), "attest")
        .args_json(json!({"code_hash": H1, "attestation": review}))
        .transact()
        .await?;
    assert!(res.is_failure());
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("Only attesters can attest"));

    let res = env
        .attester
        .call(env.registry.id(), "add_attester")
        .args_json(json!({"account_id": env.outsider.id()}))
        .transact()
        .await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("Only the owner can do this"));

    // Validation runs on-chain too.
    let res = env
        .attester
        .call(env.registry.id(), "attest")
        .args_json(json!({"code_hash": H1, "attestation":
            {"kind": "ChangeObserved", "account": env.watched.id(), "old_hash": NO_CODE, "new_hash": H2, "block_height": 1}}))
        .transact()
        .await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("code_hash must equal new_hash"));

    // The owner can revoke an attester.
    env.owner
        .call(env.registry.id(), "remove_attester")
        .args_json(json!({"account_id": env.attester.id()}))
        .transact()
        .await?
        .into_result()?;
    let res = env
        .attester
        .call(env.registry.id(), "attest")
        .args_json(json!({"code_hash": H1, "attestation": review}))
        .transact()
        .await?;
    assert!(res.is_failure());
    assert_eq!(env.registry.view("get_stats").await?.json::<Value>()?, json!({"attestations": 0, "accounts": 0}));

    // The registry has no upgrade path: no such method exists.
    let res = env.owner.call(env.registry.id(), "upgrade").deposit(NearToken::from_yoctonear(0)).transact().await?;
    assert!(format!("{:?}", res.into_result().unwrap_err()).contains("MethodNotFound"));
    Ok(())
}
