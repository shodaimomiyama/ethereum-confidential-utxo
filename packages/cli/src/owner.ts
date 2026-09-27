import { mkdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "viem";
import type { Address, Hex } from "viem";
import { authorizeOperation, fixOperation, proveFixedOperation, recipientInfoTypedData, selectInputs, synchronize, toPublicSubmission } from "@confidential-utxo/core";
import type { BuildIntent, Context, HistoryPort, ReceiptKeyPort, SyncResult } from "@confidential-utxo/core";
import { createEthereumRpc, createHistoryPort, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import { replacePrivateFile, withWriterLock } from "./atomic-file.js";
import { openEnvelope, sealEnvelope } from "./envelope.js";
import { encodePublicSubmission, encodeRecipientInfo } from "./public-files.js";
import { generateReceiptKey, readLocalSigner } from "./secret-input.js";
import { privateBalance } from "./render.js";
import type { CliResult } from "./render.js";
import { hexBytes, parseExactObject } from "./strict-json.js";
import { decodeOwnerSnapshot, encodeOwnerSnapshot, initializeOwnerState, readOwnerState,
  replaceOwnerPassphrase, updateOwnerState } from "./state.js";
import type { WalletStateV1 } from "./state.js";

export type OwnerConfig = { dir: string; manifestPath: string; rpcUrl: string; owner: Address };
export type OwnerOnline = { context: Context; history: HistoryPort };
export type OwnerOnlineFactory = () => Promise<OwnerOnline>;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
function invalid(): never { throw new Error("OWNER_OPERATION_INVALID"); }
function stable(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
}
function sameContext(left: Context, right: Context): boolean {
  return left.chainId === right.chainId && same(left.pool, right.pool) &&
    left.deploymentBlock === right.deploymentBlock && same(left.verifier, right.verifier) &&
    same(left.parametersHash, right.parametersHash) && left.finalityMode === right.finalityMode;
}

export class OwnerService {
  constructor(readonly config: OwnerConfig, private readonly factory?: OwnerOnlineFactory) {}

  private async online(): Promise<OwnerOnline> {
    if (this.factory) return this.factory();
    const file = await stat(this.config.manifestPath);
    if (!file.isFile() || file.size > 1024 * 1024) invalid();
    const manifestBytes = await readFile(this.config.manifestPath);
    const manifest = parseExactObject(manifestBytes, ["schemaVersion", "chainId", "hardfork", "signer", "tool", "artifacts", "parametersHash", "pool", "verifier"]) as { chainId: number };
    const mode = manifest.chainId === 31337 ? "local-simulated" : "finalized";
    const rpc = createEthereumRpc({ url: this.config.rpcUrl, mode });
    const verified = await verifyEthereumDeployment(rpc.client, manifest, mode);
    return { context: verified.context, history: createHistoryPort(verified, rpc.client, rpc.policy) };
  }
  private async state(passphrase: Uint8Array): Promise<WalletStateV1> {
    return readOwnerState(this.config.dir, passphrase, undefined, this.config.owner);
  }
  private async verified(passphrase: Uint8Array): Promise<{ state: WalletStateV1; online: OwnerOnline }> {
    const [state, online] = await Promise.all([this.state(passphrase), this.online()]);
    if (!sameContext(state.context, online.context)) invalid();
    return { state, online };
  }

  async init(passphrase: Uint8Array): Promise<CliResult> {
    const online = await this.online();
    hexBytes(this.config.owner, 20);
    const state: WalletStateV1 = { schemaVersion: 1, context: online.context, owner: this.config.owner,
      receiptKeys: [], activeReceiptKeyId: null, operations: {}, sync: null, restoration: "ready" };
    await initializeOwnerState(this.config.dir, passphrase, state);
    return { kind: "init", owner: this.config.owner, chainId: online.context.chainId, pool: online.context.pool };
  }

  async addReceiptKey(passphrase: Uint8Array): Promise<CliResult> {
    const key = generateReceiptKey();
    try {
      const publicKey = bytesToHex(key.publicKey);
      const id = bytesToHex(key.publicKey); // Public key bytes give a stable local identifier.
      await updateOwnerState(this.config.dir, passphrase, current => ({ ...current,
        receiptKeys: [...current.receiptKeys, { id, secretKey: bytesToHex(key.secretKey), publicKey }],
        activeReceiptKeyId: id }), this.config.owner);
      return { kind: "key", keyId: id, action: "added" };
    } finally { key.secretKey.fill(0); }
  }
  async selectReceiptKey(keyId: Hex, passphrase: Uint8Array): Promise<CliResult> {
    await updateOwnerState(this.config.dir, passphrase, current => {
      const found = current.receiptKeys.find(key => same(key.id, keyId));
      if (!found) invalid();
      return { ...current, activeReceiptKeyId: found.id };
    }, this.config.owner);
    return { kind: "key", keyId, action: "selected" };
  }
  async recipientInfo(passphrase: Uint8Array, signerFile: string): Promise<Uint8Array> {
    const state = await this.state(passphrase);
    const selected = state.receiptKeys.find(key => state.activeReceiptKeyId && same(key.id, state.activeReceiptKeyId));
    if (!selected) invalid();
    const signer = await readLocalSigner(signerFile, state.owner);
    const unsigned = { chainId: state.context.chainId, pool: state.context.pool, owner: state.owner,
      receivePublicKey: selected.publicKey, receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
    const signature = await signer.signTypedData(recipientInfoTypedData(state.context, unsigned, state.owner));
    return encodeRecipientInfo({ ...unsigned, signature });
  }

  async sync(passphrase: Uint8Array): Promise<CliResult> {
    const { state, online } = await this.verified(passphrase);
    const keys = state.receiptKeys.map(key => hexToBytes(key.secretKey));
    const port: ReceiptKeyPort = { getKey: async () => {
      if (!keys[0]) invalid();
      return keys[0];
    }, getKeys: async () => keys };
    let result: SyncResult;
    try { result = await synchronize(state.context, { history: online.history, keys: port, owners: [state.owner] }, state.sync ?? undefined); }
    finally { keys.forEach(key => key.fill(0)); }
    const updated = await updateOwnerState(this.config.dir, passphrase, current => {
      if (!sameContext(current.context, state.context) ||
          stable(current.receiptKeys) !== stable(state.receiptKeys)) invalid();
      const restoration = result.status === "complete" ? "ready" : current.restoration;
      return { ...current, sync: result, restoration };
    }, this.config.owner);
    return { kind: "sync", status: updated.sync?.status === "complete" ? "complete" : "unconfirmed",
      ...(updated.sync?.checkpoint ? { checkpoint: updated.sync.checkpoint } : {}),
      ...(updated.sync?.status === "complete" ? { receiptFailures: updated.sync.receiptFailures } : {}) };
  }
  async balance(passphrase: Uint8Array): Promise<CliResult> {
    const state = await this.state(passphrase);
    if (state.restoration === "needs-resync") return { kind: "balance", status: "stale" };
    if (state.sync?.status === "complete") return { kind: "balance", status: "available",
      amount: privateBalance(state.sync.availableWei), checkpoint: state.sync.checkpoint,
      receiptFailures: state.sync.receiptFailures };
    return { kind: "balance", status: state.sync?.previous ? "stale" : "unknown",
      ...(state.sync?.checkpoint ? { checkpoint: state.sync.checkpoint } : {}) };
  }

  async create(intent: BuildIntent, passphrase: Uint8Array): Promise<CliResult> {
    await this.sync(passphrase);
    const state = await this.state(passphrase);
    if (state.restoration !== "ready" || state.sync?.status !== "complete" || !same(intent.owner, state.owner)) invalid();
    const reserved = new Set(Object.values(state.operations).flatMap(record =>
      record.fixed.request.inputIds.map(id => id.toLowerCase())));
    const inputs = state.sync.utxos.filter(input => !reserved.has(input.id.toLowerCase()));
    const fixed = await fixOperation(intent, state.context, { inputs, randomSalt: () => randomBytes(32) });
    await updateOwnerState(this.config.dir, passphrase, current => {
      if (current.restoration !== "ready" || current.sync?.status !== "complete" ||
          stable(current.sync) !== stable(state.sync) ||
          current.operations[fixed.operationId]) invalid();
      const alreadyReserved = Object.values(current.operations).some(record =>
        record.fixed.request.inputIds.some(id => fixed.request.inputIds.some(next => same(id, next))));
      if (alreadyReserved) invalid();
      if (fixed.request.inputIds.length > 0) {
        if (intent.kind === 0) invalid();
        const selected = selectInputs(current.context, current.sync.utxos.filter(input =>
          !Object.values(current.operations).some(record => record.fixed.request.inputIds.some(id => same(id, input.id)))), {
          kind: intent.kind, owner: intent.owner, amount: intent.amount,
          ...("explicitIds" in intent && intent.explicitIds ? { explicitIds: intent.explicitIds } : {}),
        });
        if (stable(selected.map(input => input.id)) !== stable(fixed.request.inputIds)) invalid();
      }
      return { ...current, operations: { ...current.operations,
        [fixed.operationId]: { phase: "fixed", fixed } } };
    }, this.config.owner);
    return { kind: "created", operationId: fixed.operationId, phase: "fixed" };
  }
  async prove(id: Hex, passphrase: Uint8Array): Promise<CliResult> {
    const state = await this.state(passphrase);
    const record = state.operations[id];
    if (!record) invalid();
    const draft = proveFixedOperation(record.fixed);
    await updateOwnerState(this.config.dir, passphrase, current => {
      const latest = current.operations[id];
      if (!latest || stable(latest) !== stable(record)) invalid();
      const next = latest.phase === "authorized" ? { ...latest,
        balanceProof: draft.balanceProof, rangeProofs: draft.rangeProofs } :
        { phase: "proved" as const, fixed: latest.fixed,
          balanceProof: draft.balanceProof, rangeProofs: draft.rangeProofs };
      return { ...current, operations: { ...current.operations,
        [id]: next } };
    }, this.config.owner);
    return { kind: "created", operationId: id, phase: record.phase === "authorized" ? "authorized" : "proved" };
  }
  async abandon(id: Hex, passphrase: Uint8Array): Promise<CliResult> {
    await updateOwnerState(this.config.dir, passphrase, current => {
      const record = current.operations[id];
      if (!record || record.phase === "authorized") invalid();
      const operations = { ...current.operations };
      delete operations[id];
      return { ...current, operations };
    }, this.config.owner);
    return { kind: "abandoned", operationId: id };
  }
  async authorize(id: Hex, passphrase: Uint8Array, signerFile: string): Promise<CliResult> {
    const state = await this.state(passphrase);
    const record = state.operations[id];
    if (!record || record.phase !== "proved" || !same(record.fixed.request.owner, state.owner)) invalid();
    const signer = await readLocalSigner(signerFile, state.owner);
    const signature = await authorizeOperation(state.context, record.fixed.request, signer);
    await updateOwnerState(this.config.dir, passphrase, current => {
      const latest = current.operations[id];
      if (!latest || latest.phase !== "proved" || stable(latest) !== stable(record)) invalid();
      return { ...current, operations: { ...current.operations,
        [id]: { ...latest, phase: "authorized", signature } } };
    }, this.config.owner);
    return { kind: "created", operationId: id, phase: "authorized" };
  }
  async exportPublic(id: Hex, passphrase: Uint8Array, path: string): Promise<Uint8Array> {
    const state = await this.state(passphrase);
    if (state.restoration !== "ready" || state.sync?.status !== "complete") invalid();
    const record = state.operations[id];
    if (!record || record.phase !== "authorized") invalid();
    const submission = toPublicSubmission({ ...record.fixed, balanceProof: record.balanceProof,
      rangeProofs: record.rangeProofs, signature: record.signature });
    const bytes = encodePublicSubmission(state.context, submission);
    await replacePrivateFile(path, bytes);
    return bytes;
  }
  async backup(destination: string, passphrase: Uint8Array, backupPassphrase: Uint8Array): Promise<CliResult> {
    await withWriterLock(this.config.dir, async () => {
      const state = await this.state(passphrase);
      const plaintext = encodeOwnerSnapshot({ ...state, backupCreatedAt: new Date().toISOString() });
      try { await replacePrivateFile(destination, await sealEnvelope(plaintext, backupPassphrase)); }
      finally { plaintext.fill(0); }
    });
    return { kind: "backup", status: "created", path: destination };
  }
  async restore(backupBytes: Uint8Array, newDirectory: string, passphrase: Uint8Array): Promise<CliResult> {
    const plaintext = await openEnvelope(backupBytes, passphrase);
    let state: WalletStateV1;
    try { state = decodeOwnerSnapshot(plaintext); }
    finally { plaintext.fill(0); }
    if (!same(state.owner, this.config.owner)) invalid();
    await mkdir(newDirectory, { mode: 0o700 });
    await initializeOwnerState(newDirectory, passphrase, { ...state, restoration: "needs-resync" });
    return { kind: "restored", status: "needs-resync", owner: state.owner };
  }
  async changePassphrase(oldPassphrase: Uint8Array, newPassphrase: Uint8Array): Promise<CliResult> {
    await replaceOwnerPassphrase(this.config.dir, oldPassphrase, newPassphrase, this.config.owner);
    return { kind: "passphrase", status: "changed" };
  }
  async inspect(id: Hex, passphrase: Uint8Array): Promise<CliResult> {
    const state = await this.state(passphrase);
    const record = state.operations[id];
    if (!record) invalid();
    return { kind: "operation", operationId: id,
      status: state.restoration === "needs-resync" ? "stale" : record.phase,
      ...(state.sync?.checkpoint ? { checkpoint: state.sync.checkpoint } : {}) };
  }
}
