import { generateKeyPairSync } from "node:crypto";
import { stdin, stderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { readPrivateFile } from "./atomic-file.js";
import { hexBytes } from "./strict-json.js";

function invalid(): never { throw new Error("SECRET_INPUT_INVALID"); }

export async function readLocalSigner(path: string, expectedAddress: Address): Promise<LocalAccount> {
  hexBytes(expectedAddress, 20);
  const bytes = await readPrivateFile(path, 67);
  try {
    let source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.endsWith("\n")) source = source.slice(0, -1);
    const privateKey = hexBytes(source, 32);
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) invalid();
    return account;
  } finally { bytes.fill(0); }
}

export function generateReceiptKey(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const pair = generateKeyPairSync("x25519");
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  if (typeof privateJwk.d !== "string" || typeof publicJwk.x !== "string") invalid();
  const secretKey = new Uint8Array(Buffer.from(privateJwk.d, "base64url"));
  const publicKey = new Uint8Array(Buffer.from(publicJwk.x, "base64url"));
  if (secretKey.length !== 32 || publicKey.length !== 32 || publicKey.every(byte => byte === 0)) invalid();
  return { secretKey, publicKey };
}

export type SecretInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => void };
export type SecretOutput = Writable & { isTTY?: boolean };
async function hiddenLine(label: string, input: SecretInput, output: SecretOutput): Promise<Uint8Array> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") invalid();
  const chunks: number[] = [];
  const oldRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const cleanup = () => { input.off("data", onData); input.off("end", onEnd); input.off("error", onError); };
      const onEnd = () => { cleanup(); reject(new Error("SECRET_INPUT_INVALID")); };
      const onError = () => { cleanup(); reject(new Error("SECRET_INPUT_INVALID")); };
      const onData = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3) { cleanup(); reject(new Error("SECRET_INPUT_INVALID")); return; }
          if (byte === 10 || byte === 13) {
            cleanup(); output.write("\n");
            if (chunks.length === 0) reject(new Error("SECRET_INPUT_INVALID"));
            else resolve(Uint8Array.from(chunks));
            return;
          }
          if (byte === 8 || byte === 127) { chunks.pop(); continue; }
          if (chunks.length >= 4096) { cleanup(); reject(new Error("SECRET_INPUT_INVALID")); return; }
          chunks.push(byte);
        }
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      output.write(label);
    });
  } finally {
    input.setRawMode(Boolean(oldRaw));
    input.pause();
  }
}

export async function promptPassphrase(mode: "unlock" | "new" | "change",
  input: SecretInput = stdin, output: SecretOutput = stderr): Promise<Uint8Array> {
  if (mode === "unlock") return hiddenLine("Passphrase: ", input, output);
  const first = await hiddenLine(mode === "new" ? "New passphrase: " : "Replacement passphrase: ", input, output);
  try {
    const second = await hiddenLine("Confirm passphrase: ", input, output);
    try {
      if (!Buffer.from(first).equals(Buffer.from(second))) invalid();
      return new Uint8Array(first);
    } finally { second.fill(0); }
  } finally { first.fill(0); }
}
