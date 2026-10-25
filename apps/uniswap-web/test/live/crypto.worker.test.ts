import { afterEach, expect, it, vi } from 'vitest';
import type { Scope } from '@confidential-utxo/uniswap';
import { buildOperation } from '@confidential-utxo/core';
import type { CryptoJob, CryptoReply } from '../../src/live/worker-protocol.js';

vi.mock('@confidential-utxo/core', () => ({ buildOperation: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('delegates core inputs with Worker CSPRNG salt and strips all private exception data from replies', async () => {
  const postMessage = vi.fn();
  vi.stubGlobal('postMessage', postMessage); vi.stubGlobal('onmessage', null);
  const secureRandom = vi.spyOn(globalThis.crypto, 'getRandomValues');
  const scope = { deploymentId: 'local', owner: `0x${'11'.repeat(20)}` } as Scope;
  const job: Extract<CryptoJob, { kind: 'build-operation' }> = {
    kind: 'build-operation', scope, epoch: 7, jobId: 'private-build', payload: {
      intent: { kind: 2, owner: scope.owner, amount: 12n, destination: scope.owner },
      context: { chainId: 31337n, pool: scope.owner, verifier: scope.owner, deploymentBlock: 0n,
        parametersHash: `0x${'22'.repeat(32)}`, finalityMode: 'local-simulated' }, inputs: [],
    },
  };
  vi.mocked(buildOperation).mockImplementation(async (intent, context, dependencies) => {
    expect(intent).toBe(job.payload.intent); expect(context).toBe(job.payload.context); expect(dependencies.inputs).toBe(job.payload.inputs);
    const salt = dependencies.randomSalt();
    expect(salt).toBeInstanceOf(Uint8Array); expect(salt).toHaveLength(32);
    expect(secureRandom).toHaveBeenCalledWith(salt);
    throw Object.assign(new Error('secret opening and recipient'), { payload: job.payload });
  });
  await import('../../src/live/crypto.worker.js');
  const handle = globalThis.onmessage as unknown as (event: MessageEvent<CryptoJob>) => Promise<void>;
  await handle({ data: job } as MessageEvent<CryptoJob>);
  expect(buildOperation).toHaveBeenCalledOnce();
  const expected: CryptoReply = { kind: 'error', jobKind: 'build-operation', scope, epoch: 7, jobId: 'private-build', code: 'CRYPTO_FAILED' };
  expect(postMessage.mock.calls).toEqual([[expected]]);
});
