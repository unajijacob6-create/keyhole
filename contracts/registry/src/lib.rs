//! Keyhole registry: attestations about NEAR contract code, keyed by code hash.
//!
//! Trusted attesters record what they observed about a code hash (the base58 string that
//! NEAR RPC `view_account` returns as `code_hash`):
//! - `ChangeObserved`: a watched account's code hash changed (also kept per account);
//! - `KeyAdded`: a full-access key was added to a watched account (also kept per account);
//! - `ReproducibleBuild`: a reproducible build of `repo@rev` does or does not produce it;
//! - `AiReview`: hashes and a short verdict of a verifiable AI review of the source.
//!
//! The registry stores only hashes and short summaries, never source code. The contract
//! pays for storage from its own balance. It is append-only and deliberately has no
//! upgrade, migrate or code-deploy method: once deployed (and with no full-access key left
//! on the account) its code cannot change.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, CryptoHash, PanicOnDefault, PublicKey};

pub const EVENT_STANDARD: &str = "keyhole";
pub const EVENT_VERSION: &str = "1.0.0";
/// Default page size for the paginated views.
pub const DEFAULT_LIMIT: u32 = 50;
/// Largest page size the paginated views return.
pub const MAX_LIMIT: u32 = 100;
pub const MAX_SHORT_LEN: usize = 200;
pub const MAX_SUMMARY_LEN: usize = 280;
pub const MAX_PUBLIC_KEY_LEN: usize = 100;
/// `code_hash` of an account with no code (32 zero bytes in base58).
pub const NO_CODE_HASH: &str = "11111111111111111111111111111111";

#[near(serializers = [borsh, json])]
#[serde(tag = "kind")]
#[derive(Clone, Debug, PartialEq)]
pub enum Attestation {
    ChangeObserved { account: AccountId, old_hash: String, new_hash: String, block_height: u64 },
    ReproducibleBuild { account: Option<AccountId>, repo: String, rev: String, image_digest: String, matches: bool },
    AiReview {
        model: String,
        request_sha256: String,
        response_sha256: String,
        signer: String,
        chat_id: String,
        verdict_summary: String,
    },
    KeyAdded { account: AccountId, public_key: String, block_height: u64 },
}

impl Attestation {
    pub fn kind(&self) -> &'static str {
        match self {
            Attestation::ChangeObserved { .. } => "ChangeObserved",
            Attestation::ReproducibleBuild { .. } => "ReproducibleBuild",
            Attestation::AiReview { .. } => "AiReview",
            Attestation::KeyAdded { .. } => "KeyAdded",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub id: u64,
    pub code_hash: String,
    pub attestation: Attestation,
    pub attester: AccountId,
    /// Block height at which the registry stored the record.
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    /// Number of attestations of every kind.
    pub attestations: u64,
    /// Number of distinct accounts with at least one `ChangeObserved` or `KeyAdded` record.
    pub accounts: u64,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Attesters,
    Records,
    ByHash,
    ByHashList { key: CryptoHash },
    History,
    HistoryList { key: CryptoHash },
    KeyEvents,
    KeyEventsList { key: CryptoHash },
    Latest,
}

#[near(contract_state, contract_metadata(standard(standard = "keyhole", version = "1.0.0")))]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner_id: AccountId,
    attesters: IterableSet<AccountId>,
    /// Every record, by id. Ids start at 1.
    records: LookupMap<u64, Record>,
    /// code hash -> record ids, oldest first.
    by_hash: LookupMap<String, Vector<u64>>,
    /// account -> `ChangeObserved` record ids, oldest first.
    history: LookupMap<AccountId, Vector<u64>>,
    /// account -> `KeyAdded` record ids, oldest first.
    key_events: LookupMap<AccountId, Vector<u64>>,
    /// account -> id of its latest `ChangeObserved` record.
    latest: LookupMap<AccountId, u64>,
    /// Id of the last record (0 = none yet).
    last_id: u64,
    accounts: u64,
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            attesters: IterableSet::new(StorageKey::Attesters),
            records: LookupMap::new(StorageKey::Records),
            by_hash: LookupMap::new(StorageKey::ByHash),
            history: LookupMap::new(StorageKey::History),
            key_events: LookupMap::new(StorageKey::KeyEvents),
            latest: LookupMap::new(StorageKey::Latest),
            last_id: 0,
            accounts: 0,
        }
    }

    // ---- owner ----

    /// Owner only. Returns false if `account_id` already was an attester.
    pub fn add_attester(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        let added = self.attesters.insert(account_id.clone());
        if added {
            emit("attester_added", json!({ "account_id": account_id, "by": self.owner_id }));
        }
        added
    }

    /// Owner only. Returns false if `account_id` was not an attester.
    pub fn remove_attester(&mut self, account_id: AccountId) -> bool {
        self.assert_owner();
        let removed = self.attesters.remove(&account_id);
        if removed {
            emit("attester_removed", json!({ "account_id": account_id, "by": self.owner_id }));
        }
        removed
    }

    /// Owner only. Hands the registry to `new_owner_id`.
    pub fn set_owner(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        let old_owner_id = std::mem::replace(&mut self.owner_id, new_owner_id);
        emit("owner_changed", json!({ "old_owner_id": old_owner_id, "new_owner_id": self.owner_id }));
    }

    // ---- attesters ----

    /// Attesters only. Stores an attestation about `code_hash` and returns its id.
    /// For `ChangeObserved`, `code_hash` must equal `new_hash`; for `KeyAdded` it is the
    /// account's code hash when the key was added.
    pub fn attest(&mut self, code_hash: String, attestation: Attestation) -> u64 {
        let attester = env::predecessor_account_id();
        require!(self.attesters.contains(&attester), "Only attesters can attest");
        require!(is_code_hash(&code_hash), "code_hash must be a base58 32-byte hash");
        validate(&code_hash, &attestation);

        self.last_id += 1;
        let id = self.last_id;
        push_id(&mut self.by_hash, &code_hash, id, |key| StorageKey::ByHashList { key });
        match &attestation {
            Attestation::ChangeObserved { account, .. } => {
                self.count_account(account);
                push_id(&mut self.history, account, id, |key| StorageKey::HistoryList { key });
                self.latest.insert(account.clone(), id);
            }
            Attestation::KeyAdded { account, .. } => {
                self.count_account(account);
                push_id(&mut self.key_events, account, id, |key| StorageKey::KeyEventsList { key });
            }
            _ => {}
        }
        let record = Record {
            id,
            code_hash,
            attestation,
            attester,
            block_height: env::block_height(),
            timestamp_ms: env::block_timestamp_ms(),
        };
        emit("attestation", event_data(&record));
        self.records.insert(id, record);
        id
    }

    // ---- views ----

    pub fn get_attestations(&self, code_hash: String, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record> {
        self.page(self.by_hash.get(&code_hash), from_index, limit)
    }

    /// `ChangeObserved` records for `account_id`, oldest first.
    pub fn get_history(&self, account_id: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record> {
        self.page(self.history.get(&account_id), from_index, limit)
    }

    /// `KeyAdded` records for `account_id`, oldest first.
    pub fn get_key_events(&self, account_id: AccountId, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record> {
        self.page(self.key_events.get(&account_id), from_index, limit)
    }

    /// The latest `ChangeObserved` record for `account_id`.
    pub fn get_latest(&self, account_id: AccountId) -> Option<Record> {
        self.latest.get(&account_id).and_then(|id| self.records.get(id)).cloned()
    }

    pub fn get_attestation(&self, id: u64) -> Option<Record> {
        self.records.get(&id).cloned()
    }

    pub fn get_attesters(&self) -> Vec<AccountId> {
        self.attesters.iter().cloned().collect()
    }

    pub fn is_attester(&self, account_id: AccountId) -> bool {
        self.attesters.contains(&account_id)
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_stats(&self) -> Stats {
        Stats { attestations: self.last_id, accounts: self.accounts }
    }
}

impl Registry {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can do this");
    }

    fn count_account(&mut self, account: &AccountId) {
        if !self.history.contains_key(account) && !self.key_events.contains_key(account) {
            self.accounts += 1;
        }
    }

    fn page(&self, ids: Option<&Vector<u64>>, from_index: Option<u32>, limit: Option<u32>) -> Vec<Record> {
        let Some(ids) = ids else { return vec![] };
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let end = from.saturating_add(limit).min(ids.len());
        (from..end)
            .filter_map(|i| ids.get(i))
            .filter_map(|id| self.records.get(id).cloned())
            .collect()
    }
}

/// Appends `id` to the list stored under `key`, creating the list if needed.
fn push_id<K>(map: &mut LookupMap<K, Vector<u64>>, key: &K, id: u64, prefix: impl FnOnce(CryptoHash) -> StorageKey)
where
    K: Ord + Clone + near_sdk::borsh::BorshSerialize + near_sdk::borsh::BorshDeserialize + AsRef<str>,
{
    if let Some(list) = map.get_mut(key) {
        list.push(id);
    } else {
        let mut list = Vector::new(prefix(env::sha256_array(key.as_ref().as_bytes())));
        list.push(id);
        map.insert(key.clone(), list);
    }
}

fn emit(event: &str, data: Value) {
    let log = json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// `{id, code_hash, kind, attester, timestamp_ms, ...payload}` for the attestation event.
/// `block_height`, where present, is the payload's (where the change was observed).
fn event_data(record: &Record) -> Value {
    let mut data = serde_json::to_value(&record.attestation).unwrap_or_else(|_| env::abort());
    if let Value::Object(map) = &mut data {
        map.insert("id".into(), json!(record.id));
        map.insert("code_hash".into(), json!(record.code_hash));
        map.insert("attester".into(), json!(record.attester));
        map.insert("timestamp_ms".into(), json!(record.timestamp_ms));
    }
    data
}

// ---- validation ----

/// True for a base58 string that decodes to exactly 32 bytes (43-44 characters for real
/// hashes, `1111…` (32 ones) for an account without code).
pub fn is_code_hash(s: &str) -> bool {
    if s.len() < 32 || s.len() > 44 {
        return false;
    }
    let mut buf = [0u8; 32];
    matches!(bs58::decode(s).onto(&mut buf), Ok(32))
}

/// True for 64 lowercase hex characters.
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn check_text(field: &str, value: &str, max: usize) {
    if value.is_empty() || value.len() > max {
        env::panic_str(&format!("{field} must be 1-{max} bytes"));
    }
}

fn validate(code_hash: &str, attestation: &Attestation) {
    match attestation {
        Attestation::ChangeObserved { old_hash, new_hash, .. } => {
            require!(is_code_hash(old_hash), "old_hash must be a base58 32-byte hash");
            require!(is_code_hash(new_hash), "new_hash must be a base58 32-byte hash");
            require!(old_hash != new_hash, "old_hash and new_hash are equal");
            require!(code_hash == new_hash, "code_hash must equal new_hash");
        }
        Attestation::ReproducibleBuild { repo, rev, image_digest, .. } => {
            check_text("repo", repo, MAX_SHORT_LEN);
            check_text("rev", rev, MAX_SHORT_LEN);
            check_text("image_digest", image_digest, MAX_SHORT_LEN);
        }
        Attestation::AiReview { model, request_sha256, response_sha256, signer, chat_id, verdict_summary } => {
            check_text("model", model, MAX_SHORT_LEN);
            require!(is_sha256_hex(request_sha256), "request_sha256 must be 64 lowercase hex characters");
            require!(is_sha256_hex(response_sha256), "response_sha256 must be 64 lowercase hex characters");
            check_text("signer", signer, MAX_SHORT_LEN);
            check_text("chat_id", chat_id, MAX_SHORT_LEN);
            check_text("verdict_summary", verdict_summary, MAX_SUMMARY_LEN);
        }
        Attestation::KeyAdded { public_key, .. } => {
            check_text("public_key", public_key, MAX_PUBLIC_KEY_LEN);
            require!(public_key.parse::<PublicKey>().is_ok(), "public_key must look like ed25519:<base58>");
        }
    }
}

#[cfg(test)]
mod tests;
