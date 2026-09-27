import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, hexToBytes, http, parseEventLogs, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { expect, it } from 'vitest';
import { authorizeOperation, buildOperation, inspectReceipt, preflightSubmission, prepareSubmission, recipientInfoTypedData, synchronize } from '@confidential-utxo/core';
import { createHistoryPort, createOperationSigner, createRecipientInfoSigner, defaultRpcPolicy, poolAbi, submitPublicOperation, verifyEthereumDeployment } from '@confidential-utxo/ethereum';
import { assertWithdrawalBinding, createPaymentClient, defaultTerms, encodePayCall, fetchPayQuote, paymentDigest, parseAddress, parseBytes32, selectPayInput } from '../../../packages/uniswap/src/index.js';
import type { AttemptId, DeploymentId, FinalizedHistory, InputId, OperationId, PaymentDeployment, PaymentId, PaymentPorts, PaymentTerms, Scope, TxHash } from '../../../packages/uniswap/src/index.js';
import { adapterAbi } from '../../../packages/uniswap/src/generated/adapter-abi.js';
import { createMemoryReservationPort } from '../../../packages/uniswap/src/testing/reservation.js';
import { parseOperationRecord } from '../../../packages/uniswap/src/api.js';
import { deployPool } from '../../../scripts/pool-deployment.mjs';
import { deployLocalAssets } from '../../../scripts/uniswap-local.mjs';
import { deployConnection } from '../../../scripts/uniswap-integration.mjs';

const holderKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const holder = privateKeyToAccount(holderKey);
const receiver = JSON.parse(readFileSync('tests/vectors/cases/application-operation.json', 'utf8'))
  .find((entry: { id: string }) => entry.id === 'VEC-07-APPLICATION-DEPOSIT').expected.receipts[0];
const artifact = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-payment-v1.json', 'utf8'));
const uniswap = JSON.parse(readFileSync('packages/ethereum/generated/uniswap-v2.json', 'utf8'));
const tokenAbi = JSON.parse(readFileSync('contracts/out/DemoUSD.sol/DemoUSD.json', 'utf8')).abi;
const recipient = '0x000000000000000000000000000000000000cafe' as const;
const ethereumDependencyCommit = '0ae9b5215fdd2f05cbebd71e89365e010838fbba';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function withAnvil(run: (url: string) => Promise<void>) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing port'));
      server.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', ['--silent', '--host', '127.0.0.1', '--port', String(port),
    '--chain-id', '31337', '--hardfork', 'cancun', '--gas-limit', '30000000'], { stdio: 'ignore' });
  try {
    const client = createPublicClient({ transport: http(url) });
    let ready = false;
    for (let index = 0; index < 100; index++) {
      if (child.exitCode !== null) throw new Error(`Anvil exited: ${child.exitCode}`);
      try { ready = await client.getChainId() === 31337; } catch { /* wait for startup */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Anvil startup timed out');
    await run(url);
  } finally { child.kill('SIGTERM'); }
}

async function runPayment(highMinimum: boolean) {
  await withAnvil(async url => {
    const directory = mkdtempSync(join(tmpdir(), 'ecu-payment-client-'));
    try {
      const rpc = createPublicClient({ transport: http(url) });
      const wallet = createWalletClient({ account: holder, chain: foundry, transport: http(url) }).extend(publicActions);
      const assets = await deployLocalAssets({ url, chainId: 31337, generation: 'payment-client-test',
        holder: holder.address, lpRecipient: holder.address });
      const corePool = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: holderKey, hardfork: 'cancun', onDeployment: undefined });
      const poolManifest = await deployPool({ rpcUrl: url, expectedChainId: 31337,
        privateKey: holderKey, hardfork: 'cancun', onDeployment: undefined });
      expect(same(corePool.pool.address, poolManifest.pool.address)).toBe(false);
      const poolPath = join(directory, 'pool.json');
      writeFileSync(poolPath, JSON.stringify(poolManifest));
      const connection = await deployConnection({ poolManifest, poolManifestPath: poolPath,
        adapterArtifact: artifact, assetManifest: assets, signer: holder, publicClient: rpc,
        excludedPoolAddress: corePool.pool.address });
      const verified = await verifyEthereumDeployment(rpc, poolManifest, 'local-simulated');
      const context = verified.context;
      const history = createHistoryPort(verified, rpc, defaultRpcPolicy);
      const adapter = connection.contracts.adapter.address;
      const token = assets.contracts.dUSD.address;
      const router = assets.contracts.router02.address;
      const weth = assets.contracts.weth9.address;
      const pair = assets.contracts.pair.address;
      const deployment: PaymentDeployment = { adapter: parseAddress(adapter), pool: parseAddress(context.pool),
        token: parseAddress(token), router: parseAddress(router),
        factory: parseAddress(assets.contracts.factory.address), weth: parseAddress(weth), pair: parseAddress(pair) };
      const infoBase = { chainId: context.chainId, pool: context.pool, owner: owner.address,
        receivePublicKey: receiver.recipientInfo.receivePublicKey,
        receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
      const recipientSigner = createRecipientInfoSigner(owner, owner.address);
      const info = { ...infoBase, signature: await recipientSigner.signTypedData(
        recipientInfoTypedData(context, infoBase, owner.address)) };
      const keys = { getKey: async () => hexToBytes(receiver.recipientPrivateKey) };
      const signer = createOperationSigner(owner, owner.address);
      const deposit = await buildOperation({ kind: 0, owner: owner.address, amount: 6_000_000_000_000_000n, recipient: info },
        context, { inputs: [], randomSalt: () => randomBytes(32) });
      const signedDeposit = { ...deposit, signature: await authorizeOperation(context, deposit.request, signer) };
      const preparedDeposit = await prepareSubmission(signedDeposit, { history, keys,
        storage: { saveDraft: async () => 'saved' as const } });
      expect(preparedDeposit.status).toBe('ready');
      if (preparedDeposit.status !== 'ready') throw new Error('deposit preflight failed');
      const depositSent = await submitPublicOperation(verified, history, wallet, holder.address, preparedDeposit.submission);
      expect((await rpc.waitForTransactionReceipt({ hash: depositSent.attempt.txHash! })).status).toBe('success');
      const initial = await synchronize(context, { history, keys, owners: [owner.address] });
      expect(initial.status).toBe('complete');
      if (initial.status !== 'complete') throw new Error('deposit synchronization failed');
      const chosen = selectPayInput(initial.utxos.map(utxo => ({ id: parseBytes32(utxo.id) as unknown as InputId,
        owner: parseAddress(utxo.owner), valueWei: utxo.opening.amount,
        state: utxo.status === 'available' ? 'available' as const : 'unknown' as const })),
      3_000_000_000_000_000n, parseAddress(owner.address));
      expect(chosen?.id).toBe(deposit.outputIds[0]);
      const clock = { now: () => performance.now() };
      const reader = { getAmountsOut: async (inputWei: bigint) => {
        const block = await rpc.getBlock();
        const amounts = await rpc.readContract({ address: router, abi: uniswap.artifacts.router02.abi,
          functionName: 'getAmountsOut', args: [inputWei, [weth, token]], blockNumber: block.number });
        if (!Array.isArray(amounts) || amounts.some(amount => typeof amount !== 'bigint')) {
          throw new Error('invalid router quote');
        }
        return { blockHash: parseBytes32(block.hash!), blockNumber: block.number,
          amounts: amounts as readonly bigint[] };
      } };
      const quote = await fetchPayQuote(reader, 3_000_000_000_000_000n, { weth, dusd: token }, clock);
      const defaults = defaultTerms(quote, (await rpc.getBlock()).timestamp);
      const draft = await buildOperation({ kind: 2, owner: owner.address, amount: quote.inputWei,
        destination: adapter, changeRecipient: info, explicitIds: [chosen!.id] },
      context, { inputs: initial.utxos, randomSalt: () => randomBytes(32) });
      const terms: PaymentTerms = { operationId: parseBytes32(draft.operationId) as unknown as OperationId,
        owner: parseAddress(owner.address), ethAmount: quote.inputWei, token: parseAddress(token),
        minAmountOut: highMinimum ? quote.quoteOut * 2n : defaults.minAmountOut,
        recipient: parseAddress(recipient), deadline: defaults.deadline };
      assertWithdrawalBinding(draft, terms, deployment);
      const paymentId = paymentDigest(terms, context.chainId, adapter);
      const scope: Scope = { deploymentId: 'local-payment-client' as DeploymentId,
        owner: parseAddress(owner.address) };
      const record = parseOperationRecord({ kind: 'pay', recordId: draft.operationId,
        inputId: chosen!.id, operationId: draft.operationId, paymentId, contentHash: paymentId,
        encryptedBundle: { ciphertext: 'AQID', nonce: `0x${'00'.repeat(12)}`, tag: `0x${'00'.repeat(16)}` },
        deadline: String(terms.deadline), signatureStarted: false, attemptIds: [] }, scope);
      const prepared = { record, privateBytes: new Uint8Array([1, 2, 3]),
        poolAuthorization: { operationId: draft.operationId }, quote };
      const reservations = createMemoryReservationPort();
      const cipherKey = await webcrypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
      let submittedHash: `0x${string}` | undefined;
      const ports: PaymentPorts = {
        reservations,
        preparePay: async () => prepared,
        prepareFullWithdraw: async () => { throw new Error('not used'); },
        refreshPay: async () => prepared,
        validatePrepared: async () => {
          assertWithdrawalBinding(draft, terms, deployment);
          expect((await preflightSubmission(context, draft.request, { history })).status).toBe('ready');
        },
        currentScope: () => scope,
        clock,
        latestBlockTime: async () => (await rpc.getBlock()).timestamp,
        encrypt: async (plaintext: Uint8Array, metadata: { revision: number }) => {
          const nonce = randomBytes(12);
          const aad = new TextEncoder().encode(`${scope.deploymentId}:${scope.owner}:${record.recordId}:${metadata.revision}`);
          const combined = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
            additionalData: aad }, cipherKey, plaintext));
          return { ciphertext: Buffer.from(combined.subarray(0, -16)).toString('base64'),
            nonce: `0x${nonce.toString('hex')}`, tag: `0x${Buffer.from(combined.subarray(-16)).toString('hex')}` };
        },
        sealContent: (_prepared: unknown, signatures: { pool: string; payment?: string }, attemptId?: string, txHash?: string) =>
          new TextEncoder().encode(JSON.stringify({ signatures, attemptId, txHash })),
        signPool: async payload => {
          expect(payload.operationId).toBe(draft.operationId);
          return authorizeOperation(context, draft.request, signer);
        },
        signPayment: async candidate => {
          expect(candidate.record.operationId).toBe(record.operationId);
          expect(candidate.record.paymentId).toBe(paymentId);
          return owner.signTypedData({
          domain: { name: 'Ethereum Confidential UTXO Uniswap Payment', version: '1',
            chainId: context.chainId, verifyingContract: adapter },
          primaryType: 'PaymentAuthorization',
          types: { PaymentAuthorization: [
            { name: 'operationId', type: 'bytes32' }, { name: 'owner', type: 'address' },
            { name: 'ethAmount', type: 'uint256' }, { name: 'token', type: 'address' },
            { name: 'minAmountOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
            { name: 'deadline', type: 'uint64' },
          ] }, message: terms });
        },
        createAttempt: () => 'attempt-1' as AttemptId,
        submit: async (candidate, signatures, attemptId) => {
          expect(candidate.record.operationId).toBe(record.operationId);
          expect(attemptId).toBe('attempt-1');
          const data = encodePayCall(draft, terms, deployment, signatures.pool, signatures.payment!);
          submittedHash = await wallet.sendTransaction({ to: adapter, data, gas: 20_000_000n });
          return { kind: 'submitted' as const, txHash: submittedHash as TxHash };
        },
        reconciliation: { expectedChainId: context.chainId, readFinalized: async () => {
          const receipt = await rpc.getTransactionReceipt({ hash: submittedHash! });
          const point = await history.getFinalizedCheckpoint();
          if (!point) throw new Error('missing checkpoint');
          const operations = await history.getOperations(context.deploymentBlock, point);
          if (!operations.complete) throw new Error('incomplete Pool history');
          const observed = operations.value.find(item => same(item.success?.operationId ?? '', draft.operationId));
          if (!observed?.success) throw new Error('missing Pool success');
          const success = await history.getOperationSuccess(draft.operationId, point);
          const input = await history.getUtxo(chosen!.id, point);
          const change = await history.getUtxo(draft.outputIds[0]!, point);
          const header = await history.getCanonicalHeader(observed.success.blockNumber, point);
          if (!success.complete || !input.complete || !change.complete || !header.complete) throw new Error('incomplete state');
          const received = await inspectReceipt(observed, 0, owner.address, keys, {
            context, creationBlock: header, operation: success, utxo: change,
          }, point);
          const logs = parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded',
            logs: receipt.logs.filter(log => same(log.address, adapter)) });
          if (logs.length !== 1) throw new Error('missing Adapter success');
          const event = logs[0]!.args;
          const finalizedHistory: FinalizedHistory = {
            chainId: context.chainId, deploymentId: scope.deploymentId, checkpoint: point,
            blockHash: parseBytes32(receipt.blockHash), finalized: receipt.status === 'success',
            canonical: same(header.value.hash, receipt.blockHash), rpcConsistent: true,
            adapter: { blockHash: parseBytes32(receipt.blockHash),
              paymentId: parseBytes32(event.paymentId) as unknown as PaymentId,
              operationId: parseBytes32(event.operationId) as unknown as OperationId,
              owner: parseAddress(event.owner), amountOut: event.amountOut },
            pool: { blockHash: parseBytes32(observed.success.blockHash),
              operationId: parseBytes32(observed.success.operationId) as unknown as OperationId,
              inputId: chosen!.id, changeOutputId: parseBytes32(draft.outputIds[0]!) },
            input: { blockHash: parseBytes32(receipt.blockHash), inputId: chosen!.id,
              consumed: !!input.value.consumedBy },
            change: { blockHash: parseBytes32(receipt.blockHash),
              outputId: parseBytes32(draft.outputIds[0]!), owner: parseAddress(change.value.owner!) },
          };
          return { receipt: received, history: finalizedHistory };
        } },
      };
      const payment = createPaymentClient(ports);
      const before = await rpc.readContract({ address: token, abi: tokenAbi,
        functionName: 'balanceOf', args: [recipient] }) as bigint;
      const ref = await payment.authorizePay(await payment.preparePay(undefined), record.contentHash);
      expect(ref.chainOutcome).toBe('pending');
      const saved = await reservations.get(scope, record.recordId);
      expect(saved).toBeDefined();
      const bundle = saved!.record.encryptedBundle;
      const sealed = new Uint8Array(Buffer.concat([
        Buffer.from(bundle.ciphertext, 'base64'), Buffer.from(bundle.tag.slice(2), 'hex'),
      ]));
      const iv = new Uint8Array(Buffer.from(bundle.nonce.slice(2), 'hex'));
      const aad = new TextEncoder().encode(`${scope.deploymentId}:${scope.owner}:${record.recordId}:${saved!.revision}`);
      await expect(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad },
        cipherKey, sealed)).resolves.toBeDefined();
      const wrongOwnerAad = new TextEncoder().encode(`${scope.deploymentId}:${recipient}:${record.recordId}:${saved!.revision}`);
      await expect(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: wrongOwnerAad },
        cipherKey, sealed)).rejects.toThrow();
      const receipt = await rpc.waitForTransactionReceipt({ hash: submittedHash! });
      const inputState = await rpc.readContract({ address: context.pool, abi: poolAbi,
        functionName: 'getUtxo', args: [chosen!.id] });
      const changeState = await rpc.readContract({ address: context.pool, abi: poolAbi,
        functionName: 'getUtxo', args: [draft.outputIds[0]!] });
      const paid = await rpc.readContract({ address: adapter, abi: adapterAbi,
        functionName: 'isPaymentExecuted', args: [paymentId] });
      const after = await rpc.readContract({ address: token, abi: tokenAbi,
        functionName: 'balanceOf', args: [recipient] }) as bigint;
      if (highMinimum) {
        expect(receipt.status).toBe('reverted');
        expect(inputState[0]).toBe(1);
        expect(changeState[0]).toBe(0);
        expect(paid).toBe(false);
        expect(after).toBe(before);
        const operation = await history.getOperationSuccess(draft.operationId,
          (await history.getFinalizedCheckpoint())!);
        expect(operation.complete && operation.value.executed).toBe(false);
      } else {
        expect(receipt.status).toBe('success');
        expect(inputState[0]).toBe(2);
        expect(changeState[0]).toBe(1);
        expect(paid).toBe(true);
        const logs = parseEventLogs({ abi: adapterAbi, eventName: 'PaymentSucceeded',
          logs: receipt.logs.filter(log => same(log.address, adapter)) });
        expect(after - before).toBe(logs[0]!.args.amountOut);
        const reconciled = await payment.reconcile(record.recordId, ref);
        expect(reconciled.operation.chainOutcome).toBe('finalized-success');
        expect(reconciled.changeUsable).toBe(true);
        const synced = await synchronize(context, { history, keys, owners: [owner.address] }, initial);
        expect(synced.status).toBe('complete');
        if (synced.status === 'complete') {
          expect(synced.utxos.filter(item => item.status === 'available').map(item => item.id))
            .toEqual([draft.outputIds[0]]);
          expect(synced.availableWei).toBe(3_000_000_000_000_000n);
          const spending = await buildOperation({ kind: 2, owner: owner.address,
            amount: 3_000_000_000_000_000n, destination: owner.address,
            explicitIds: [draft.outputIds[0]!] }, context,
          { inputs: synced.utxos, randomSalt: () => randomBytes(32) });
          const signedSpending = { ...spending,
            signature: await authorizeOperation(context, spending.request, signer) };
          const readySpending = await prepareSubmission(signedSpending, { history, keys,
            storage: { saveDraft: async () => 'saved' as const } });
          expect(readySpending.status).toBe('ready');
          if (readySpending.status !== 'ready') throw new Error('change spend preflight failed');
          const sentSpending = await submitPublicOperation(verified, history, wallet, holder.address,
            readySpending.submission);
          expect((await rpc.waitForTransactionReceipt({ hash: sentSpending.attempt.txHash! })).status).toBe('success');
          const spent = await synchronize(context, { history, keys, owners: [owner.address] }, synced);
          expect(spent.status).toBe('complete');
          if (spent.status === 'complete') {
            expect(spent.utxos.find(item => same(item.id, draft.outputIds[0]!))?.status).toBe('spent');
            expect(selectPayInput(spent.utxos.map(item => ({ id: parseBytes32(item.id) as unknown as InputId,
              owner: parseAddress(item.owner), valueWei: item.opening.amount,
              state: item.status === 'available' ? 'available' as const : 'unknown' as const })),
            1n, parseAddress(owner.address))).toBeUndefined();
          }
        }
      }
      const sourceHash = createHash('sha256').update(readFileSync('contracts/src/integration/uniswap/UniswapPaymentAdapter.sol')).digest('hex');
      process.stdout.write(`# payment-client-evidence ${JSON.stringify({ scenario: highMinimum ? 'minimum-failure' : 'payment-success',
        ethereumDependencyCommit,
        poolRuntimeSha256: poolManifest.artifacts.pool, adapterRuntimeSha256: connection.contracts.adapter.runtimeSha256,
        adapterSourceSha256: sourceHash, uniswapArtifactPairHash: uniswap.pairInitCodeHash,
        uniswapSourceCommits: uniswap.provenance.commits,
        adapterCompiler: artifact.metadata.compiler.version,
        chainId: 31337, hardfork: 'cancun', finality: 'local-simulated/latest',
        blockHash: receipt.blockHash, operationId: draft.operationId, paymentId })}\n`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

it('Pay submits through the real Adapter, reconciles finality, and receives change through core',
  async () => runPayment(false), 180_000);
it('a too-high minimum reverts the whole Pay without consuming the input',
  async () => runPayment(true), 180_000);
