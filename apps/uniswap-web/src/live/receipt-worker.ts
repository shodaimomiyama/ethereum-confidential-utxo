import type { ReceiptKeyPort } from '@confidential-utxo/core';
import type { Address } from '@confidential-utxo/uniswap';
import type { OperationContext } from './operations.js';
import { CryptoWorkerError } from './worker-client.js';

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const sameScope = (left: OperationContext['scope'], right: OperationContext['scope']): boolean =>
  left.deploymentId === right.deploymentId && same(left.owner, right.owner);

/** Open receipts only inside the scoped Worker; never expose a plaintext key port. */
export function createWorkerReceiptKeyPort(context: OperationContext): ReceiptKeyPort {
  const scope = { ...context.scope };
  const epoch = context.epoch;
  return {
    async openReceipt(owner: Address, input) {
      if (!same(owner, scope.owner)) return { status: 'unavailable' };
      let key: Uint8Array | undefined;
      try {
        context.check();
        if (!sameScope(context.scope, scope) || context.epoch !== epoch) return { status: 'unavailable' };
        key = context.recipientPrivateKeyForWorker();
        if (!(key instanceof Uint8Array) || key.length !== 32) return { status: 'unavailable' };
        const jobId = crypto.randomUUID();
        const reply = await context.runCrypto({ kind: 'receive', jobId, payload: {
          recipientPrivateKey: key, info: input.info, packet: input.packet, commitment: input.commitment,
        } });
        context.check();
        if (!sameScope(context.scope, scope) || context.epoch !== epoch
          || reply.kind !== 'result' || reply.jobKind !== 'receive' || reply.jobId !== jobId
          || reply.epoch !== epoch || !sameScope(reply.scope, scope)
          || typeof reply.value.amount !== 'bigint' || reply.value.amount < 1n
          || typeof reply.value.blinding !== 'bigint' || reply.value.blinding < 0n) return { status: 'unavailable' };
        return { status: 'opened', opening: reply.value };
      } catch (error) {
        try { context.check(); } catch { return { status: 'unavailable' }; }
        return error instanceof CryptoWorkerError && error.code === 'CRYPTO_FAILED'
          ? { status: 'invalid' } : { status: 'unavailable' };
      } finally {
        if (key instanceof Uint8Array) key.fill(0);
      }
    },
  };
}
