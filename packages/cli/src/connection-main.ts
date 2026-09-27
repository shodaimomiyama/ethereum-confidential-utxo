import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, createWalletClient, erc20Abi, http, parseEventLogs } from "viem";
import type { Address, Hex } from "viem";
import { foundry, sepolia } from "viem/chains";
import { createEthereumRpc, createHistoryPort, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import { outputId } from "@confidential-utxo/core";
import { adapterAbi, createPaymentClient, defaultTerms } from "@confidential-utxo/uniswap";
import type { PaymentDeployment, Scope } from "@confidential-utxo/uniswap";
import { readPrivateFile, replacePrivateFile } from "./atomic-file.js";
import { listPaymentAttempts } from "./payment-journal.js";
import { decodePaymentPublic } from "./payment-public.js";
import { createCliPaymentPorts, discardPreparedCliPay, exportSignedCliPay, fetchCliQuote, loadPreparedCliPay,
  prepareCliPay, recoverSignedCliPay } from "./payment-owner.js";
import type { CliPaymentPorts } from "./payment-owner.js";
import { reconcileCliPay, submitPublicPayment } from "./payment-submitter.js";
import { OwnerService } from "./owner.js";
import { decodeRecipientInfo } from "./public-files.js";
import { privateBalance } from "./render.js";
import type { CliResult } from "./render.js";
import { promptPassphrase, readLocalSigner } from "./secret-input.js";
import type { SecretInput, SecretOutput } from "./secret-input.js";
import { readOwnerState } from "./state.js";
import { readPaymentProgress, savePaymentProgress } from "./payment-state.js";
import { createServiceClient, ServiceClientError } from "./service-client.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";

export type ConnectionOptions = Record<string, string | string[]>;
export type ConnectionIO = { stdin: SecretInput; stderr: SecretOutput };
function invalid(): never { throw new Error("CLI_INPUT"); }
function value(options: ConnectionOptions, name: string): string {
  const result = options[name];
  if (typeof result !== "string" || !result) invalid();
  return result;
}
function optional(options: ConnectionOptions, name: string): string | undefined {
  return typeof options[name] === "string" ? options[name] : undefined;
}
function address(input: string): Address { return hexBytes(input, 20) as Address; }
function hash(input: string): Hex { return hexBytes(input, 32); }
async function bounded(path: string, max = 2 * 1024 * 1024): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) invalid();
  return readFile(path);
}
async function amountFile(path: string): Promise<bigint> {
  const bytes = await readPrivateFile(path, 4096);
  try { return decimalWei(parseExactObject(bytes, ["amountWei"]).amountWei); }
  finally { bytes.fill(0); }
}
async function termsFile(path: string | undefined): Promise<{ minAmountOut?: bigint; deadline?: bigint }> {
  if (!path) return {};
  const bytes = await readPrivateFile(path, 4096);
  try {
    const row = parseExactObject(bytes, ["minAmountOut", "deadline"]);
    if (row.minAmountOut === undefined || row.deadline === undefined) invalid();
    return { minAmountOut: decimalWei(row.minAmountOut), deadline: decimalWei(row.deadline) };
  } finally { bytes.fill(0); }
}
async function environment(options: ConnectionOptions) {
  const rpcUrl = value(options, "rpc");
  const poolManifest = parseExactObject(await bounded(value(options, "manifest"), 1024 * 1024),
    ["schemaVersion", "chainId", "hardfork", "signer", "tool", "artifacts",
      "parametersHash", "pool", "verifier"]);
  const connectionManifest = parseExactObject(await bounded(value(options, "connection-manifest"), 1024 * 1024),
    ["schemaVersion", "chainId", "generation", "contracts", "assets", "site", "provenance", "references"]);
  const mode = poolManifest.chainId === 31337 ? "local-simulated" : "finalized";
  const rpc = createEthereumRpc({ url: rpcUrl, mode });
  const verified = await verifyEthereumDeployment(rpc.client, poolManifest, mode);
  const bridge = await import(new URL("../../../scripts/uniswap-integration.mjs", import.meta.url).href) as {
    verifyConnection(manifest: unknown, client: unknown): Promise<void> };
  await bridge.verifyConnection(connectionManifest, rpc.client);
  const contracts = connectionManifest.contracts as Record<string, { address: string }>;
  const deployment: PaymentDeployment = { pool: address(contracts.pool!.address) as never,
    adapter: address(contracts.adapter!.address) as never,
    token: address(contracts.dUSD!.address) as never,
    router: address(contracts.router02!.address) as never,
    factory: address(contracts.factory!.address) as never,
    weth: address(contracts.weth9!.address) as never,
    pair: address(contracts.pair!.address) as never };
  if (verified.context.chainId !== BigInt(connectionManifest.chainId as number) ||
    verified.context.pool.toLowerCase() !== deployment.pool.toLowerCase()) invalid();
  return { rpc, verified, deployment };
}
function serviceClient(options: ConnectionOptions, chainId: bigint, owner: Address,
  signer: Awaited<ReturnType<typeof readLocalSigner>>) {
  const scope: Scope = { deploymentId: value(options, "deployment-id") as Scope["deploymentId"],
    owner: owner as Scope["owner"] };
  const origin = value(options, "api-origin");
  const client = createServiceClient({ baseUrl: optional(options, "api-url") ?? origin,
    origin, siweUri: optional(options, "siwe-uri") ?? `${origin}/`, chainId: Number(chainId),
    scope, signer });
  return { client, scope };
}
function ownerService(options: ConnectionOptions, owner: Address): OwnerService {
  return new OwnerService({ dir: value(options, "store"), manifestPath: value(options, "manifest"),
    rpcUrl: value(options, "rpc"), owner });
}
function payPorts(options: ConnectionOptions, env: Awaited<ReturnType<typeof environment>>,
  service: OwnerService, passphrase: Uint8Array,
  signer: Awaited<ReturnType<typeof readLocalSigner>>,
  api: ReturnType<typeof serviceClient>): CliPaymentPorts {
  const chain = env.verified.context.chainId === 31337n ? foundry : sepolia;
  const wallet = createWalletClient({ account: signer, chain, transport: http(value(options, "rpc")) });
  return { ownerService: service, passphrase, signer, signerFile: value(options, "signer"),
    service: api.client, context: env.verified.context, deployment: env.deployment,
    scope: api.scope, rpc: env.rpc.client as unknown as CliPaymentPorts["rpc"],
    chainRpc: env.rpc.client, clock: { now: () => Math.floor(performance.now()) },
    submitAttempt: async (prepared, signatures, attemptId) => {
      // Revision 3 is durable before this callback. Restore its signatures after a
      // restart at revision 1/2, when the local encrypted snapshot may still lack them.
      await recoverSignedCliPay(prepared.record.operationId, { ownerService: service,
        passphrase, service: api.client, scope: api.scope });
      const signed = (await readPaymentProgress(service.config.dir, passphrase,
        api.scope.owner)).payments[prepared.record.operationId];
      if (!signed?.poolSignature || !signed.paymentSignature || !signatures.payment ||
        signed.poolSignature.toLowerCase() !== signatures.pool.toLowerCase() ||
        signed.paymentSignature.toLowerCase() !== signatures.payment.toLowerCase()) invalid();
      const bytes = await exportSignedCliPay(prepared.record.operationId, {
        ownerService: service, passphrase, context: env.verified.context,
        deployment: env.deployment, scope: api.scope });
      const result = await submitPublicPayment(bytes, { context: env.verified.context,
        deploymentId: api.scope.deploymentId, deployment: env.deployment,
        submitter: signer.address }, { account: { address: signer.address },
          sendTransaction: async args => wallet.sendTransaction({ ...args, account: signer, chain }) },
      env.rpc.client, join(service.config.dir, "payment-journal"), attemptId as Hex);
      return result.chainOutcome === "pending" ? { kind: "submitted", txHash: result.txHashes[0]! }
        : { kind: "unknown" };
    } };
}

export async function runConnection(command: string, options: ConnectionOptions,
  io: ConnectionIO): Promise<CliResult> {
  const env = await environment(options);
  const context = env.verified.context;
  const deploymentId = value(options, "deployment-id");
  if (command === "pay submit" || (command === "pay status" && options.journal)) {
    const submitter = address(value(options, "submitter"));
    const binding = { context, deployment: env.deployment, deploymentId, submitter };
    if (command === "pay status") {
      const attempts = await listPaymentAttempts(value(options, "journal"), binding);
      const id = hash(value(options, "id"));
      const found = attempts.filter(item => item.paymentId.toLowerCase() === id.toLowerCase() ||
        item.operationId.toLowerCase() === id.toLowerCase());
      if (found.length === 0) invalid();
      const last = found.at(-1)!;
      const point = await env.rpc.client.getBlock({ blockTag: context.finalityMode === "finalized"
        ? "finalized" : "latest" });
      if (!point.hash) throw new Error("PAYMENT_CHECKPOINT_UNAVAILABLE");
      const checkpoint = { number: point.number, hash: point.hash, mode: context.finalityMode };
      const logs = await env.rpc.client.getLogs({ address: env.deployment.adapter,
        fromBlock: context.deploymentBlock, toBlock: point.number });
      const successes = parseEventLogs({ abi: adapterAbi, eventName: "PaymentSucceeded", logs })
        .filter(log => log.args.paymentId.toLowerCase() === last.paymentId.toLowerCase() &&
          log.args.operationId.toLowerCase() === last.operationId.toLowerCase());
      if (successes.length > 1) throw new Error("PAYMENT_HISTORY_INCONSISTENT");
      if (successes.length === 1) {
        const success = successes[0]!;
        const receipt = await env.rpc.client.getTransactionReceipt({ hash: success.transactionHash });
        if (receipt.status !== "success" || receipt.blockNumber > point.number ||
          receipt.blockHash.toLowerCase() !== success.blockHash.toLowerCase()) {
          throw new Error("PAYMENT_HISTORY_INCONSISTENT");
        }
        const publicPay = await decodePaymentPublic(last.publicBytes, context, deploymentId, env.deployment);
        const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
        if (!same(success.args.owner, publicPay.terms.owner) ||
          !same(success.args.token, publicPay.terms.token) ||
          !same(success.args.recipient, publicPay.terms.recipient) ||
          success.args.ethAmount !== publicPay.terms.ethAmount ||
          success.args.minAmountOut !== publicPay.terms.minAmountOut ||
          success.args.deadline !== publicPay.terms.deadline) {
          throw new Error("PAYMENT_HISTORY_INCONSISTENT");
        }
        const history = createHistoryPort(env.verified, env.rpc.client, env.rpc.policy);
        const finalized = await history.getFinalizedCheckpoint();
        if (!finalized || finalized.number !== checkpoint.number ||
          !same(finalized.hash, checkpoint.hash)) throw new Error("PAYMENT_CHECKPOINT_REORG");
        const inputId = publicPay.poolSubmission.request.inputIds[0];
        const changeOutput = publicPay.poolSubmission.request.outputs[0];
        if (!inputId || !changeOutput) throw new Error("PAYMENT_HISTORY_INCONSISTENT");
        const changeId = outputId(last.operationId, 0);
        const [operations, executed, input, change] = await Promise.all([
          history.getOperations(context.deploymentBlock, checkpoint),
          history.getOperationSuccess(last.operationId, checkpoint),
          history.getUtxo(inputId, checkpoint),
          history.getUtxo(changeId, checkpoint),
        ]);
        const matched = operations.complete ? operations.value.filter(item =>
          same(item.success?.operationId, last.operationId) &&
          same(item.success?.transactionHash, success.transactionHash) &&
          same(item.success?.blockHash, receipt.blockHash) &&
          item.success?.blockNumber === receipt.blockNumber) : [];
        const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer",
          logs: receipt.logs.filter(log => same(log.address, publicPay.terms.token)) })
          .filter(log => same(log.args.to, publicPay.terms.recipient) &&
            log.args.value === success.args.amountOut);
        if (!operations.complete || !executed.complete || !input.complete || !change.complete ||
          matched.length !== 1 || !executed.value.executed ||
          !same(input.value.consumedBy, last.operationId) ||
          !change.value.exists || !same(change.value.owner, publicPay.terms.owner) ||
          change.value.commitment?.x !== changeOutput.commitment.x ||
          change.value.commitment?.y !== changeOutput.commitment.y || transfers.length !== 1) {
          throw new Error("PAYMENT_HISTORY_INCONSISTENT");
        }
        return { kind: "payment", operationId: last.operationId, paymentId: last.paymentId,
          status: "finalized-success", attemptId: last.attemptId,
          txHash: success.transactionHash, checkpoint };
      }
      if (last.txHash) {
        try {
          const receipt = await env.rpc.client.getTransactionReceipt({ hash: last.txHash });
          if (receipt.blockNumber <= point.number && receipt.status === "reverted") {
            return { kind: "payment", operationId: last.operationId, paymentId: last.paymentId,
              status: "failed", attemptId: last.attemptId, txHash: last.txHash, checkpoint };
          }
        } catch { /* A missing transaction remains unknown or pending. */ }
      }
      return { kind: "payment", operationId: last.operationId, paymentId: last.paymentId,
        status: last.state === "unknown" ? "unknown" : "pending", attemptId: last.attemptId,
        ...(last.txHash ? { txHash: last.txHash } : {}), checkpoint };
    }
    const signer = await readLocalSigner(value(options, "signer"), submitter);
    const chain = context.chainId === 31337n ? foundry : sepolia;
    const wallet = createWalletClient({ account: signer, chain, transport: http(value(options, "rpc")) });
    const result = await submitPublicPayment(await bounded(value(options, "public")), binding,
      { account: { address: submitter }, sendTransaction: async args => wallet.sendTransaction({
        ...args, account: signer, chain }) }, env.rpc.client, value(options, "journal"));
    return { kind: "payment", operationId: result.operationId, paymentId: result.paymentId!,
      status: result.chainOutcome, attemptId: result.attemptIds[0] as Hex,
      ...(result.txHashes[0] ? { txHash: result.txHashes[0] as Hex } : {}) };
  }

  const owner = address(value(options, "owner"));
  const service = ownerService(options, owner);
  const passphrase = await promptPassphrase("unlock", io.stdin, io.stderr);
  try {
    const signer = command === "pay export" || command === "pay quote" || command === "pay status"
      ? undefined : await readLocalSigner(value(options, "signer"), owner);
    const scope: Scope = { deploymentId: deploymentId as Scope["deploymentId"],
      owner: owner as Scope["owner"] };
    if (command === "pay quote") {
      const amount = await amountFile(value(options, "amount-file"));
      const quoted = await fetchCliQuote({ context, deployment: env.deployment,
        rpc: env.rpc.client as unknown as CliPaymentPorts["rpc"], clock: { now: () => Math.floor(performance.now()) } }, amount);
      const defaults = defaultTerms(quoted.quote, quoted.blockTime);
      return { kind: "pay-quote", amount: privateBalance(amount), quoteOut: quoted.quote.quoteOut,
        minAmountOut: defaults.minAmountOut, deadline: defaults.deadline,
        blockHash: quoted.quote.blockHash };
    }
    if (command === "pay export") {
      const id = hash(value(options, "id"));
      await replacePrivateFile(value(options, "out"), await exportSignedCliPay(id, {
        ownerService: service, passphrase, context, deployment: env.deployment, scope }));
      const progress = await readPaymentProgress(service.config.dir, passphrase, owner);
      const entry = progress.payments[id];
      if (!entry) invalid();
      return { kind: "payment", operationId: id, paymentId: entry.paymentId, status: "exported" };
    }
    if (command === "pay status") {
      const id = hash(value(options, "id"));
      const progress = await readPaymentProgress(service.config.dir, passphrase, owner);
      const entry = progress.payments[id];
      if (!entry) invalid();
      const apiSigner = await readLocalSigner(value(options, "signer"), owner);
      const api = serviceClient(options, context.chainId, owner, apiSigner);
      await api.client.authenticate();
      const ports = payPorts(options, env, service, passphrase, apiSigner, api);
      const reference = { scope, operationId: entry.operationId as never,
        paymentId: entry.paymentId as never, attemptIds: entry.attemptIds as never,
        txHashes: entry.txHashes as never, chainOutcome: "unknown" as const,
        receiptState: "none" as const };
      const status = await reconcileCliPay(id as never, reference, createCliPaymentPorts(ports));
      return { kind: "payment", operationId: id, paymentId: entry.paymentId,
        status: status.operation.chainOutcome === "finalized-success" &&
          status.operation.receiptState !== "confirmed"
          ? "pending-receipt" : status.operation.chainOutcome,
        checkpoint: status.checkpoint };
    }
    if (!signer) invalid();
    const api = serviceClient(options, context.chainId, owner, signer);
    if (command === "reward list") {
      const state = await readOwnerState(service.config.dir, passphrase, context, owner);
      if (state.connection && state.connection.deploymentId !== deploymentId) invalid();
      const local = new Map<string, { requestId: Hex; status: string; operationId?: Hex; outputId?: Hex }>(
        Object.entries(state.connection?.rewards ?? {}).map(([requestId, entry]) =>
        [requestId.toLowerCase(), { requestId: requestId as Hex, status: entry.status,
          ...(entry.operationId ? { operationId: entry.operationId } : {}),
          ...(entry.outputId ? { outputId: entry.outputId } : {}) }]));
      try {
        await api.client.authenticate();
        for (const reward of await api.client.listRewards()) local.set(reward.requestId.toLowerCase(), {
          requestId: reward.requestId, status: reward.status,
          ...(reward.operationId ? { operationId: reward.operationId } : {}),
          ...(reward.outputId ? { outputId: reward.outputId } : {}) });
      } catch (error) { if (local.size === 0) throw error; }
      return { kind: "reward-list", entries: [...local.values()].sort((a, b) =>
        a.requestId.localeCompare(b.requestId)) };
    }
    await api.client.authenticate();
    if (command.startsWith("reward ")) {
      const requestId = optional(options, "request-id")
        ? hash(value(options, "request-id")) : bytesToHex(randomBytes(32));
      if (command === "reward status") {
        const reward = await api.client.getReward(requestId as never);
        return { kind: "reward", requestId, status: reward.status,
          ...(reward.operationId ? { operationId: reward.operationId } : {}),
          ...(reward.outputId ? { outputId: reward.outputId } : {}) };
      }
      if (command === "reward received") {
        const result = await service.sync(passphrase);
        if (result.kind !== "sync" || result.status !== "complete") invalid();
        const state = await readOwnerState(service.config.dir, passphrase, context, owner);
        const reward = await api.client.getReward(requestId as never);
        const outputId = reward.outputId;
        if (!outputId || !reward.blockHash || state.sync?.status !== "complete" ||
          !state.sync.utxos.some(item => item.id.toLowerCase() === outputId.toLowerCase())) invalid();
        const updated = await api.client.markReceived(requestId as never, outputId, reward.blockHash);
        return { kind: "reward", requestId, status: updated.status,
          ...(updated.operationId ? { operationId: updated.operationId } : {}), outputId };
      }
      const amountWei = await amountFile(value(options, "amount-file"));
      const recipientInfo = await decodeRecipientInfo(await service.recipientInfo(passphrase,
        value(options, "signer")), context, owner);
      const state = await readOwnerState(service.config.dir, passphrase, context, owner);
      const prior = state.connection;
      const existing = prior?.rewards[requestId];
      if (existing && (existing.amountWei !== amountWei ||
        existing.recipientInfo.receivePublicKey.toLowerCase() !== recipientInfo.receivePublicKey.toLowerCase())) invalid();
      if (!existing) await savePaymentProgress(service.config.dir, passphrase, owner,
        { revision: prior?.revision ?? 0 }, { revision: (prior?.revision ?? 0) + 1,
          deploymentId, recordKey: prior?.recordKey ?? bytesToHex(randomBytes(32)),
          rewards: { ...(prior?.rewards ?? {}), [requestId]: { amountWei,
            recipientInfo, status: "prepared" } }, payments: prior?.payments ?? {} });
      const request = { scope, requestId: requestId as never, amountWei,
        recipientInfo: { owner: owner as never, publicKey: recipientInfo.receivePublicKey as never,
          signature: recipientInfo.signature } };
      let reward;
      try { reward = await api.client.createReward(request); }
      catch (error) {
        if (!(error instanceof ServiceClientError) ||
          !["SERVICE_UNAVAILABLE", "SERVICE_PROTOCOL_ERROR"].includes(error.code)) throw error;
        try { reward = await api.client.getReward(requestId as never); }
        catch { throw error; }
      }
      const current = await readPaymentProgress(service.config.dir, passphrase, owner);
      await savePaymentProgress(service.config.dir, passphrase, owner,
        { revision: current.revision }, { ...current, revision: current.revision + 1,
          rewards: { ...current.rewards, [requestId]: { ...current.rewards[requestId]!,
            status: reward.status === "received" ? "received" : reward.status === "finalized" ? "distributed" : "requested",
            ...(reward.operationId ? { operationId: reward.operationId } : {}),
            ...(reward.outputId ? { outputId: reward.outputId } : {}),
            ...(reward.blockHash ? { blockHash: reward.blockHash } : {}) } } });
      return { kind: "reward", requestId, status: reward.status,
        ...(reward.operationId ? { operationId: reward.operationId } : {}),
        ...(reward.outputId ? { outputId: reward.outputId } : {}) };
    }
    const ports = payPorts(options, env, service, passphrase, signer, api);
    if (command === "pay prepare") {
      const replaceId = optional(options, "replace-id");
      if (replaceId) await discardPreparedCliPay(hash(replaceId), ports);
      const prepared = await prepareCliPay({ owner, amountWei: await amountFile(value(options, "amount-file")),
        recipient: address(value(options, "recipient")), ...(await termsFile(optional(options, "terms-file"))) }, ports);
      const progress = await readPaymentProgress(service.config.dir, passphrase, owner);
      const entry = progress.payments[prepared.record.operationId];
      const inputId = entry?.privateDraft.fixed.request.inputIds[0];
      if (!entry || !inputId) invalid();
      return { kind: "payment", operationId: prepared.record.operationId,
        paymentId: prepared.record.paymentId!, status: "prepared",
        confirmation: { inputId, amount: privateBalance(entry.terms.ethAmount),
          token: entry.terms.token, minAmountOut: entry.terms.minAmountOut,
          recipient: entry.terms.recipient, deadline: entry.terms.deadline } };
    }
    if (command === "pay authorize") {
      const id = hash(value(options, "id"));
      const prepared = await loadPreparedCliPay(id, ports);
      const confirmed = hash(value(options, "confirmed-content-hash"));
      const reference = await createPaymentClient(createCliPaymentPorts(ports))
        .authorizePayForExport(prepared, confirmed as never);
      await recoverSignedCliPay(id, ports);
      return { kind: "payment", operationId: id, paymentId: reference.paymentId!,
        status: reference.chainOutcome };
    }
    if (command === "pay resume" || command === "pay retry") {
      const id = hash(value(options, "id"));
      const client = createPaymentClient(createCliPaymentPorts(ports));
      const outcome = command === "pay resume"
        ? await client.resumeOriginal(id as never) : await client.retryAttempt(id as never);
      const progress = await readPaymentProgress(service.config.dir, passphrase, owner);
      const entry = progress.payments[id];
      if (!entry) invalid();
      const saved = await api.client.reservations.get(api.scope, id as never);
      if (!saved) invalid();
      const attempts = await listPaymentAttempts(join(service.config.dir, "payment-journal"), {
        context, deploymentId, deployment: env.deployment, submitter: owner });
      const relevant = attempts.filter(item => item.operationId.toLowerCase() === id.toLowerCase());
      await savePaymentProgress(service.config.dir, passphrase, owner,
        { revision: progress.revision }, { ...progress, revision: progress.revision + 1,
          payments: { ...progress.payments, [id]: { ...entry,
            attemptIds: saved.record.attemptIds.filter(item => /^0x[0-9a-fA-F]{64}$/.test(item)) as Hex[],
            txHashes: relevant.flatMap(item => item.txHash ? [item.txHash] : []) } } });
      return { kind: "payment", operationId: id, paymentId: entry.paymentId,
        status: outcome.kind === "submitted" ? "pending" : outcome.kind === "unknown" ? "unknown" : "not-submitted",
        ...(outcome.kind === "submitted" ? { txHash: outcome.txHash } : {}) };
    }
    if (command === "pay change-terms") {
      const id = hash(value(options, "id"));
      const progress = await readPaymentProgress(service.config.dir, passphrase, owner);
      const previous = progress.payments[id];
      if (!previous) invalid();
      const terms = await termsFile(value(options, "terms-file"));
      if (terms.minAmountOut === undefined || terms.deadline === undefined) invalid();
      const changed = await createPaymentClient(createCliPaymentPorts(ports)).prepareChangedTerms(
        id as never, { previousId: id, owner, amountWei: previous.terms.ethAmount,
          recipient: previous.terms.recipient, ...terms });
      const current = await readPaymentProgress(service.config.dir, passphrase, owner);
      const next = current.payments[changed.record.operationId];
      const inputId = next?.privateDraft.fixed.request.inputIds[0];
      if (!next || !inputId) invalid();
      return { kind: "payment", operationId: changed.record.operationId,
        paymentId: changed.record.paymentId!, status: "prepared",
        confirmation: { inputId, amount: privateBalance(next.terms.ethAmount),
          token: next.terms.token, minAmountOut: next.terms.minAmountOut,
          recipient: next.terms.recipient, deadline: next.terms.deadline } };
    }
    invalid();
  } finally { passphrase.fill(0); }
}
