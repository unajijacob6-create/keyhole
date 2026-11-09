use super::*;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

// accounts(0) = owner, accounts(1) = attester, accounts(2) = outsider, accounts(3) = watched.
const H1: &str = "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ";
const H2: &str = "EbUFMRSG4E94mAPNeeJbv4zWN9kB46jceM6m3sqf4EfB";
const H3: &str = "8tLQmm7FtsJg9XoPmsyfB2bCkG2pjgXDaEBPCv6mj5zS";
const SHA: &str = "c9fc7c80d653b9a201fa42307d7ba3aebcc0f3a5c0f55790767c8abcb3f003d2";
const PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

fn ctx(predecessor: usize, height: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("registry.testnet".parse().unwrap())
        .predecessor_account_id(accounts(predecessor))
        .block_height(height)
        .block_timestamp(height * 1_000_000_000)
        .build());
}

fn registry() -> Registry {
    ctx(0, 1);
    let mut r = Registry::new(accounts(0));
    assert!(r.add_attester(accounts(1)));
    ctx(1, 2);
    r
}

fn change(old: &str, new: &str, height: u64) -> Attestation {
    Attestation::ChangeObserved { account: accounts(3), old_hash: old.into(), new_hash: new.into(), block_height: height }
}

fn build(matches: bool) -> Attestation {
    Attestation::ReproducibleBuild {
        account: Some(accounts(3)),
        repo: "https://github.com/unajijacob6-create/keyhole".into(),
        rev: "0123456789abcdef0123456789abcdef01234567".into(),
        image_digest: "sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc".into(),
        matches,
    }
}

fn review() -> Attestation {
    Attestation::AiReview {
        model: "deepseek-ai/DeepSeek-V3.1".into(),
        request_sha256: SHA.into(),
        response_sha256: SHA.into(),
        signer: "0x319f1b8BB3b723A5d098FAB6f5a0b9a6E2aEeF8F".into(),
        chat_id: "chatcmpl-123".into(),
        verdict_summary: "Owner can sweep all deposits.".into(),
    }
}

fn key_added(pk: &str) -> Attestation {
    Attestation::KeyAdded { account: accounts(3), public_key: pk.into(), block_height: 9 }
}

fn events(event: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["event"] == event)
        .collect()
}

// ---- auth ----

#[test]
fn init_state() {
    let r = registry();
    assert_eq!(r.get_owner(), accounts(0));
    assert_eq!(r.get_attesters(), vec![accounts(1)]);
    assert!(r.is_attester(accounts(1)));
    assert!(!r.is_attester(accounts(2)));
    assert_eq!(r.get_stats(), Stats { attestations: 0, accounts: 0 });
}

#[test]
#[should_panic(expected = "Only attesters can attest")]
fn non_attester_rejected() {
    let mut r = registry();
    ctx(2, 3);
    r.attest(H1.into(), review());
}

#[test]
#[should_panic(expected = "Only attesters can attest")]
fn owner_is_not_implicitly_an_attester() {
    let mut r = registry();
    ctx(0, 3);
    r.attest(H1.into(), review());
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn non_owner_cannot_add_attester() {
    let mut r = registry();
    ctx(1, 3);
    r.add_attester(accounts(2));
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn non_owner_cannot_remove_attester() {
    let mut r = registry();
    ctx(2, 3);
    r.remove_attester(accounts(1));
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn non_owner_cannot_set_owner() {
    let mut r = registry();
    ctx(1, 3);
    r.set_owner(accounts(1));
}

#[test]
#[should_panic(expected = "Only attesters can attest")]
fn removed_attester_rejected() {
    let mut r = registry();
    ctx(0, 3);
    assert!(r.remove_attester(accounts(1)));
    assert!(!r.remove_attester(accounts(1)));
    assert!(events("attester_removed").len() == 1);
    ctx(1, 4);
    r.attest(H1.into(), review());
}

#[test]
fn set_owner_moves_control() {
    let mut r = registry();
    ctx(0, 3);
    r.set_owner(accounts(2));
    assert_eq!(r.get_owner(), accounts(2));
    let ev = events("owner_changed");
    assert_eq!(ev[0]["data"][0]["old_owner_id"], accounts(0).as_str());
    assert_eq!(ev[0]["data"][0]["new_owner_id"], accounts(2).as_str());
    ctx(2, 4);
    assert!(r.add_attester(accounts(4)));
    assert!(!r.add_attester(accounts(4)));
    assert_eq!(events("attester_added").len(), 1);
}

// ---- validation ----

#[test]
fn hash_formats() {
    assert!(is_code_hash(H1));
    assert!(is_code_hash(NO_CODE_HASH));
    assert!(!is_code_hash(""));
    assert!(!is_code_hash("4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJD0")); // '0' not base58
    assert!(!is_code_hash("4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZZ")); // 45 chars
    assert!(!is_code_hash("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")); // > 32 bytes
    assert!(!is_code_hash("1111111111111111111111111111111")); // 31 bytes
    assert!(is_sha256_hex(SHA));
    assert!(!is_sha256_hex(&SHA.to_uppercase()));
    assert!(!is_sha256_hex(&SHA[1..]));
}

#[test]
#[should_panic(expected = "code_hash must be a base58 32-byte hash")]
fn bad_code_hash_rejected() {
    let mut r = registry();
    r.attest("not-a-hash".into(), review());
}

#[test]
#[should_panic(expected = "code_hash must equal new_hash")]
fn change_code_hash_must_be_new_hash() {
    let mut r = registry();
    r.attest(H1.into(), change(H1, H2, 5));
}

#[test]
#[should_panic(expected = "old_hash must be a base58 32-byte hash")]
fn change_bad_old_hash_rejected() {
    let mut r = registry();
    r.attest(H2.into(), change("xyz", H2, 5));
}

#[test]
#[should_panic(expected = "old_hash and new_hash are equal")]
fn change_needs_a_change() {
    let mut r = registry();
    r.attest(H2.into(), change(H2, H2, 5));
}

#[test]
#[should_panic(expected = "request_sha256 must be 64 lowercase hex characters")]
fn review_bad_sha_rejected() {
    let mut r = registry();
    let Attestation::AiReview { model, response_sha256, signer, chat_id, verdict_summary, .. } = review() else { unreachable!() };
    r.attest(
        H1.into(),
        Attestation::AiReview { model, request_sha256: SHA.to_uppercase(), response_sha256, signer, chat_id, verdict_summary },
    );
}

#[test]
#[should_panic(expected = "verdict_summary must be 1-280 bytes")]
fn review_long_summary_rejected() {
    let mut r = registry();
    let Attestation::AiReview { model, request_sha256, response_sha256, signer, chat_id, .. } = review() else { unreachable!() };
    r.attest(
        H1.into(),
        Attestation::AiReview { model, request_sha256, response_sha256, signer, chat_id, verdict_summary: "x".repeat(281) },
    );
}

#[test]
#[should_panic(expected = "repo must be 1-200 bytes")]
fn build_long_repo_rejected() {
    let mut r = registry();
    let Attestation::ReproducibleBuild { account, rev, image_digest, matches, .. } = build(true) else { unreachable!() };
    r.attest(H1.into(), Attestation::ReproducibleBuild { account, repo: "r".repeat(201), rev, image_digest, matches });
}

#[test]
#[should_panic(expected = "rev must be 1-200 bytes")]
fn build_empty_rev_rejected() {
    let mut r = registry();
    let Attestation::ReproducibleBuild { account, repo, image_digest, matches, .. } = build(true) else { unreachable!() };
    r.attest(H1.into(), Attestation::ReproducibleBuild { account, repo, rev: String::new(), image_digest, matches });
}

#[test]
#[should_panic(expected = "public_key must look like ed25519:<base58>")]
fn key_bad_public_key_rejected() {
    let mut r = registry();
    r.attest(H1.into(), key_added("ed25519:not-base58!"));
}

#[test]
#[should_panic(expected = "public_key must be 1-100 bytes")]
fn key_long_public_key_rejected() {
    let mut r = registry();
    r.attest(H1.into(), key_added(&format!("ed25519:{}", "1".repeat(100))));
}

// ---- behaviour ----

#[test]
fn change_observed_updates_history_and_latest() {
    let mut r = registry();
    assert_eq!(r.get_latest(accounts(3)), None);
    let a = r.attest(H1.into(), change(NO_CODE_HASH, H1, 10));
    ctx(1, 3);
    let b = r.attest(H2.into(), change(H1, H2, 20));
    assert_eq!((a, b), (1, 2));

    let history = r.get_history(accounts(3), None, None);
    assert_eq!(history.iter().map(|x| x.id).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(history[1].attestation, change(H1, H2, 20));
    assert_eq!(history[1].code_hash, H2);
    assert_eq!(history[1].attester, accounts(1));
    assert_eq!(history[1].block_height, 3);
    assert_eq!(history[1].timestamp_ms, 3_000);

    let latest = r.get_latest(accounts(3)).unwrap();
    assert_eq!(latest.id, 2);
    assert_eq!(r.get_attestations(H2.into(), None, None), vec![latest.clone()]);
    assert_eq!(r.get_attestation(2), Some(latest));
    assert_eq!(r.get_attestation(3), None);
    assert_eq!(r.get_stats(), Stats { attestations: 2, accounts: 1 });
}

#[test]
fn other_kinds_are_indexed_by_hash_only() {
    let mut r = registry();
    r.attest(H1.into(), build(false));
    r.attest(H1.into(), review());
    let records = r.get_attestations(H1.into(), None, None);
    assert_eq!(records.iter().map(|x| x.attestation.kind()).collect::<Vec<_>>(), vec!["ReproducibleBuild", "AiReview"]);
    assert!(r.get_history(accounts(3), None, None).is_empty());
    assert_eq!(r.get_latest(accounts(3)), None);
    assert_eq!(r.get_stats(), Stats { attestations: 2, accounts: 0 });
}

#[test]
fn key_added_goes_to_key_events() {
    let mut r = registry();
    let id = r.attest(H1.into(), key_added(PK));
    let ev = r.get_key_events(accounts(3), None, None);
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].id, id);
    assert_eq!(ev[0].attestation, key_added(PK));
    assert!(r.get_history(accounts(3), None, None).is_empty());
    assert_eq!(r.get_latest(accounts(3)), None);
    assert_eq!(r.get_stats(), Stats { attestations: 1, accounts: 1 });
    // A later change on the same account does not count it twice.
    r.attest(H2.into(), change(H1, H2, 10));
    assert_eq!(r.get_stats(), Stats { attestations: 2, accounts: 1 });
    assert_eq!(r.get_attestations(H1.into(), None, None).len(), 1);
}

#[test]
fn pagination() {
    let mut r = registry();
    let hashes = [H1, H2, H3];
    for i in 0..7usize {
        let (old, new) = (hashes[i % 3], hashes[(i + 1) % 3]);
        r.attest(new.into(), change(old, new, i as u64));
    }
    let ids = |v: Vec<Record>| v.iter().map(|x| x.id).collect::<Vec<_>>();
    assert_eq!(ids(r.get_history(accounts(3), None, None)), (1..=7).collect::<Vec<_>>());
    assert_eq!(ids(r.get_history(accounts(3), Some(2), Some(3))), vec![3, 4, 5]);
    assert_eq!(ids(r.get_history(accounts(3), Some(5), Some(10))), vec![6, 7]);
    assert!(r.get_history(accounts(3), Some(7), None).is_empty());
    assert!(r.get_history(accounts(3), Some(u32::MAX), Some(u32::MAX)).is_empty());
    assert!(r.get_history(accounts(3), None, Some(0)).is_empty());
    // H2 is the new hash at i = 0, 3, 6.
    assert_eq!(ids(r.get_attestations(H2.into(), None, None)), vec![1, 4, 7]);
    assert_eq!(ids(r.get_attestations(H2.into(), Some(1), Some(1))), vec![4]);
    assert!(r.get_attestations("unknown".into(), None, None).is_empty());
    assert_eq!(r.get_latest(accounts(3)).unwrap().id, 7);
}

#[test]
fn page_size_is_capped() {
    let mut r = registry();
    for i in 0..(MAX_LIMIT + 5) {
        ctx(1, 10 + i as u64); // fresh context: logs are capped per call
        r.attest(H1.into(), review());
    }
    assert_eq!(r.get_attestations(H1.into(), None, None).len(), DEFAULT_LIMIT as usize);
    assert_eq!(r.get_attestations(H1.into(), None, Some(1000)).len(), MAX_LIMIT as usize);
    assert_eq!(r.get_attestations(H1.into(), Some(MAX_LIMIT), Some(1000)).len(), 5);
}

#[test]
fn attestation_event_emitted() {
    let mut r = registry();
    r.attest(H2.into(), change(H1, H2, 42));
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].starts_with(r#"EVENT_JSON:{"#));
    let ev = &events("attestation")[0];
    assert_eq!(ev["standard"], "keyhole");
    assert_eq!(ev["version"], "1.0.0");
    let data = &ev["data"][0];
    assert_eq!(data["id"], 1);
    assert_eq!(data["code_hash"], H2);
    assert_eq!(data["kind"], "ChangeObserved");
    assert_eq!(data["attester"], accounts(1).as_str());
    assert_eq!(data["account"], accounts(3).as_str());
    assert_eq!(data["old_hash"], H1);
    assert_eq!(data["new_hash"], H2);
    assert_eq!(data["block_height"], 42);
    assert_eq!(data["timestamp_ms"], 2_000);

    ctx(1, 3);
    r.attest(H1.into(), review());
    let data = &events("attestation")[0]["data"][0];
    assert_eq!(data["kind"], "AiReview");
    assert_eq!(data["verdict_summary"], "Owner can sweep all deposits.");
    assert_eq!(data["id"], 2);
}

#[test]
fn admin_events_emitted() {
    ctx(0, 1);
    let mut r = Registry::new(accounts(0));
    r.add_attester(accounts(1));
    let ev = events("attester_added");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "keyhole");
    assert_eq!(ev[0]["data"][0]["account_id"], accounts(1).as_str());
    assert_eq!(ev[0]["data"][0]["by"], accounts(0).as_str());
}

#[test]
fn attestation_json_shape() {
    let v = serde_json::to_value(build(true)).unwrap();
    assert_eq!(v["kind"], "ReproducibleBuild");
    assert_eq!(v["matches"], true);
    let parsed: Attestation = serde_json::from_value(json!({
        "kind": "ReproducibleBuild",
        "repo": "r", "rev": "v", "image_digest": "d", "matches": false
    }))
    .unwrap();
    assert!(matches!(parsed, Attestation::ReproducibleBuild { account: None, .. }));
}
