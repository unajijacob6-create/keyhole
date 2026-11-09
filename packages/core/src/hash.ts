// sha256 and NEAR's base58 code hash, with WebCrypto (works in Node 22 and browsers).
import bs58 from "bs58";

export const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return [...(await sha256(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** NEAR code hash: base58(sha256(wasm)). */
export async function codeHash(wasm: Uint8Array): Promise<string> {
  return bs58.encode(await sha256(wasm));
}
export const base58 = bs58;

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(b64, "base64"));
}
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
