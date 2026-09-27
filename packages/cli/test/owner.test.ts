import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildOperation, operationId, outputId } from "@confidential-utxo/core";
import type { Checkpoint, Context, HistoryPort, Observation, ObservedOperation, OperationRequest } from "@confidential-utxo/core";
import { hexToBytes, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPrivateDirectory, replacePrivateFile } from "../src/atomic-file.js";
import { readOwnerState } from "../src/state.js";
import { decodeRecipientInfo, decodePublicSubmission } from "../src/public-files.js";
import { OwnerService } from "../src/owner.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const privateKey = `0x${"01".repeat(32)}` as Hex;
const account = privateKeyToAccount(privateKey);
const context: Context = { chainId: 31337n, pool: "0x2222222222222222222222222222222222222222",
  deploymentBlock: 1n, verifier: "0x3333333333333333333333333333333333333333",
  parametersHash: hash("44"), finalityMode: "local-simulated" };
const checkpoint: Checkpoint = { number: 20n, hash: hash("20"), mode: "local-simulated" };
const oldPass = new TextEncoder().encode(" old pass ");
const newPass = new TextEncoder().encode("new pass");
const changedPass = new TextEncoder().encode("changed pass");

it("retains old receipt keys, fixes before proof, and restores as needs-resync", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-owner-")); roots.push(root);
  const ownerDir = join(root, "owner");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const signerDir = join(root, "signer");
  await createPrivateDirectory(signerDir);
  const signerFile = join(signerDir, "owner.key");
  await replacePrivateFile(signerFile, new TextEncoder().encode(privateKey));
  await createPrivateDirectory(backupDir);
  const operations: ObservedOperation[] = [];
  const complete = <T>(value: T): Observation<T> => ({ complete: true, blockHash: checkpoint.hash, value });
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => checkpoint,
    getContext: async () => complete(context),
    getCanonicalHeader: async number => complete({ number, hash: number === checkpoint.number ? checkpoint.hash : hash(number.toString(16).padStart(2, "0")) }),
    getOperations: async () => complete(operations),
    getUtxo: async id => {
      const output = operations.flatMap(op => op.outputLogs).find(item => item.outputId === id)?.output;
      return complete(output ? { exists: true, owner: output.owner, commitment: output.commitment } : { exists: false });
    },
    getOperationSuccess: async id => complete({ executed: operations.some(op => op.success?.operationId === id) }),
    getLatestHeader: async () => null,
    getLatestUtxo: async () => ({ complete: false, reason: "RPC" }),
    getLatestOperationSuccess: async () => ({ complete: false, reason: "RPC" }),
  };
  let online = true;
  const service = new OwnerService({ dir: ownerDir, manifestPath: "unused", rpcUrl: "unused", owner: account.address },
    async () => { if (!online) throw new Error("RPC unavailable"); return { context, history }; });
  await service.init(oldPass);
  const wrongOwner = new OwnerService({ dir: ownerDir, manifestPath: "unused", rpcUrl: "unused",
    owner: "0x4444444444444444444444444444444444444444" }, async () => ({ context, history }));
  await expect(wrongOwner.addReceiptKey(oldPass)).rejects.toThrow();
  await expect(wrongOwner.changePassphrase(oldPass, changedPass)).rejects.toThrow();
  await service.addReceiptKey(oldPass);
  const k1Info = await decodeRecipientInfo(await service.recipientInfo(oldPass, signerFile), context, account.address);
  const deposit = await buildOperation({ kind: 0, owner: account.address, amount: 7n, recipient: k1Info }, context,
    { inputs: [], randomSalt: () => new Uint8Array(32).fill(7) });
  const id = operationId(context, deposit.request);
  const location = { blockNumber: 10n, blockHash: hash("0a"), transactionHash: hash("0b"), transactionIndex: 0 };
  operations.push({ request: deposit.request, success: { ...location, operationId: id, logIndex: 1 },
    inputLogs: [], outputLogs: [{ ...location, operationId: id, outputId: outputId(id, 0), outputIndex: 0,
      output: deposit.request.outputs[0]!, logIndex: 0 }] });
  await service.addReceiptKey(oldPass);
  const keys = (await readOwnerState(ownerDir, oldPass)).receiptKeys;
  expect(keys).toHaveLength(2);
  await expect(wrongOwner.selectReceiptKey(keys[1]!.id, oldPass)).rejects.toThrow();
  await service.selectReceiptKey(keys[1]!.id, oldPass);
  const k2Info = await decodeRecipientInfo(await service.recipientInfo(oldPass, signerFile), context, account.address);
  const secondDeposit = await buildOperation({ kind: 0, owner: account.address, amount: 5n, recipient: k2Info }, context,
    { inputs: [], randomSalt: () => new Uint8Array(32).fill(8) });
  const secondId = operationId(context, secondDeposit.request);
  const secondLocation = { blockNumber: 11n, blockHash: hash("0b"), transactionHash: hash("0c"), transactionIndex: 0 };
  operations.push({ request: secondDeposit.request, success: { ...secondLocation, operationId: secondId, logIndex: 1 },
    inputLogs: [], outputLogs: [{ ...secondLocation, operationId: secondId, outputId: outputId(secondId, 0),
      outputIndex: 0, output: secondDeposit.request.outputs[0]!, logIndex: 0 }] });
  await service.sync(oldPass);
  const before = await readOwnerState(ownerDir, oldPass);
  expect(before.sync?.status).toBe("complete");
  if (before.sync?.status === "complete") expect(before.sync.availableWei).toBe(12n);
  const created = await service.create({ kind: 1, owner: account.address, amount: 3n,
    recipient: k2Info, changeRecipient: k2Info }, oldPass);
  expect(created.kind).toBe("created");
  if (created.kind !== "created") throw new Error("operation not created");
  const fixed = (await readOwnerState(ownerDir, oldPass)).operations[created.operationId];
  expect(fixed?.phase).toBe("fixed");
  expect(fixed).not.toHaveProperty("balanceProof");
  const other = await service.create({ kind: 1, owner: account.address, amount: 3n,
    recipient: k2Info, changeRecipient: k2Info }, oldPass);
  expect(other.kind).toBe("created");
  if (other.kind !== "created") throw new Error("second operation not created");
  const otherFixed = (await readOwnerState(ownerDir, oldPass)).operations[other.operationId];
  expect(otherFixed?.fixed.request.inputIds).not.toEqual(fixed?.fixed.request.inputIds);
  expect(await service.abandon(other.operationId, oldPass)).toMatchObject({ kind: "abandoned", operationId: other.operationId });
  expect((await readOwnerState(ownerDir, oldPass)).operations[other.operationId]).toBeUndefined();
  const reused = await service.create({ kind: 1, owner: account.address, amount: 3n,
    recipient: k2Info, changeRecipient: k2Info }, oldPass);
  expect(reused.kind).toBe("created");
  if (reused.kind === "created")
    expect((await readOwnerState(ownerDir, oldPass)).operations[reused.operationId]?.fixed.request.inputIds).toEqual(otherFixed?.fixed.request.inputIds);
  await service.prove(created.operationId, oldPass);
  await service.authorize(created.operationId, oldPass, signerFile);
  await expect(service.abandon(created.operationId, oldPass)).rejects.toThrow();
  const firstAuthorized = (await readOwnerState(ownerDir, oldPass)).operations[created.operationId];
  await service.prove(created.operationId, oldPass);
  const regenerated = (await readOwnerState(ownerDir, oldPass)).operations[created.operationId];
  expect(regenerated?.phase).toBe("authorized");
  expect(regenerated && "signature" in regenerated ? regenerated.signature : undefined).toBe(
    firstAuthorized && "signature" in firstAuthorized ? firstAuthorized.signature : undefined);
  expect(regenerated && "balanceProof" in regenerated ? regenerated.balanceProof : undefined).not.toEqual(
    firstAuthorized && "balanceProof" in firstAuthorized ? firstAuthorized.balanceProof : undefined);
  const exportPath = join(ownerDir, "submission.json");
  const publicBytes = await service.exportPublic(created.operationId, oldPass, exportPath);
  expect((await decodePublicSubmission(publicBytes, context)).request.outputs).toHaveLength(2);
  const backupPath = join(backupDir, "owner.backup");
  await service.backup(backupPath, oldPass, newPass);
  const backupBytes = await (await import("node:fs/promises")).readFile(backupPath);
  await service.changePassphrase(oldPass, changedPass);
  expect((await readOwnerState(ownerDir, changedPass)).receiptKeys).toHaveLength(2);
  await expect(readOwnerState(ownerDir, oldPass)).rejects.toThrow();
  await expect(service.restore(backupBytes, join(root, "wrong-backup"), changedPass)).rejects.toThrow();
  await service.restore(backupBytes, restoredDir, newPass);
  const restored = await readOwnerState(restoredDir, newPass);
  expect(restored.restoration).toBe("needs-resync");
  expect(restored.receiptKeys).toHaveLength(2);
  await expect(service.restore(backupBytes, restoredDir, newPass)).rejects.toThrow();
  online = false;
  const recoveredService = new OwnerService({ dir: restoredDir, manifestPath: "unused", rpcUrl: "unused", owner: account.address },
    async () => { if (!online) throw new Error("RPC unavailable"); return { context, history }; });
  expect(await recoveredService.balance(newPass)).toMatchObject({ kind: "balance", status: "stale" });
  await expect(recoveredService.exportPublic(created.operationId, newPass, join(restoredDir, "blocked.json"))).rejects.toThrow();
  online = true;
  expect(await recoveredService.sync(newPass)).toMatchObject({ kind: "sync", status: "complete" });
  const once = await readOwnerState(restoredDir, newPass);
  expect(once.sync?.status === "complete" && once.sync.availableWei).toBe(12n);
  expect(once.receiptKeys).toHaveLength(2);
  expect(once.operations[created.operationId]?.phase).toBe("authorized");
  expect(await recoveredService.sync(newPass)).toMatchObject({ kind: "sync", status: "complete" });
  const twice = await readOwnerState(restoredDir, newPass);
  expect(twice.sync?.status === "complete" && twice.sync.availableWei).toBe(12n);
  expect(twice.sync?.status === "complete" && twice.sync.utxos).toHaveLength(2);
});
