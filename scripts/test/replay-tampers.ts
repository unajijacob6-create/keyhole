// Altered copies of the real Guardian recording (data/guardian-run.json). Each must FAIL the replay,
// and `expect` names the check that has to report it. Shared by scripts/test/replay.test.ts and the
// fixture recorder (scripts/test/record-replay-fixture.ts), which records the RPC answers they need.
import { base64ToBytes, bytesToBase64, requestKey } from "../../packages/core/src/index.ts";

export interface Tamper {
  name: string;
  /** Text of the XX line(s) that must appear. */
  expect: RegExp[];
  apply: (run: any) => void;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export const TAMPERS: Tamper[] = [
  {
    name: "vote_2 relabelled: the sweep tx (later, successful) passed off as the deciding vote",
    expect: [/^deciding vote .* no call from .* that deploys code/, /^vote_2: .*receiver .* != kh-guardian/],
    apply: (r) => {
      r.tx.vote_2 = r.tx.sweep;
      r.signers.vote_2 = r.signers.sweep;
      r.heights.vote_2 = r.heights.sweep;
    },
  },
  {
    name: "vote_2 relabelled: the first vote (another tx of the DAO) passed off as the deciding vote",
    expect: [/^deciding vote .* no call from .* that deploys code/, /^vote_2: .*recorded signer council-a\.keyhole\.testnet is not the vote_2 account/],
    apply: (r) => {
      r.tx.vote_2 = r.tx.vote_1;
      r.signers.vote_2 = r.signers.vote_1;
      r.heights.vote_2 = r.heights.vote_1;
    },
  },
  {
    name: "vote_2 relabelled: add_proposal (another DAO tx) as the deciding vote",
    expect: [/^deciding vote .* no call from .* that deploys code/, /^vote_2: .*method add_proposal/],
    apply: (r) => {
      r.tx.vote_2 = r.tx.add_proposal;
      r.signers.vote_2 = r.signers.add_proposal;
      r.heights.vote_2 = r.heights.add_proposal;
    },
  },
  {
    name: "one byte of the hatch signature flipped",
    expect: [/^hatch signature valid: .*signature does not verify/, /^guardian tx .* byte for byte \(DIFFERENT/],
    apply: (r) => {
      const b = base64ToBytes(r.hatch.signed_delegate);
      b[b.length - 1] ^= 0x01;
      r.hatch.signed_delegate = bytesToBase64(b);
    },
  },
  {
    name: "hatch_fired signer claimed to be Alice (not relayed by the guardian)",
    expect: [/^hatch_fired: .*chain signer guardian\.keyhole\.testnet != recorded alice\.keyhole\.testnet/],
    apply: (r) => {
      r.signers.hatch_fired = r.accounts.alice;
    },
  },
  {
    name: "guardian role claimed by another account",
    expect: [/^hatch_fired: .*recorded signer guardian\.keyhole\.testnet is not the hatch_fired account bob\.keyhole\.testnet/],
    apply: (r) => {
      r.accounts.guardian = r.accounts.bob;
    },
  },
  {
    name: "recorded height of the deciding vote moved before the hatch",
    expect: [/^vote_2: .*recorded height 276976490 != chain 276976524/],
    apply: (r) => {
      r.heights.vote_2 = 276976490;
    },
  },
  {
    name: "every recorded height set to 1",
    expect: [/^deploy_vault: .*recorded height 1 != chain/, /^sweep: .*recorded height 1 != chain/],
    apply: (r) => {
      for (const k of Object.keys(r.heights)) r.heights[k] = 1;
    },
  },
  {
    name: "step dropped: vote_1",
    expect: [/^recording has every required step .*MISSING vote_1/, /^vote_1: MISSING from the recording/],
    apply: (r) => {
      delete r.tx.vote_1;
    },
  },
  {
    name: "steps dropped: hatch and the diff baseline (deploy_vault, init_vault, delete_vault_key)",
    expect: [/^recording has every required step .*MISSING deploy_vault, init_vault, delete_vault_key.*MISSING hatch/, /^hatch:signature: could not be checked/],
    apply: (r) => {
      r.hatch = null;
      for (const k of ["deploy_vault", "init_vault", "delete_vault_key"]) delete r.tx[k];
    },
  },
  {
    name: "a different DAO named",
    expect: [/^init_vault: .*not new\(\{owner_id: some-other-dao\.testnet\}\)/, /^vault owner just before the upgrade: kh-guardian\.sputnikv2\.testnet \(recorded DAO some-other-dao\.testnet\)/],
    apply: (r) => {
      r.dao = "some-other-dao.testnet";
    },
  },
  {
    name: "Alice's deposit replaced by Bob's deposit tx",
    expect: [/^alice_deposit: .*chain signer bob\.keyhole\.testnet != recorded alice\.keyhole\.testnet/],
    apply: (r) => {
      r.tx.alice_deposit = r.tx.bob_deposit;
    },
  },
  {
    name: "proposal id changed",
    expect: [/^add_proposal returned proposal id 2 \(recorded 3\)/],
    apply: (r) => {
      r.proposal_id = 3;
    },
  },
  {
    name: "honest code hash changed",
    expect: [/^deploy_vault deployed 4sU3.* \(recorded honest 11111111111111111111111111111111\)/, /^deciding vote .*vault code 4sU3/],
    apply: (r) => {
      r.code.honest = "11111111111111111111111111111111";
    },
  },
  {
    name: "recorded outcome says Alice still had funds in the vault after the hatch",
    expect: [/^recorded balances, outcome and alerts match the chain.* · balances\.alice_in_vault_after_fire 1 != 0/],
    apply: (r) => {
      r.balances.alice_in_vault_after_fire = "1";
    },
  },
];

/** Tx-status answers are keyed by hash alone, so a recording that names the wrong sender still finds
 *  the chain's answer (archival RPC ignores a wrong sender hint the same way). */
export function fixtureKey(body: string): string {
  const { method, params } = JSON.parse(body);
  if (method === "EXPERIMENTAL_tx_status") return requestKey(method, { tx_hash: params.tx_hash });
  return requestKey(method, params);
}
