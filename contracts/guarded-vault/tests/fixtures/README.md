# Sandbox test fixtures

## `sputnikdao2_testnet.wasm`

The Sputnik v2 DAO contract (third-party, [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract)),
used by `../upgrade.rs` (`real_sputnik_dao_upgrade_remote_deploys_evil_sweep`) so the sandbox upgrade
runs through Sputnik's own `store_blob` / `add_proposal` / `act_proposal` / `UpgradeRemote` code
instead of a stand-in owner account.

Provenance (fetched 2026-11-09, read-only testnet RPC):

- downloaded with `query` / `view_code` for `kh-guardian.sputnikv2.testnet` at block 276978185;
- 539,647 bytes; code hash (base58 sha256) `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, equal to the
  `hash` that `view_code` returned and to the account's `code_hash` from `view_account`;
- `sputnikv2.testnet` `get_default_code_hash` returned the same hash, so this is the code the testnet
  factory deploys for new DAOs.

Re-check:

```sh
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"sputnikv2.testnet","method_name":"get_default_code_hash","args_base64":"e30="}}'
# result bytes decode to "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH" while the factory default is unchanged
sha256sum sputnikdao2_testnet.wasm
# 880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da (the same 32 bytes, in hex)
```
