import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authorizeOperation, buildOperation, inspectReceipt, operationId, outputId,
  preflightSubmission, prepareSubmission, synchronize,
  type Checkpoint, type Context, type HistoryPort, type LocalDraft,
  type ObservedOperation, type OperationRequest, type ReceiptKeyPort,
  type RecipientInfo, type SignerPort, type StoragePort,
} from "@confidential-utxo/core";

// Public test keys and recipient signature from the independent #35 application vector.
const vector = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/application-operation.json", import.meta.url), "utf8"))
  .find((v: { id: string }) => v.id === "VEC-07-APPLICATION-DEPOSIT");
const receipt = vector.expected.receipts[0];
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const context: Context = { chainId: BigInt(vector.input.chainId), pool: vector.input.pool,
  deploymentBlock: 1n, verifier: vector.input.pool, parametersHash: hash(0), finalityMode: "finalized" };
const recipient: RecipientInfo = { ...receipt.recipientInfo, chainId: context.chainId, pool: context.pool };
const signer: SignerPort = { signTypedData: data => account.signTypedData(data) };
const keys: ReceiptKeyPort = { getKey: async owner => {
  expect(owner.toLowerCase()).toBe(account.address.toLowerCase());
  return hexToBytes(receipt.recipientPrivateKey);
} };

function fixture() {
  const operations: ObservedOperation[] = [];
  const saved: LocalDraft[] = [];
  const calls: string[] = [];
  let point: Checkpoint = { number: 1n, hash: hash(1), mode: "finalized" };
  const bound = <T>(value: T) => ({ complete: true as const, blockHash: point.hash, value });
  const utxo = async (id: OperationRequest["inputIds"][number]) => {
    const output = operations.flatMap(o => o.outputLogs).find(o => o.outputId === id)?.output;
    const consumedBy = operations.find(o => o.request.inputIds.includes(id))?.success?.operationId;
    return bound(output ? { exists: true, owner: output.owner, commitment: output.commitment,
      ...(consumedBy ? { consumedBy } : {}) } : { exists: false });
  };
  const success = async (id: LocalDraft["operationId"]) => {
    const operation = operations.find(o => o.success?.operationId === id)?.request;
    return bound(operation ? { executed: true, operation } : { executed: false });
  };
  const history: HistoryPort = {
    getFinalizedCheckpoint: async () => { calls.push("sync"); return structuredClone(point); },
    getContext: async () => bound(context),
    getCanonicalHeader: async number => bound({ number, hash: hash(Number(number)) }),
    getOperations: async from => bound(operations.filter(o => o.success!.blockNumber >= from)),
    getUtxo: utxo, getOperationSuccess: success,
    getLatestHeader: async () => { calls.push("preflight"); return structuredClone(point); },
    getLatestUtxo: utxo, getLatestOperationSuccess: success,
  };
  const storage: StoragePort = { saveDraft: async draft => {
    calls.push("save"); saved.push(structuredClone(draft)); return "saved";
  } };
  function execute(request: OperationRequest) {
    point = { ...point, number: point.number + 1n, hash: hash(Number(point.number + 1n)) };
    const id = operationId(context, request);
    const location = { operationId: id, blockNumber: point.number, blockHash: point.hash,
      transactionHash: hash(100 + Number(point.number)), transactionIndex: 0 };
    const observed: ObservedOperation = {
      request: structuredClone(request),
      success: { ...location, logIndex: request.inputIds.length + request.outputs.length },
      inputLogs: request.inputIds.map((inputId, logIndex) => ({ ...location, inputId, logIndex })),
      outputLogs: request.outputs.map((output, i) => ({ ...location, output: structuredClone(output),
        outputId: outputId(id, i), outputIndex: i, logIndex: request.inputIds.length + i })),
    };
    operations.push(observed);
    return observed;
  }
  return { history, storage, keys, saved, calls, execute };
}
async function sign(draft: LocalDraft) {
  return { ...draft, signature: await authorizeOperation(context, draft.request, signer) };
}
async function deposit(f: ReturnType<typeof fixture>) {
  const draft = await sign(await buildOperation({ kind: 0, owner: account.address, amount: 10n, recipient }, context,
    { inputs: [], randomSalt: () => new Uint8Array(32).fill(1) }));
  const prepared = await prepareSubmission(draft, f);
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("deposit not ready");
  return { draft, observed: f.execute(prepared.submission.request) };
}

it("AC-02/05/10: VEC-07-APPLICATION-DEPOSIT recipient supports public-only build, sign, save, receive and sync", async () => {
  const f = fixture();
  const { draft, observed } = await deposit(f);
  expect(f.calls).toEqual(["sync", "save", "preflight"]);
  expect(f.saved).toEqual([draft]);
  expect(await preflightSubmission(context, draft.request, f)).toBe("executed");
  const checkpoint = (await f.history.getFinalizedCheckpoint())!;
  // Receiver gets public history and its own key only; no draft/openings/storage.
  const received = await inspectReceipt(observed, 0, account.address, keys, {
    context,
    creationBlock: await f.history.getCanonicalHeader(observed.success!.blockNumber, checkpoint),
    operation: await f.history.getOperationSuccess(draft.operationId, checkpoint),
    utxo: await f.history.getUtxo(draft.outputIds[0]!, checkpoint),
  }, checkpoint);
  expect(received.status).toBe("available");
  if (received.status !== "available") throw new Error("receipt not available");
  expect(received.utxo.opening).toEqual(draft.openings[0]);
  expect(received.utxo.opening.amount).toBe(10n);
  const synced = await synchronize(context, { history: f.history, keys, owners: [account.address] });
  expect(synced).toEqual({ status: "complete", checkpoint, availableWei: 10n, utxos: [received.utxo] });
  expect(await synchronize(context, { history: f.history, keys, owners: [account.address] }, synced)).toEqual(synced);
  if (synced.status !== "complete") throw new Error("sync incomplete");
  const transfer = await sign(await buildOperation({ kind: 1, owner: account.address, amount: 3n,
    recipient, changeRecipient: recipient }, context, { inputs: synced.utxos, randomSalt: () => new Uint8Array(32).fill(2) }));
  expect(transfer.openings.map(o => o.amount)).toEqual([3n, 7n]);
  expect(transfer.rangeProofs).toHaveLength(2);
  const prepared = await prepareSubmission(transfer, f);
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready") throw new Error("transfer not ready");
  expect(Object.keys(prepared.submission).sort()).toEqual(["balanceProof", "rangeProofs", "request", "signature"]);
  expect(prepared.submission.request).toEqual(transfer.request);
  f.execute(prepared.submission.request);
  const after = await synchronize(context, { history: f.history, keys, owners: [account.address] });
  expect(after.status).toBe("complete");
  if (after.status !== "complete") throw new Error("transfer sync incomplete");
  expect(after.availableWei).toBe(10n);
  expect(after.utxos.map(u => [u.status, u.opening.amount])).toEqual([["spent", 10n], ["available", 3n], ["available", 7n]]);
});

it.each(["executed", "conflict"] as const)("AC-08/09/10: restored non-deposit preparation detects %s from creation and consumption history", async outcome => {
  const f = fixture();
  await deposit(f);
  const synced = await synchronize(context, { history: f.history, keys, owners: [account.address] });
  if (synced.status !== "complete") throw new Error("sync incomplete");
  const draft = await sign(await buildOperation({ kind: 2, owner: account.address, amount: 10n,
    destination: account.address }, context, { inputs: synced.utxos, randomSalt: () => new Uint8Array(32).fill(3) }));
  f.calls.length = 0;
  expect((await prepareSubmission(draft, f)).status).toBe("ready");
  const restored = structuredClone(f.saved.at(-1)!);
  expect((await prepareSubmission(restored, f)).status).toBe("ready");
  f.execute(outcome === "executed" ? draft.request : { ...draft.request, salt: hash(99) });
  expect(await prepareSubmission(restored, f)).toEqual({ status: outcome });
  expect(f.calls).toEqual(Array.from({ length: 3 }, () => ["sync", "save", "preflight"]).flat());
  const after = await synchronize(context, { history: f.history, keys, owners: [account.address] });
  expect(after).toMatchObject({ status: "complete", availableWei: 0n, utxos: [{ status: "spent" }] });
});
