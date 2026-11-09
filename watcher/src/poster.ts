// Posts attestations to the Keyhole registry on testnet, signed by the attester account.
import { KEYHOLE_REGISTRY } from "../../packages/core/src/index.ts";
import type { Poster } from "./follow.ts";

export async function registryPoster(opts: { attester?: string; registry?: string } = {}): Promise<Poster> {
  const { account, cfg, TGAS } = await import("../../scripts/lib/near.ts");
  const attester = opts.attester ?? cfg.attester;
  const registry = opts.registry ?? process.env.KH_REGISTRY ?? KEYHOLE_REGISTRY.account;
  const acct = account(attester);
  const send = async (code_hash: string, attestation: Record<string, unknown>) => {
    const res: any = await acct.callFunctionRaw({ contractId: registry, methodName: "attest", args: { code_hash, attestation }, gas: TGAS(30) });
    const ok = res?.status?.SuccessValue;
    if (ok === undefined) throw new Error(`attest failed: ${JSON.stringify(res?.status).slice(0, 200)}`);
    return { id: Number(JSON.parse(Buffer.from(ok, "base64").toString() || "0")), tx: res.transaction.hash as string };
  };
  return {
    attest: send,
    changeObserved: (e) => send(e.new_hash, { kind: "ChangeObserved", ...e }),
    keyAdded: ({ code_hash, ...e }) => send(code_hash, { kind: "KeyAdded", ...e }),
  };
}
