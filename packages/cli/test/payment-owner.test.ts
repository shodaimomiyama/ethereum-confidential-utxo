import { fixOperation } from "@confidential-utxo/core";
import { expect, it, vi } from "vitest";
import { isQuoteFresh, paymentDigest } from "@confidential-utxo/uniswap";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRecipientInfo } from "../src/public-files.js";
import { initializeOwnerState, readOwnerState, updateOwnerState } from "../src/state.js";
import { discardPreparedCliPay, loadPreparedCliPay, prepareCliPay, selectCliPayInput } from "../src/payment-owner.js";
import type { OwnerService, CreateConnectionProgress } from "../src/owner.js";
import type { ServiceClient } from "../src/service-client.js";
import { account, context, deployment, fixture, recipient } from "./payment-public.test.js";

const owner = "0x1111111111111111111111111111111111111111" as never;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as never;

it("selects the smallest single spendable input with positive change", () => {
  const inputs = [
    { id: id(9), owner, valueWei: 8n, state: "available" as const },
    { id: id(2), owner, valueWei: 4n, state: "available" as const },
    { id: id(1), owner, valueWei: 4n, state: "available" as const },
    { id: id(3), owner, valueWei: 3n, state: "available" as const },
  ];
  expect(selectCliPayInput(inputs, 3n, owner)?.id).toBe(id(1));
  expect(selectCliPayInput(inputs, 4n, owner)?.id).toBe(id(9));
  expect(isQuoteFresh({ startedAtMs: 0, blockHash: id(4), blockNumber: 1n,
    inputWei: 3n, quoteOut: 10n }, 30_001)).toBe(false);
});

it.each([false, true])("persists and resumes the same Pay draft around proof interruption (%s)", async interrupted => {
  const dir = await mkdtemp(join(tmpdir(), "payment-owner-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { fixed, input, submission } = await fixture();
    const point = input.checkpoint;
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null, operations: {},
      sync: { status: "complete", checkpoint: point, utxos: [input],
        receiptFailures: [], availableWei: 7n }, restoration: "ready" });
    const service = { reservations: { get: async () => undefined, list: async () => ({ availability: "healthy", records: [] }) } } as unknown as ServiceClient;
    let creations = 0;
    let failProof = interrupted;
    const ownerService = { config: { dir }, sync: async () => undefined,
      recipientInfo: async () => encodeRecipientInfo(recipient),
      create: async (_intent: unknown, _pass: Uint8Array, connection: CreateConnectionProgress) => {
        creations++;
        await updateOwnerState(dir, passphrase, current => ({ ...current,
          connection: connection(fixed, current.connection), operations: {
          ...current.operations, [fixed.operationId]: { phase: "fixed", fixed } } }));
        return { kind: "created", operationId: fixed.operationId };
      },
      prove: async () => {
        if (failProof) { failProof = false; throw new Error("proof interrupted"); }
        await updateOwnerState(dir, passphrase, current => ({ ...current, operations: {
          ...current.operations, [fixed.operationId]: { phase: "proved", fixed,
            balanceProof: submission.balanceProof, rangeProofs: submission.rangeProofs } } }));
      },
    } as unknown as OwnerService;
    const prepare = () => prepareCliPay({ owner: account.address, amountWei: 3n,
      recipient: account.address }, { ownerService, passphrase, signer: account, signerFile: "unused",
      service, context, deployment, scope: { deploymentId: "local-v1" as never,
        owner: account.address as never }, clock: { now: () => 0 }, rpc: {
          getBlock: async () => ({ number: 1n, hash: point.hash, timestamp: 100n }),
          readContract: async () => [3n, 100n],
        } });
    if (interrupted) {
      await expect(prepare()).rejects.toThrow("proof interrupted");
      const persisted = await readOwnerState(dir, passphrase);
      expect(persisted.connection?.payments[fixed.operationId]?.privateDraft.phase).toBe("fixed");
      expect(persisted.operations[fixed.operationId]?.phase).toBe("fixed");
    }
    const prepared = await prepare();
    expect(creations).toBe(1);
    expect(prepared.record.operationId).toBe(fixed.operationId);
    expect(prepared.record.inputId).toBe(input.id);
    expect((await readOwnerState(dir, passphrase)).connection?.payments[fixed.operationId]?.terms.ethAmount).toBe(3n);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("discards an unreserved prepared Pay so its input can be selected again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-discard-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { fixed, terms } = await fixture();
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null,
      operations: { [fixed.operationId]: { phase: "fixed", fixed } },
      sync: null, restoration: "ready", connection: { revision: 1,
        deploymentId: "local-v1", recordKey: id(42), rewards: {}, payments: {
          [fixed.operationId]: { operationId: fixed.operationId, paymentId: id(43), terms,
            privateDraft: { phase: "fixed", fixed }, attemptIds: [], txHashes: [] },
        } } });
    const service = { reservations: { get: async () => undefined } } as unknown as ServiceClient;
    const ownerService = { config: { dir }, abandon: async (operationId: string) => {
      await updateOwnerState(dir, passphrase, current => {
        const operations = { ...current.operations };
        delete operations[operationId as keyof typeof operations];
        return { ...current, operations };
      });
    } } as unknown as OwnerService;
    await discardPreparedCliPay(fixed.operationId, { ownerService, passphrase, context,
      scope: { deploymentId: "local-v1" as never, owner: account.address as never }, service });
    const state = await readOwnerState(dir, passphrase);
    expect(state.operations[fixed.operationId]).toBeUndefined();
    expect(state.connection?.payments[fixed.operationId]).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it("pins changed terms to the old input even when a smaller input arrives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-change-input-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { fixed, input, terms } = await fixture();
    const smaller = await fixOperation({ kind: 0, owner: account.address, amount: 4n, recipient }, context,
      { inputs: [], randomSalt: () => new Uint8Array(32).fill(9) });
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null, operations: {},
      restoration: "ready", sync: { status: "complete", checkpoint: input.checkpoint,
        availableWei: 11n, receiptFailures: [], utxos: [input, { ...input,
          id: smaller.outputIds[0]!, opening: smaller.openings[0]!, commitment: smaller.request.outputs[0]!.commitment }] },
      connection: { revision: 1, deploymentId: "local-v1", recordKey: id(42), rewards: {},
        payments: { [fixed.operationId]: { operationId: fixed.operationId,
          paymentId: paymentDigest(terms, context.chainId, deployment.adapter), terms,
          privateDraft: { phase: "fixed", fixed }, attemptIds: [], txHashes: [] } } } });
    const create = vi.fn(async () => { throw new Error("creation observed"); });
    const service = { reservations: { get: async () => ({ reservationState: "released" }),
      list: async () => ({ availability: "healthy", records: [] }) } } as unknown as ServiceClient;
    await expect(prepareCliPay({ owner: account.address, amountWei: 3n,
      recipient: account.address, previousId: fixed.operationId, minAmountOut: 1n, deadline: 2000n }, {
      ownerService: { config: { dir }, sync: async () => undefined,
        recipientInfo: async () => encodeRecipientInfo(recipient), create } as unknown as OwnerService,
      passphrase, signer: account, signerFile: "unused", service, context, deployment,
      scope: { deploymentId: "local-v1" as never, owner: account.address as never },
      clock: { now: () => 0 }, rpc: {
        getBlock: async () => ({ number: 1n, hash: input.checkpoint.hash, timestamp: 1100n }),
        readContract: async () => [3n, 100n],
      },
    })).rejects.toThrow("creation observed");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ explicitIds: [input.id] }), passphrase, expect.any(Function));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("returns an already saved successor after restart without creating another draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "payment-change-resume-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { fixed, input, terms, submission } = await fixture();
    const successor = await fixOperation({ kind: 2, owner: account.address, amount: 3n,
      destination: deployment.adapter, changeRecipient: recipient, explicitIds: [input.id] }, context,
    { inputs: [input], randomSalt: () => new Uint8Array(32).fill(12) });
    const nextTerms = { ...terms, operationId: successor.operationId as typeof terms.operationId, deadline: 2000n };
    const draft = { phase: "proved" as const, fixed: successor,
      balanceProof: submission.balanceProof, rangeProofs: submission.rangeProofs };
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null,
      operations: { [successor.operationId]: draft }, restoration: "ready",
      sync: { status: "complete", checkpoint: input.checkpoint,
        availableWei: 7n, receiptFailures: [], utxos: [input] },
      connection: { revision: 2, deploymentId: "local-v1", recordKey: id(42), rewards: {}, payments: {
        [fixed.operationId]: { operationId: fixed.operationId,
          paymentId: paymentDigest(terms, context.chainId, deployment.adapter), terms,
          privateDraft: { phase: "fixed", fixed }, attemptIds: [], txHashes: [] },
        [successor.operationId]: { operationId: successor.operationId,
          paymentId: paymentDigest(nextTerms, context.chainId, deployment.adapter), terms: nextTerms,
          privateDraft: draft, attemptIds: [], txHashes: [], quote: { startedAtMs: 0,
            blockHash: input.checkpoint.hash as never, blockNumber: 1n, inputWei: 3n, quoteOut: 100n } },
      } } });
    const prepared = await prepareCliPay({ owner: account.address, amountWei: 3n,
      recipient: account.address, previousId: fixed.operationId, minAmountOut: 1n, deadline: 2000n }, {
      ownerService: { config: { dir } } as OwnerService,
      passphrase, signer: account, signerFile: "unused", context, deployment,
      service: { reservations: { get: async () => ({ reservationState: "released" }) } } as unknown as ServiceClient,
      scope: { deploymentId: "local-v1" as never, owner: account.address as never },
      clock: { now: () => 0 }, rpc: {
        getBlock: async () => ({ number: 2n, hash: input.checkpoint.hash, timestamp: 1100n }),
        readContract: async () => [3n, 100n],
      },
    });
    expect(prepared.record.operationId).toBe(successor.operationId);
    expect(Object.keys((await readOwnerState(dir, passphrase)).connection!.payments)).toHaveLength(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("commits the core operation and Pay metadata together or commits neither", async () => {
  const { OwnerService: RealOwnerService } = await import("../src/owner.js");
  const dir = await mkdtemp(join(tmpdir(), "payment-atomic-create-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { input, terms } = await fixture();
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null, operations: {},
      restoration: "ready", sync: { status: "complete", checkpoint: input.checkpoint,
        availableWei: 7n, receiptFailures: [], utxos: [input] } });
    const service = new RealOwnerService({ dir, owner: account.address, manifestPath: "unused", rpcUrl: "unused" });
    vi.spyOn(service, "sync").mockResolvedValue({ kind: "sync", status: "complete" });
    const intent = { kind: 2 as const, owner: account.address, amount: 3n,
      destination: deployment.adapter, changeRecipient: recipient, explicitIds: [input.id] };
    await expect(service.create(intent, passphrase, () => { throw new Error("metadata interrupted"); }))
      .rejects.toThrow("metadata interrupted");
    expect((await readOwnerState(dir, passphrase)).operations).toEqual({});
    const result = await service.create(intent, passphrase, fixed => {
      const boundTerms = { ...terms, operationId: fixed.operationId as typeof terms.operationId };
      return { revision: 1, deploymentId: "local-v1", recordKey: id(42), rewards: {}, payments: {
        [fixed.operationId]: { operationId: fixed.operationId, terms: boundTerms,
          paymentId: paymentDigest(boundTerms, context.chainId, deployment.adapter),
          privateDraft: { phase: "fixed", fixed }, attemptIds: [], txHashes: [] },
      } };
    });
    if (result.kind !== "created") throw new Error("unexpected create result");
    const state = await readOwnerState(dir, passphrase);
    expect(state.operations[result.operationId]?.phase).toBe("fixed");
    expect(state.connection?.payments[result.operationId]?.privateDraft.fixed.operationId).toBe(result.operationId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  { quoteOut: 100n, blockTime: 101n, automatic: true, rejects: false },
  { quoteOut: 200n, blockTime: 101n, automatic: true, rejects: true },
  { quoteOut: 200n, blockTime: 101n, automatic: false, rejects: false },
  { quoteOut: 100n, blockTime: 700n, automatic: true, rejects: true },
  { quoteOut: 100n, blockTime: 701n, automatic: false, rejects: true },
])("refreshes persisted quotes and preserves only live confirmed terms (%#)", async scenario => {
  const dir = await mkdtemp(join(tmpdir(), "payment-fresh-quote-"));
  try {
    const passphrase = new TextEncoder().encode("secret");
    const { fixed, input, terms, submission } = await fixture();
    const confirmed = { ...terms, minAmountOut: 99n, deadline: 700n };
    const draft = { phase: "proved" as const, fixed,
      balanceProof: submission.balanceProof, rangeProofs: submission.rangeProofs };
    await initializeOwnerState(dir, passphrase, { schemaVersion: 1, context,
      owner: account.address, receiptKeys: [], activeReceiptKeyId: null,
      operations: { [fixed.operationId]: draft }, restoration: "ready",
      sync: { status: "complete", checkpoint: input.checkpoint,
        availableWei: 7n, receiptFailures: [], utxos: [input] },
      connection: { revision: 1, deploymentId: "local-v1", recordKey: id(42), rewards: {},
        payments: { [fixed.operationId]: { operationId: fixed.operationId,
          paymentId: paymentDigest(confirmed, context.chainId, deployment.adapter), terms: confirmed,
          privateDraft: draft, attemptIds: [], txHashes: [], autoMinAmountOut: scenario.automatic,
          autoDeadline: scenario.automatic, quote: { startedAtMs: 10,
            blockHash: input.checkpoint.hash as never, blockNumber: 1n, inputWei: 3n, quoteOut: 100n } } } } });
    let clock = 10;
    const readContract = vi.fn(async () => [3n, scenario.quoteOut]);
    const result = loadPreparedCliPay(fixed.operationId, {
      ownerService: { config: { dir } } as OwnerService, passphrase, context, deployment,
      scope: { deploymentId: "local-v1" as never, owner: account.address as never },
      clock: { now: () => clock }, rpc: {
        getBlock: async () => {
          clock = 20;
          return { number: 2n, hash: input.checkpoint.hash, timestamp: scenario.blockTime };
        }, readContract,
      },
    });
    if (scenario.rejects) await expect(result).rejects.toThrow("TERMS_CHANGED");
    else {
      const prepared = await result;
      expect(prepared.quote.blockNumber).toBe(2n);
      expect(prepared.quote.quoteOut).toBe(scenario.quoteOut);
      expect(prepared.quote.startedAtMs).toBe(10);
      expect(prepared.record.deadline).toBe(confirmed.deadline);
      expect(prepared.record.paymentId).toBe(paymentDigest(confirmed, context.chainId, deployment.adapter));
    }
    expect(readContract).toHaveBeenCalledOnce();
    expect((await readOwnerState(dir, passphrase)).connection!.payments[fixed.operationId]!.terms)
      .toEqual(confirmed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
