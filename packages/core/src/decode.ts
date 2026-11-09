// "Before you sign": decode a transaction (or a list of actions) the way wallet selectors and RPC
// produce them, explain each action in plain words, and list every account whose code the signer is
// about to trust (the receiver, plus e.g. the receiver of ft_transfer_call, which gets called too).
import { base64ToBytes } from "./hash.ts";

export interface DecodedAction {
  kind: string;
  text: string;
  risk: "high" | "medium" | "low";
  /** Accounts whose code runs because of this action. */
  trusts: string[];
  details?: Record<string, unknown>;
}
export interface DecodedTx {
  signer: string | null;
  receiver: string;
  actions: DecodedAction[];
  /** Every account to inspect before signing (deduplicated). */
  inspect: string[];
}

const YOCTO = 10n ** 24n;
export function formatNear(yocto: string | bigint | number | undefined): string {
  if (yocto === undefined || yocto === null) return "0 NEAR";
  const v = BigInt(String(yocto));
  const whole = v / YOCTO;
  if (v > 0n && v < 10n ** 18n) return `${v} yoctoNEAR`;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} NEAR`;
}

function parseArgs(raw: unknown): unknown {
  if (raw == null) return {};
  if (typeof raw === "object" && !(raw instanceof Uint8Array) && !Array.isArray(raw)) return raw;
  try {
    const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? Uint8Array.from(raw as number[]) : base64ToBytes(String(raw));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    try {
      return JSON.parse(String(raw));
    } catch {
      return { _raw: String(raw).slice(0, 200) };
    }
  }
}

/** Normalise the three common shapes: wallet-selector {type, params}, near-api-js {functionCall: …},
 *  and RPC/neardata ActionView {FunctionCall: {method_name, …}}. */
function normalise(a: any): { kind: string; p: any } {
  if (typeof a === "string") return { kind: a, p: {} };
  if (a?.type) return { kind: a.type, p: a.params ?? {} };
  const k = Object.keys(a ?? {})[0] ?? "Unknown";
  const kind = k.charAt(0).toUpperCase() + k.slice(1);
  return { kind, p: a[k] ?? {} };
}

function decodeAction(raw: any, receiver: string, signer: string | null): DecodedAction[] {
  const { kind, p } = normalise(raw);
  switch (kind) {
    case "FunctionCall": {
      const method = p.methodName ?? p.method_name;
      const args: any = parseArgs(p.args);
      const deposit = p.deposit ?? "0";
      const out: DecodedAction = { kind, text: `Call ${receiver}.${method}() with ${formatNear(deposit)} attached`, risk: "medium", trusts: [receiver], details: { method, args, deposit: String(deposit), gas: String(p.gas ?? "") } };
      if (/^(ft|nft|mt)_transfer_call$|^mt_batch_transfer_call$/.test(method) && args?.receiver_id) {
        let msg: unknown = args.msg;
        try {
          msg = typeof args.msg === "string" && args.msg.trim().startsWith("{") ? JSON.parse(args.msg) : args.msg;
        } catch {
          /* keep string */
        }
        out.text = `Send ${args.amount ?? args.amounts ?? args.token_id ?? "?"} of ${receiver} to ${args.receiver_id}, which then runs its own code on the transfer (msg: ${typeof msg === "string" ? JSON.stringify(msg).slice(0, 80) : JSON.stringify(msg).slice(0, 120)})`;
        out.trusts = [receiver, args.receiver_id];
        out.risk = "medium";
        out.details = { ...out.details, msg };
      } else if (/^(ft|nft)_transfer$/.test(method)) {
        out.text = `Transfer ${args.amount ?? args.token_id ?? "?"} of ${receiver} to ${args.receiver_id}`;
      } else if (/upgrade|deploy|migrate|set_code|add_full_access_key|stage_code/i.test(method)) {
        out.risk = "high";
        out.text += " — this method name suggests it changes code or keys";
      }
      return [out];
    }
    case "Transfer":
      return [{ kind, text: `Send ${formatNear(p.deposit)} to ${receiver}`, risk: "low", trusts: [], details: { deposit: String(p.deposit ?? "0") } }];
    case "DeployContract":
      return [{ kind, text: `Replace the code of ${receiver}${signer && signer !== receiver ? "" : " (your own account)"}`, risk: "high", trusts: [receiver] }];
    case "DeployGlobalContract":
    case "DeployGlobalContractByAccountId":
      return [{ kind, text: `Publish a global contract from ${receiver}${kind.endsWith("AccountId") ? " (accounts that reference it by account will switch to this code)" : ""}`, risk: "high", trusts: [receiver] }];
    case "UseGlobalContract":
    case "UseGlobalContractByAccountId": {
      const ref = p.account_id ?? p.accountId ?? p.code_hash ?? p.codeHash;
      return [{ kind, text: `Switch ${receiver} to the global contract ${ref}${p.account_id || p.accountId ? " (its publisher can change this code later)" : ""}`, risk: "high", trusts: [String(ref)] }];
    }
    case "AddKey": {
      const ak = p.accessKey ?? p.access_key ?? {};
      const perm = ak.permission;
      const full = perm === "FullAccess" || perm?.fullAccess !== undefined || perm === "fullAccess";
      if (full) return [{ kind, text: `Add a FULL-ACCESS key ${p.publicKey ?? p.public_key} to ${receiver}: whoever holds it controls the account, its funds and its code`, risk: "high", trusts: [] }];
      const fc = perm?.FunctionCall ?? perm?.functionCall ?? perm ?? {};
      return [{ kind, text: `Add a function-call key ${p.publicKey ?? p.public_key} limited to ${fc.receiver_id ?? fc.receiverId ?? "?"} (${(fc.method_names ?? fc.methodNames ?? []).join(", ") || "any method"}), allowance ${fc.allowance ? formatNear(fc.allowance) : "unlimited"}`, risk: "medium", trusts: [] }];
    }
    case "DeleteKey":
      return [{ kind, text: `Delete key ${p.publicKey ?? p.public_key} from ${receiver}`, risk: "medium", trusts: [] }];
    case "DeleteAccount":
      return [{ kind, text: `Delete ${receiver} and send its balance to ${p.beneficiaryId ?? p.beneficiary_id}`, risk: "high", trusts: [] }];
    case "CreateAccount":
      return [{ kind, text: `Create account ${receiver}`, risk: "low", trusts: [] }];
    case "Stake":
      return [{ kind, text: `Stake ${formatNear(p.stake)} from ${receiver}`, risk: "medium", trusts: [] }];
    case "Delegate":
    case "SignedDelegate":
    case "DelegateV2": {
      const d = p.delegate_action ?? p.delegateAction ?? p;
      const inner = (d.actions ?? []).flatMap((x: any) => decodeAction(x.NonDelegateAction ?? x, d.receiver_id ?? d.receiverId, d.sender_id ?? d.senderId));
      return [{ kind: "Delegate", text: `Meta-transaction: ${d.sender_id ?? d.senderId} → ${d.receiver_id ?? d.receiverId} (a relayer pays gas)`, risk: "medium", trusts: [] }, ...inner];
    }
    default:
      return [{ kind, text: `Unrecognised action ${kind}`, risk: "high", trusts: [receiver] }];
  }
}

/** Accepts a transaction, an array of transactions, or {receiverId, actions}. */
export function decodeTransactions(input: unknown): DecodedTx[] {
  const list = Array.isArray(input) ? input : (input as any)?.transactions ?? [input];
  return list.map((t: any) => {
    const tx = t.transaction ?? t;
    const receiver = tx.receiverId ?? tx.receiver_id;
    const signer = tx.signerId ?? tx.signer_id ?? null;
    if (!receiver) throw new Error("transaction has no receiverId / receiver_id");
    const actions = (tx.actions ?? []).flatMap((a: any) => decodeAction(a, receiver, signer));
    const inspect = [...new Set(actions.flatMap((a: DecodedAction) => a.trusts).filter((x: string) => /^[a-z0-9._-]{2,64}$/.test(x)))];
    return { signer, receiver, actions, inspect };
  });
}
