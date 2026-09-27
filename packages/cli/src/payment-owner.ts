import { randomBytes, webcrypto } from "node:crypto";
import { authorizeOperation, preflightSubmission, toPublicSubmission } from "@confidential-utxo/core";
import type { Context, LocalDraft, OwnedUtxo } from "@confidential-utxo/core";
import { assertWithdrawalBinding, defaultTerms, fetchPayQuote,
  parseOperationRecord, paymentDigest, selectPayInput } from "@confidential-utxo/uniswap";
import type { Address as PaymentAddress, Bytes32, InputId, PayInput, PayQuote,
  PaymentDeployment, PaymentPorts, PaymentTerms, PreparedPay, Scope,
  SubmissionOutcome, RecoveryPorts, OperationRef } from "@confidential-utxo/uniswap";
import type { Address, Hex, PublicClient } from "viem";
import { bytesToHex, hexToBytes } from "viem";
import type { LocalAccount } from "viem/accounts";
import { decodeRecipientInfo } from "./public-files.js";
import { encodePaymentPublic } from "./payment-public.js";
import { parseExactObject, hexBytes } from "./strict-json.js";
import { OwnerService } from "./owner.js";
import { readOwnerState } from "./state.js";
import { readPaymentProgress, savePaymentProgress } from "./payment-state.js";
import type { PaymentProgressV1 } from "./payment-state.js";
import type { ServiceClient } from "./service-client.js";
import { createCliReconciliation } from "./payment-reconciliation.js";
import { listPaymentAttempts } from "./payment-journal.js";
import { join } from "node:path";

const routerQuoteAbi = [{ type: "function", name: "getAmountsOut", stateMutability: "view",
  inputs: [{ type: "uint256" }, { type: "address[]" }], outputs: [{ type: "uint256[]" }] }] as const;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value,
  (_, item) => typeof item === "bigint" ? item.toString() : item));
function invalid(): never { throw new Error("PAYMENT_OWNER_INVALID"); }

export type CliPayInput = { owner: Address; amountWei: bigint; recipient: Address;
  minAmountOut?: bigint; deadline?: bigint; previousId?: Hex };
export type QuoteRpc = { getBlock(args: { blockTag: "latest" | "finalized" }): Promise<{
  number: bigint; hash: Hex | null; timestamp: bigint }>;
  readContract(args: { address: Address; abi: typeof routerQuoteAbi; functionName: "getAmountsOut";
    args: readonly [bigint, readonly [Address, Address]]; blockNumber: bigint }): Promise<readonly bigint[]> };
export type CliPaymentPorts = { ownerService: OwnerService; passphrase: Uint8Array; signer: LocalAccount;
  signerFile: string;
  service: ServiceClient; context: Context; deployment: PaymentDeployment; scope: Scope;
  rpc: QuoteRpc; chainRpc?: PublicClient; clock: { now(): number }; submitAttempt?: (
    prepared: PreparedPay, signatures: { pool: Hex; payment?: Hex }, attemptId: string) => Promise<SubmissionOutcome> };

export function selectCliPayInput(inputs: readonly PayInput[], amountWei: bigint,
  owner: PaymentAddress): PayInput | undefined {
  return selectPayInput(inputs, amountWei, owner);
}

export async function fetchCliQuote(ports: Pick<CliPaymentPorts, "context" | "deployment" | "rpc" | "clock">,
  amountWei: bigint): Promise<{ quote: PayQuote; blockTime: bigint }> {
  const startedAtMs = ports.clock.now();
  const tag = ports.context.finalityMode === "finalized" ? "finalized" : "latest";
  const block = await ports.rpc.getBlock({ blockTag: tag });
  if (!block.hash) invalid();
  const payQuote = await fetchPayQuote({ getAmountsOut: async (amount, path) => ({
    blockHash: block.hash as Bytes32, blockNumber: block.number,
    amounts: await ports.rpc.readContract({ address: ports.deployment.router,
      abi: routerQuoteAbi, functionName: "getAmountsOut", args: [amount, path], blockNumber: block.number }),
  }) }, amountWei, { weth: ports.deployment.weth, dusd: ports.deployment.token },
  { now: () => startedAtMs });
  return { quote: payQuote, blockTime: block.timestamp };
}

function usableInputs(inputs: readonly OwnedUtxo[], scope: Scope,
  reservations: ReadonlySet<string>, local: ReadonlySet<string>): PayInput[] {
  return inputs.map(input => ({ id: input.id as InputId, owner: input.owner as PaymentAddress,
    valueWei: input.opening.amount, state: (input.status === "available" &&
      same(input.owner, scope.owner) && !reservations.has(input.id.toLowerCase()) &&
      !local.has(input.id.toLowerCase())) ? "available" as const : "reserved" as const }));
}

function makePrepared(ports: Pick<CliPaymentPorts, "context" | "deployment" | "scope">,
  entry: PaymentProgressV1["payments"][Hex],
  payQuote: PayQuote): PreparedPay {
  if (!entry || entry.privateDraft.phase === "fixed") invalid();
  const state = entry.privateDraft;
  const draft: LocalDraft = { ...state.fixed, balanceProof: state.balanceProof,
    rangeProofs: state.rangeProofs,
    ...(state.phase === "authorized" ? { signature: state.signature } : {}) };
  assertWithdrawalBinding(draft, entry.terms, ports.deployment);
  const id = paymentDigest(entry.terms, ports.context.chainId, ports.deployment.adapter);
  if (!same(id, entry.paymentId)) invalid();
  const record = parseOperationRecord({ kind: "pay", recordId: draft.operationId,
    inputId: draft.request.inputIds[0], operationId: draft.operationId, paymentId: id,
    contentHash: id, encryptedBundle: { ciphertext: "AQID",
      nonce: `0x${"00".repeat(12)}`, tag: `0x${"00".repeat(16)}` },
    deadline: entry.terms.deadline.toString(), signatureStarted: false, attemptIds: [] }, ports.scope);
  return { record, quote: payQuote, privateBytes: encode({ draft: state, terms: entry.terms }),
    poolAuthorization: { operationId: draft.operationId } };
}

export async function prepareCliPay(input: CliPayInput, ports: CliPaymentPorts): Promise<PreparedPay> {
  if (!same(input.owner, ports.scope.owner) || !same(ports.signer.address, input.owner) ||
    !same(ports.context.pool, ports.deployment.pool) || input.amountWei <= 0n) invalid();
  let requiredInput: Hex | undefined;
  if (input.previousId) {
    const previousId = input.previousId;
    const saved = await ports.service.reservations.get(ports.scope, previousId as Bytes32);
    const before = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
      ports.context, input.owner);
    const old = before.connection?.payments[previousId];
    if (!saved || saved.reservationState !== "released" || !old ||
      old.terms.ethAmount !== input.amountWei || !same(old.terms.recipient, input.recipient)) invalid();
    const oldInput = old.privateDraft.fixed.request.inputIds[0];
    if (!oldInput) invalid();
    requiredInput = oldInput;
    const successors = Object.entries(before.connection!.payments).filter(([id, candidate]) =>
      !same(id, previousId) && candidate.terms.deadline > old.terms.deadline && candidate.privateDraft.fixed.request.inputIds.some(item =>
        same(item, oldInput!)));
    if (successors.length > 1) invalid();
    if (successors.length === 1) {
      const [id, candidate] = successors[0]!;
      if (candidate.terms.minAmountOut !== input.minAmountOut ||
        candidate.terms.deadline !== input.deadline) invalid();
      return loadPreparedCliPay(id as Hex, ports);
    }
    if (before.operations[previousId]) {
      await ports.ownerService.abandon(previousId, ports.passphrase);
    }
  }
  await ports.ownerService.sync(ports.passphrase);
  const initial = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
    ports.context, input.owner);
  if (initial.restoration !== "ready" || initial.sync?.status !== "complete") invalid();
  const listed = await ports.service.reservations.list(ports.scope);
  if (listed.availability !== "healthy") invalid();
  const unfinished = Object.values(initial.connection?.payments ?? {}).filter(entry =>
    (!input.previousId || !same(entry.operationId, input.previousId)) &&
    entry.privateDraft.phase !== "authorized" && !entry.poolSignature && !entry.paymentSignature &&
    entry.attemptIds.length === 0 && entry.txHashes.length === 0 && entry.terms.ethAmount === input.amountWei &&
    same(entry.terms.recipient, input.recipient) &&
    (input.minAmountOut === undefined ? entry.autoMinAmountOut : entry.terms.minAmountOut === input.minAmountOut) &&
    (input.deadline === undefined ? entry.autoDeadline : entry.terms.deadline === input.deadline));
  if (unfinished.length > 1) invalid();
  if (unfinished.length === 1) {
    const entry = unfinished[0]!;
    if (await ports.service.reservations.get(ports.scope, entry.operationId as Bytes32)) invalid();
    return loadPreparedCliPay(entry.operationId, ports);
  }
  const remote = new Set(listed.records.filter(row => row.reservationState === "active")
    .map(row => row.record.inputId.toLowerCase()));
  const local = new Set(Object.values(initial.operations).flatMap(record =>
    record.fixed.request.inputIds.map(id => id.toLowerCase())));
  const selected = selectCliPayInput(usableInputs(initial.sync.utxos, ports.scope, remote, local)
    .filter(candidate => requiredInput === undefined || same(candidate.id, requiredInput)),
    input.amountWei, input.owner as PaymentAddress);
  if (!selected) invalid();
  const first = await fetchCliQuote(ports, input.amountWei);
  const defaults = defaultTerms(first.quote, first.blockTime);
  const termsBase = { minAmountOut: input.minAmountOut ?? defaults.minAmountOut,
    deadline: input.deadline ?? defaults.deadline };
  if (termsBase.minAmountOut <= 0n || termsBase.deadline <= first.blockTime) invalid();
  const info = await decodeRecipientInfo(await ports.ownerService.recipientInfo(
    ports.passphrase, ports.signerFile), ports.context, input.owner);
  const created = await ports.ownerService.create({ kind: 2, owner: input.owner,
    amount: input.amountWei, destination: ports.deployment.adapter,
    changeRecipient: info, explicitIds: [selected.id] }, ports.passphrase, (fixed, prior) => {
    const terms: PaymentTerms = { operationId: fixed.operationId as PaymentTerms["operationId"],
      owner: input.owner as PaymentTerms["owner"], ethAmount: input.amountWei,
      token: ports.deployment.token, recipient: input.recipient as PaymentTerms["recipient"], ...termsBase };
    const paymentId = paymentDigest(terms, ports.context.chainId, ports.deployment.adapter);
    return { revision: (prior?.revision ?? 0) + 1, deploymentId: ports.scope.deploymentId,
      recordKey: prior?.recordKey ?? bytesToHex(randomBytes(32)), rewards: prior?.rewards ?? {},
      payments: { ...(prior?.payments ?? {}), [fixed.operationId]: {
        operationId: fixed.operationId, paymentId, terms, privateDraft: { phase: "fixed", fixed },
        attemptIds: [], txHashes: [], quote: first.quote,
        autoMinAmountOut: input.minAmountOut === undefined,
        autoDeadline: input.deadline === undefined,
      } } };
  });
  if (created.kind !== "created") invalid();
  return loadPreparedCliPay(created.operationId, ports);
}

export async function loadPreparedCliPay(id: Hex, ports: Pick<CliPaymentPorts,
  "ownerService" | "passphrase" | "context" | "deployment" | "scope" | "rpc" | "clock">): Promise<PreparedPay> {
  let state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
    ports.context, ports.scope.owner);
  if (state.restoration !== "ready" || state.sync?.status !== "complete") invalid();
  let entry = state.connection?.payments[id];
  if (!entry) invalid();
  if (entry.privateDraft.phase === "fixed") {
    const operation = state.operations[id];
    if (!operation || operation.phase === "authorized" || entry.poolSignature || entry.paymentSignature ||
      entry.attemptIds.length !== 0 || entry.txHashes.length !== 0) invalid();
    if (operation.phase === "fixed") await ports.ownerService.prove(id, ports.passphrase);
    state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
      ports.context, ports.scope.owner);
    const current = state.connection;
    const proved = state.operations[id];
    if (!current || !proved || proved.phase !== "proved" ||
      current.payments[id]?.paymentId !== entry.paymentId) invalid();
    entry = { ...current.payments[id]!, privateDraft: proved };
    await savePaymentProgress(ports.ownerService.config.dir, ports.passphrase, ports.scope.owner,
      { revision: current.revision }, { ...current, revision: current.revision + 1,
        payments: { ...current.payments, [id]: entry } });
  }
  // Persisted clock readings do not establish freshness in a new CLI process.
  // Keep the confirmed absolute deadline while it is live; refreshing a quote
  // must not silently extend an existing authorization's lifetime.
  const refreshed = await fetchCliQuote(ports, entry.terms.ethAmount);
  const defaults = defaultTerms(refreshed.quote, refreshed.blockTime);
  if ((entry.autoMinAmountOut && defaults.minAmountOut !== entry.terms.minAmountOut) ||
    entry.terms.deadline <= refreshed.blockTime) {
    throw new Error("TERMS_CHANGED");
  }
  return makePrepared(ports, entry, refreshed.quote);
}

/** Releases only a draft that has never reached the shared reservation service. */
export async function discardPreparedCliPay(id: Hex, ports: Pick<CliPaymentPorts,
  "ownerService" | "passphrase" | "context" | "scope" | "service">): Promise<void> {
  const state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
    ports.context, ports.scope.owner);
  const entry = state.connection?.payments[id];
  const operation = state.operations[id];
  if (!entry || operation?.phase === "authorized" ||
    entry.poolSignature || entry.paymentSignature || entry.attemptIds.length !== 0 ||
    entry.txHashes.length !== 0) invalid();
  // An unknown GET is a stop: a late reservation ACK may still be live.
  if (await ports.service.reservations.get(ports.scope, id as Bytes32)) invalid();
  if (operation) await ports.ownerService.abandon(id, ports.passphrase);
  const current = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
    ports.scope.owner);
  const payments = { ...current.payments };
  delete payments[id];
  await savePaymentProgress(ports.ownerService.config.dir, ports.passphrase,
    ports.scope.owner, { revision: current.revision }, { ...current,
      revision: current.revision + 1, payments });
}

export async function loadSignedPreparedCliPay(id: Hex, ports: Pick<CliPaymentPorts,
  "ownerService" | "passphrase" | "context" | "deployment" | "scope">): Promise<PreparedPay> {
  const state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
    ports.context, ports.scope.owner);
  const entry = state.connection?.payments[id];
  if (!entry?.quote || state.restoration !== "ready") invalid();
  return makePrepared(ports, entry, entry.quote);
}

export function createCliPaymentPorts(ports: CliPaymentPorts): PaymentPorts {
  const paymentPorts: PaymentPorts = {
    reservations: ports.service.reservations,
    ...(ports.chainRpc ? { reconciliation: createCliReconciliation({ ownerService: ports.ownerService,
      passphrase: ports.passphrase, context: ports.context, deployment: ports.deployment,
      scope: ports.scope, chainRpc: ports.chainRpc }) } : {}),
    preparePay: input => prepareCliPay(input as CliPayInput, ports),
    prepareFullWithdraw: async () => { throw new Error("FULL_WITHDRAW_NOT_CONFIGURED"); },
    refreshPay: async prepared => {
      const refreshed = await fetchCliQuote(ports, prepared.quote.inputWei);
      const state = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
        ports.scope.owner);
      const entry = state.payments[prepared.record.operationId];
      if (!entry) invalid();
      const defaults = defaultTerms(refreshed.quote, refreshed.blockTime);
      const terms = { ...entry.terms,
        minAmountOut: entry.autoMinAmountOut ? defaults.minAmountOut : entry.terms.minAmountOut,
        deadline: entry.terms.deadline };
      if (terms.deadline <= refreshed.blockTime) throw new Error("TERMS_CHANGED");
      const paymentId = paymentDigest(terms, ports.context.chainId, ports.deployment.adapter);
      const next = makePrepared(ports, { ...entry, terms, paymentId }, refreshed.quote);
      return next;
    },
    validatePrepared: async prepared => {
      const state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
        ports.context, ports.scope.owner);
      if (state.restoration !== "ready" || state.sync?.status !== "complete" ||
        !state.connection?.payments[prepared.record.operationId]) invalid();
      const operation = state.operations[prepared.record.operationId];
      if (!operation || operation.phase === "fixed") invalid();
      const online = await ports.ownerService.verifiedOnline(ports.passphrase);
      const preflight = await preflightSubmission(ports.context, operation.fixed.request,
        { history: online.history });
      if (preflight.status !== "ready") invalid();
    },
    currentScope: () => ports.scope,
    clock: ports.clock,
    latestBlockTime: async () => (await ports.rpc.getBlock({ blockTag:
      ports.context.finalityMode === "finalized" ? "finalized" : "latest" })).timestamp,
    encrypt: async (plaintext, metadata) => {
      const state = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
        ports.scope.owner);
      const key = await webcrypto.subtle.importKey("raw", hexToBytes(state.recordKey), "AES-GCM", false,
        ["encrypt"]);
      const nonce = randomBytes(12);
      const aad = encode({ deploymentId: metadata.scope.deploymentId, owner: metadata.scope.owner,
        recordId: metadata.recordId, revision: metadata.revision });
      const combined = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
        additionalData: aad }, key, plaintext));
      return { ciphertext: Buffer.from(combined.subarray(0, -16)).toString("base64"),
        nonce: bytesToHex(nonce), tag: bytesToHex(combined.subarray(-16)) };
    },
    sealContent: (prepared, signatures, attemptId, txHash) => encode({
      recordId: prepared.record.recordId, signatures,
      ...(attemptId ? { attemptId } : {}), ...(txHash ? { txHash } : {}) }),
    signPool: async payload => {
      const id = payload.operationId as Hex;
      const state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
        ports.context, ports.scope.owner);
      const operation = state.operations[id];
      if (!operation) invalid();
      return authorizeOperation(ports.context, operation.fixed.request, ports.signer);
    },
    signPayment: async prepared => {
      const state = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
        ports.scope.owner);
      const entry = state.payments[prepared.record.operationId];
      if (!entry) invalid();
      return ports.signer.signTypedData({ domain: { name: "Ethereum Confidential UTXO Uniswap Payment",
        version: "1", chainId: ports.context.chainId, verifyingContract: ports.deployment.adapter },
      primaryType: "PaymentAuthorization", types: { PaymentAuthorization: [
        { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
        { name: "ethAmount", type: "uint256" }, { name: "token", type: "address" },
        { name: "minAmountOut", type: "uint256" }, { name: "recipient", type: "address" },
        { name: "deadline", type: "uint64" } ] }, message: entry.terms });
    },
    createAttempt: () => bytesToHex(randomBytes(32)) as never,
    submit: async (prepared, signatures, attemptId) => {
      if (!ports.submitAttempt) throw new Error("PAYMENT_SUBMIT_NOT_CONFIGURED");
      return ports.submitAttempt(prepared as PreparedPay, signatures, attemptId);
    },
  };
  if (ports.chainRpc) {
    const reconciliation = createCliReconciliation({ ownerService: ports.ownerService,
      passphrase: ports.passphrase, context: ports.context, deployment: ports.deployment,
      scope: ports.scope, chainRpc: ports.chainRpc });
    const recovery: RecoveryPorts = {
      async readEvidence(saved) {
        const { history } = await ports.ownerService.verifiedOnline(ports.passphrase);
        const point = await history.getFinalizedCheckpoint();
        if (!point) throw new Error("PAYMENT_CHECKPOINT_UNAVAILABLE");
        const block = await ports.chainRpc!.getBlock({ blockNumber: point.number });
        if (!block.hash || !same(block.hash, point.hash)) throw new Error("PAYMENT_CHECKPOINT_REORG");
        const input = await history.getUtxo(saved.record.inputId, point);
        if (!input.complete || !same(input.blockHash, point.hash)) {
          throw new Error("PAYMENT_HISTORY_UNAVAILABLE");
        }
        const reference: OperationRef = { scope: saved.record.scope,
          operationId: saved.record.operationId,
          ...(saved.record.kind === "pay" ? { paymentId: saved.record.paymentId } : {}),
          attemptIds: saved.record.attemptIds, txHashes: [],
          chainOutcome: "unknown", receiptState: "none" };
        const observed = saved.record.kind === "pay"
          ? await reconciliation.readFinalized(reference, saved) : undefined;
        const journal = await listPaymentAttempts(join(ports.ownerService.config.dir,
          "payment-journal"), { context: ports.context, deploymentId: ports.scope.deploymentId,
          deployment: ports.deployment, submitter: ports.scope.owner });
        const attempts = await Promise.all(saved.record.attemptIds.map(async id => {
          const item = journal.find(row => same(row.attemptId, id));
          if (!item?.txHash) return { id, outcome: "unknown" as const };
          try {
            const receipt = await ports.chainRpc!.getTransactionReceipt({ hash: item.txHash });
            if (receipt.blockNumber > point.number) return { id, outcome: "pending" as const };
            return { id, outcome: receipt.status === "reverted" ? "finalized-failure" as const
              : "unknown" as const };
          } catch { return { id, outcome: "unknown" as const }; }
        }));
        return { evidence: { finalized: true, blockTime: block.timestamp,
          paymentSucceeded: observed?.history.adapter !== undefined,
          submissionKnownAbsent: saved.record.attemptIds.length === 0,
          attempts, storageAvailability: "healthy" as const },
        currentInput: { state: !input.value.exists ? "unknown" as const
          : input.value.consumedBy ? "spent" as const : "unspent" as const } };
      },
      async restoreOriginal(saved) {
        const prepared = await loadSignedPreparedCliPay(saved.record.operationId, ports);
        if (saved.revision >= 3) await recoverSignedCliPay(saved.record.operationId, ports);
        const progress = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
          ports.scope.owner);
        const entry = progress.payments[saved.record.operationId];
        return { prepared, ...(entry?.poolSignature && entry.paymentSignature ? {
          signatures: { pool: entry.poolSignature, payment: entry.paymentSignature } } : {}) };
      },
      async restoreForRetry(saved) {
        const prepared = await loadSignedPreparedCliPay(saved.record.operationId, ports);
        const progress = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
          ports.scope.owner);
        const entry = progress.payments[saved.record.operationId];
        if (!entry?.poolSignature || !entry.paymentSignature) invalid();
        return { prepared, signatures: { pool: entry.poolSignature,
          payment: entry.paymentSignature } };
      },
      async releaseOriginal(saved) {
        const { history } = await ports.ownerService.verifiedOnline(ports.passphrase);
        const point = await history.getFinalizedCheckpoint();
        if (!point) throw new Error("PAYMENT_CHECKPOINT_UNAVAILABLE");
        const prepared = await loadSignedPreparedCliPay(saved.record.operationId, ports);
        const revision = saved.revision + 1;
        const encryptedBundle = await paymentPorts.encrypt(prepared.privateBytes,
          { scope: saved.record.scope, recordId: saved.record.recordId, revision });
        return ports.service.reservations.release({ ...saved.record, encryptedBundle },
          { blockHash: point.hash as Bytes32 }, saved.revision, revision);
      },
    };
    paymentPorts.recovery = recovery;
  }
  return paymentPorts;
}

export async function recoverSignedCliPay(id: Hex, ports: Pick<CliPaymentPorts,
  "ownerService" | "passphrase" | "service" | "scope">): Promise<void> {
  const saved = await ports.service.reservations.get(ports.scope, id as Bytes32);
  if (!saved || saved.revision < 3 || saved.reservationState !== "active" ||
    !same(saved.record.operationId, id)) invalid();
  const current = await readPaymentProgress(ports.ownerService.config.dir, ports.passphrase,
    ports.scope.owner);
  const entry = current.payments[id];
  if (!entry) invalid();
  const key = await webcrypto.subtle.importKey("raw", hexToBytes(current.recordKey), "AES-GCM",
    false, ["decrypt"]);
  const bundle = saved.record.encryptedBundle;
  const aad = encode({ deploymentId: ports.scope.deploymentId, owner: ports.scope.owner,
    recordId: saved.record.recordId, revision: saved.revision });
  const cipher = Buffer.concat([Buffer.from(bundle.ciphertext, "base64"),
    Buffer.from(bundle.tag.slice(2), "hex")]);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM",
      iv: hexToBytes(bundle.nonce as Hex), additionalData: aad }, key, cipher));
  } catch { throw new Error("PAYMENT_RECORD_UNAVAILABLE"); }
  let poolSignature: Hex;
  let paymentSignature: Hex;
  try {
    const row = parseExactObject(plain, ["recordId", "signatures", "attemptId", "txHash"]);
    if (row.recordId !== id || !row.signatures || typeof row.signatures !== "object") invalid();
    const signatures = row.signatures as Record<string, unknown>;
    poolSignature = hexBytes(signatures.pool, 65);
    paymentSignature = hexBytes(signatures.payment, 65);
  } finally { plain.fill(0); }
  if (entry.poolSignature && !same(entry.poolSignature, poolSignature) ||
    entry.paymentSignature && !same(entry.paymentSignature, paymentSignature)) invalid();
  await savePaymentProgress(ports.ownerService.config.dir, ports.passphrase,
    ports.scope.owner, { revision: current.revision }, { ...current,
      revision: current.revision + 1, payments: { ...current.payments,
        [id]: { ...entry, poolSignature, paymentSignature } } });
}

export async function exportSignedCliPay(id: Hex, ports: Pick<CliPaymentPorts,
  "ownerService" | "passphrase" | "context" | "deployment" | "scope">): Promise<Uint8Array> {
  const state = await readOwnerState(ports.ownerService.config.dir, ports.passphrase,
    ports.context, ports.scope.owner);
  if (state.restoration !== "ready" || state.sync?.status !== "complete") invalid();
  const entry = state.connection?.payments[id];
  if (!entry?.poolSignature || !entry.paymentSignature || entry.privateDraft.phase === "fixed") invalid();
  const draft = { ...entry.privateDraft.fixed, balanceProof: entry.privateDraft.balanceProof,
    rangeProofs: entry.privateDraft.rangeProofs, signature: entry.poolSignature };
  const submission = toPublicSubmission(draft);
  return encodePaymentPublic(ports.context, ports.scope.deploymentId, ports.deployment,
    entry.terms, submission, entry.paymentSignature);
}
