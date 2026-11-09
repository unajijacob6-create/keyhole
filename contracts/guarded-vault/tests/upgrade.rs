//! Sandbox tests for the Keyhole guarded vault. They read the wasm that `contracts/test.sh`
//! builds into `contracts/out/`:
//!   (1) deposit + `withdraw_all` returns a user's funds (with the 1-yoctoNEAR gate);
//!   (2) a Sputnik-style upgrade: the owner calls `upgrade` with the raw bytes of the evil-sweep
//!       wasm as the call args (no JSON), the contract then exposes `sweep`, state is preserved,
//!       and `sweep` drains `total` to the compiled-in beneficiary;
//!   (3) the same upgrade driven by a real Sputnik v2 DAO (store_blob, UpgradeRemote, two votes);
//!   (4) a NEP-366 delegate action: a relayer submits the user's signed `withdraw_all`, the funds go
//!       to the user, the relayer pays, and a replay fails on the nonce;
//!   (5) a function-call access key cannot pay the 1 yoctoNEAR, directly or inside a delegate action.
//! near-workspaces 0.24 has no delegate-action builder, so (4) and (5) build and sign the
//! `SignedDelegateAction` and the relayer's transaction with near-primitives and send them over
//! JSON-RPC to the sandbox node.

use near_crypto::{InMemorySigner, Signer};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::transaction::{Action, FunctionCallAction, SignedTransaction, Transaction, TransactionV0};
use near_primitives::types::{Balance, Gas};
use near_primitives::views::{ExecutionStatusView, FinalExecutionOutcomeView, TxExecutionStatus};
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::ContractState;
use serde_json::{json, Value};

const HONEST: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/guarded_vault.wasm");
const EVIL_SWEEP: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../out/guarded_vault_evil_sweep.wasm");
// Sputnik v2 DAO code: the default code of the sputnikv2.testnet factory (tests/fixtures/README.md).
const SPUTNIK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sputnikdao2_testnet.wasm");
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

    // Settle first: a transaction's gas refund lands a few blocks after `transact()` returns, and
    // the failed max-gas call above was charged at the pessimistic gas price, so its refund is large
    // (measured: about 0.99 NEAR). Without this the "net" below counted it as withdrawn NEAR.
    worker.fast_forward(5).await?;
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

    // The NEAR actually returned to alice (5 minus gas and the 1 yocto), once this call's own gas
    // refund has landed too.
    worker.fast_forward(5).await?;
    let after = alice.view_account().await?.balance;
    let gained = after.as_yoctonear().saturating_sub(before.as_yoctonear());
    println!("alice net from withdraw_all: {gained} yoctoNEAR");
    assert!(gained > NearToken::from_millinear(4990).as_yoctonear(), "alice should recover ~5 NEAR minus gas");
    assert!(gained < NearToken::from_near(5).as_yoctonear(), "alice paid the gas, so she nets less than 5 NEAR");
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

/// (3) A real Sputnik v2 DAO drives the upgrade. The DAO wasm is the testnet factory's current
/// default code (see `tests/fixtures/README.md` for where it came from and how to re-check it).
/// A council member stores the evil-sweep blob and proposes `UpgradeRemote { method_name: "upgrade" }`;
/// the DAO needs 2 of 2 approvals. This checks, against Sputnik's own code rather than a stand-in:
///   - `store_blob` returns base58(sha256(blob)), and the proposal carries that hash;
///   - the first approval changes nothing; the second approval executes the proposal in the same
///     transaction (Sputnik has no delay between the deciding vote and execution);
///   - Sputnik delivers the stored blob to `upgrade` as raw input, and the vault's code hash becomes
///     exactly the proposal hash.
/// The DAO's call into the vault is a separate receipt that the DAO does not wait on, so a failed
/// upgrade would NOT fail the vote transaction: the test checks every receipt and the new code.
#[tokio::test]
async fn real_sputnik_dao_upgrade_remote_deploys_evil_sweep() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let dao = worker.dev_deploy(&read(SPUTNIK)?).await?;
    let c1 = worker.dev_create_account().await?;
    let c2 = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    // A plain list of accounts is Sputnik's default policy: one "council" role, threshold 1/2 of
    // its members by role weight. With two members that is floor(2/2)+1 = 2 approvals.
    dao.call("new")
        .args_json(json!({
            "config": {"name": "kh-sandbox", "purpose": "guarded-vault sandbox test", "metadata": ""},
            "policy": [c1.id(), c2.id()],
        }))
        .transact()
        .await?
        .into_result()?;

    let vault = worker.dev_deploy(&read(HONEST)?).await?;
    vault.call("new").args_json(json!({"owner_id": dao.id()})).transact().await?.into_result()?;
    alice.call(vault.id(), "deposit").deposit(NearToken::from_near(4)).transact().await?.into_result()?;

    // store_blob: raw wasm as args, deposit covers the blob's storage (excess is refunded).
    let blob = read(EVIL_SWEEP)?;
    let hash: String = c1
        .call(dao.id(), "store_blob")
        .args(blob.clone())
        .deposit(NearToken::from_near(3))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let kind = json!({"UpgradeRemote": {"receiver_id": vault.id(), "method_name": "upgrade", "hash": hash}});
    let id: u64 = c1
        .call(dao.id(), "add_proposal")
        .args_json(json!({"proposal": {"description": "upgrade the vault", "kind": kind}}))
        .deposit(NearToken::from_near(1)) // the default policy's proposal bond
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    let proposal: Value = dao.view("get_proposal").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(proposal["kind"]["UpgradeRemote"]["hash"], json!(hash));

    let vote = |who: &near_workspaces::Account| {
        who.call(dao.id(), "act_proposal")
            .args_json(json!({"id": id, "action": "VoteApprove", "proposal": kind}))
            .max_gas()
            .transact()
    };
    // First approval: below the threshold, nothing happens.
    vote(&c1).await?.into_result()?;
    let p: Value = dao.view("get_proposal").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(p["status"], "InProgress");
    assert_eq!(vault.view("version").await?.json::<String>()?, "1.0.0");

    // Second approval reaches the threshold and executes in this same transaction.
    let outcome = vote(&c2).await?;
    assert!(outcome.receipt_failures().is_empty(), "a receipt failed: {:?}", outcome.receipt_failures());
    outcome.into_result()?;
    let p: Value = dao.view("get_proposal").args_json(json!({"id": id})).await?.json()?;
    assert_eq!(p["status"], "Approved");
    assert_eq!(vault.view("version").await?.json::<String>()?, "1.1.0");
    // The chain's code hash is sha256 of the deployed code; it equals the proposal hash, which is
    // what store_blob returned for the blob's bytes.
    match vault.view_account().await?.contract_state {
        ContractState::LocalHash(h) => assert_eq!(h.to_string(), hash, "vault code hash != proposal hash"),
        other => panic!("vault has no local code: {other:?}"),
    }
    // State carried over and the DAO is still the owner.
    assert_eq!(vault.view("get_owner").await?.json::<String>()?, dao.id().as_str());
    assert_eq!(u128_of(vault.view("get_total").await?.json()?), NearToken::from_near(4).as_yoctonear());
    Ok(())
}

// --- NEP-366 delegate actions, built by hand (near-workspaces 0.24 has no builder for them). ---

fn signer_of(id: &near_workspaces::AccountId, sk: &SecretKey) -> anyhow::Result<Signer> {
    Ok(InMemorySigner::from_secret_key(id.as_str().parse()?, sk.to_string().parse()?))
}

/// The user's side of a hatch: a `withdraw_all` with 1 yoctoNEAR, signed as a delegate action by
/// `sk` (a key on `user`), valid for 100 blocks after the current head.
async fn sign_withdraw_all(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    user: &near_workspaces::AccountId,
    sk: &SecretKey,
    vault: &near_workspaces::AccountId,
) -> anyhow::Result<SignedDelegateAction> {
    let key = worker.view_access_key(user, &sk.public_key()).await?;
    let head = worker.view_block().await?.height();
    let call = Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "withdraw_all".into(),
        args: b"{}".to_vec(),
        gas: Gas::from_teragas(100),
        deposit: Balance::from_yoctonear(1),
    }));
    let action = DelegateAction {
        sender_id: user.as_str().parse()?,
        receiver_id: vault.as_str().parse()?,
        actions: vec![NonDelegateAction::try_from(call).map_err(|_| anyhow::anyhow!("nested delegate"))?],
        nonce: key.nonce + 1,
        max_block_height: head + 100,
        public_key: sk.to_string().parse::<near_crypto::SecretKey>()?.public_key(),
    };
    Ok(SignedDelegateAction::sign(&signer_of(user, sk)?, action))
}

/// The relayer's side: wrap the signed delegate in a transaction from `relayer` to the delegate's
/// sender and wait for every receipt to finish. Returns the full outcome; the caller inspects every
/// receipt, because the outer transaction succeeds even when the delegated call fails.
async fn relay(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    relayer: &near_workspaces::Account,
    delegate: SignedDelegateAction,
) -> anyhow::Result<FinalExecutionOutcomeView> {
    let key = worker.view_access_key(relayer.id(), &relayer.secret_key().public_key()).await?;
    let block = worker.view_block().await?;
    let signer = signer_of(relayer.id(), relayer.secret_key())?;
    let tx = Transaction::V0(TransactionV0 {
        signer_id: relayer.id().as_str().parse()?,
        public_key: signer.public_key(),
        nonce: key.nonce + 1,
        receiver_id: delegate.delegate_action.sender_id.clone(),
        block_hash: block.hash().to_string().parse().map_err(|e| anyhow::anyhow!("block hash: {e}"))?,
        actions: vec![Action::Delegate(Box::new(delegate))],
    });
    let (hash, _) = tx.get_hash_and_size();
    let signed = SignedTransaction::new(signer.sign(hash.as_ref()), tx);
    let client = JsonRpcClient::connect(worker.rpc_addr());
    let resp = client
        .call(methods::send_tx::RpcSendTransactionRequest { signed_transaction: signed, wait_until: TxExecutionStatus::Final })
        .await
        .map_err(|e| anyhow::anyhow!("send_tx: {e:?}"))?;
    resp.final_execution_outcome.map(|o| o.into_outcome()).ok_or_else(|| anyhow::anyhow!("no outcome"))
}

fn failures(o: &FinalExecutionOutcomeView) -> Vec<String> {
    o.receipts_outcome
        .iter()
        .filter_map(|r| match &r.outcome.status {
            ExecutionStatusView::Failure(e) => Some(format!("{e:?}")),
            _ => None,
        })
        .collect()
}

/// (4) The hatch path: Alice signs `withdraw_all` (1 yoctoNEAR) as a NEP-366 delegate action with her
/// full-access key; a separate relayer submits it. The vault sees `predecessor == alice`, so her
/// whole balance comes back to her, and she pays nothing: her NEAR goes up by exactly her deposit,
/// while the relayer pays the gas and the 1 yoctoNEAR. Replaying the same signed delegate fails
/// on the nonce, even after she deposits again.
#[tokio::test]
async fn relayed_delegate_withdraw_all_pays_the_user() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&read(HONEST)?).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;
    alice.call(vault.id(), "deposit").deposit(NearToken::from_near(5)).transact().await?.into_result()?;

    let delegate = sign_withdraw_all(&worker, alice.id(), alice.secret_key(), vault.id()).await?;
    let signed_nonce = delegate.delegate_action.nonce;
    // Let alice's own deposit transaction settle first: its gas refund lands a block or two after
    // `transact()` returns (measured: about 0.01 NEAR here), and would otherwise be counted as if
    // the relayed withdraw had paid it.
    worker.fast_forward(5).await?;
    let alice_before = alice.view_account().await?.balance.as_yoctonear();
    let relayer_before = relayer.view_account().await?.balance.as_yoctonear();

    let o = relay(&worker, &relayer, delegate.clone()).await?;
    assert!(failures(&o).is_empty(), "delegated withdraw_all failed: {:?}", failures(&o));
    // The vault logged the predecessor it saw: alice, not the relayer.
    let logs: Vec<&String> = o.receipts_outcome.iter().flat_map(|r| r.outcome.logs.iter()).collect();
    let expected = format!("withdraw_all {} {}", alice.id(), NearToken::from_near(5).as_yoctonear());
    assert!(logs.iter().any(|l| **l == expected), "expected log {expected:?}, got {logs:?}");

    let alice_after = alice.view_account().await?.balance.as_yoctonear();
    let relayer_after = relayer.view_account().await?.balance.as_yoctonear();
    println!("alice +{} yocto; relayer -{} yocto", alice_after - alice_before, relayer_before - relayer_after);
    assert_eq!(alice_after - alice_before, NearToken::from_near(5).as_yoctonear(), "alice gets exactly her 5 NEAR");
    assert!(relayer_before - relayer_after > 1, "the relayer pays the gas and the 1 yoctoNEAR");
    assert_eq!(u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?), 0);
    // Using the delegate moved alice's key nonce to the signed nonce.
    assert_eq!(worker.view_access_key(alice.id(), &alice.secret_key().public_key()).await?.nonce, signed_nonce);

    // Replay: alice deposits again, the relayer resubmits the same signed delegate. Rejected on the
    // nonce, and her new deposit stays in the vault.
    alice.call(vault.id(), "deposit").deposit(NearToken::from_near(1)).transact().await?.into_result()?;
    let replay = relay(&worker, &relayer, delegate).await?;
    let f = failures(&replay);
    assert!(f.iter().any(|e| e.contains("DelegateActionInvalidNonce")), "replay should fail on the nonce, got {f:?}");
    assert_eq!(
        u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?),
        NearToken::from_near(1).as_yoctonear()
    );
    Ok(())
}

/// (5) Why the hatch needs a full-access key: a function-call access key cannot attach a deposit,
/// so it cannot pay `withdraw_all`'s 1 yoctoNEAR — neither in a transaction nor inside a delegate
/// action — and without the deposit `assert_one_yocto` rejects the call.
#[tokio::test]
async fn function_call_key_cannot_withdraw_all() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let vault = worker.dev_deploy(&read(HONEST)?).await?;
    let owner = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    vault.call("new").args_json(json!({"owner_id": owner.id()})).transact().await?.into_result()?;
    alice.call(vault.id(), "deposit").deposit(NearToken::from_near(2)).transact().await?.into_result()?;

    let fc_sk = SecretKey::from_random(KeyType::ED25519);
    alice
        .batch(alice.id())
        .add_key(fc_sk.public_key(), AccessKey::function_call_access(vault.id(), &["withdraw_all"], None))
        .transact()
        .await?
        .into_result()?;
    let alice_fc = near_workspaces::Account::from_secret_key(alice.id().clone(), fc_sk.clone(), &worker);

    // With the 1 yoctoNEAR: the transaction itself is invalid.
    let err = alice_fc.call(vault.id(), "withdraw_all").deposit(ONE_YOCTO).max_gas().transact().await;
    let msg = format!("{:?}", err.map(|r| r.into_result()));
    assert!(msg.contains("DepositWithFunctionCall"), "expected DepositWithFunctionCall, got {msg}");
    // Without it: the vault's 1-yoctoNEAR gate rejects the call.
    let r = alice_fc.call(vault.id(), "withdraw_all").max_gas().transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("Requires attached deposit of exactly 1 yoctoNEAR"));
    // Signed as a delegate action by the function-call key: the relayed receipt is rejected too.
    let delegate = sign_withdraw_all(&worker, alice.id(), &fc_sk, vault.id()).await?;
    let o = relay(&worker, &relayer, delegate).await?;
    let f = failures(&o);
    assert!(f.iter().any(|e| e.contains("DepositWithFunctionCall")), "expected DepositWithFunctionCall, got {f:?}");

    assert_eq!(
        u128_of(vault.view("get_balance").args_json(json!({"account_id": alice.id()})).await?.json()?),
        NearToken::from_near(2).as_yoctonear(),
        "nothing was withdrawn"
    );
    Ok(())
}
