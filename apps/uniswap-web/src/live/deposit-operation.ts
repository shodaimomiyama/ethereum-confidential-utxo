import { recipientInfoTypedData, verifyRecipientInfo } from '@confidential-utxo/core';
import { parseEthAmount, type OperationId, type Scope, type TxHash } from '@confidential-utxo/uniswap';
import type { Hex } from 'viem';
import type { ViewState } from '../contracts/index.js';
import { createDepositCoordinator, type DepositDependencies, type DepositResult, type PreparedDeposit } from './deposit.js';
import { sameScope } from './http.js';
import type { OperationContext, OperationPort, OperationResult, PreparedOperation, PreparationResult } from './operations.js';

export interface DepositOperationDependencies {
  /** The serialized controller's current public display, scoped to this action. */
  readonly snapshot: () => ViewState;
  /** Production bindings for verified deployment, durable draft storage and attempt gate. */
  readonly createDependencies: (context: OperationContext) => Omit<DepositDependencies, 'context'>;
}

export interface DepositOperation extends Pick<OperationPort, 'prepareDeposit' | 'completePreparation' | 'authorize'> {
  /** Public identifiers for this captured action; never exposes the prepared secret draft. */
  outputIds(context: OperationContext, operationId: OperationId): readonly Hex[] | undefined;
}

interface PrivateHandle {
  readonly context: OperationContext;
  readonly coordinator: ReturnType<typeof createDepositCoordinator>;
  readonly prepared: PreparedDeposit;
  used: boolean;
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const validHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const validSignature = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);
const outputKey = (scope: Scope, operationId: OperationId): string =>
  JSON.stringify([scope.deploymentId, scope.owner.toLowerCase(), operationId.toLowerCase()]);

function check(scope: Scope, context: OperationContext, snapshot: ViewState): void {
  context.check();
  if (!sameScope(scope, context.scope) || !sameScope(scope, snapshot.scope)) throw new Error('SCOPE_CHANGED');
}

function reason(result: DepositResult): ViewState['cards']['deposit']['reason'] {
  if (result.status !== 'not-submitted') return 'RESULT_UNKNOWN';
  if (result.reason === 'insufficient-public-eth') return 'GAS_REQUIRED';
  if (result.reason === 'signature-rejected' || result.reason === 'authorization-required') return 'NOT_ALLOWED';
  if (result.reason === 'invalid') return 'INPUT_INVALID';
  return 'RESULT_UNKNOWN';
}

function matches(prepared: PreparedDeposit, result: DepositResult): boolean {
  return same(prepared.operationId, result.operationId) && prepared.outputIds.length === result.outputIds.length &&
    prepared.outputIds.every((id, index) => same(id, result.outputIds[index]!));
}

/** One deposit action; the coordinator owns all core preflight, signing and durable send gates. */
export function createDepositOperation(deps: DepositOperationDependencies): DepositOperation {
  const handles = new WeakMap<object, PrivateHandle>();
  const outputs = new Map<string, { readonly epoch: number; readonly ids: readonly Hex[] }>();

  function unwrap(prepared: PreparedOperation, context: OperationContext): PrivateHandle {
    context.check();
    if (typeof prepared.handle !== 'object' || prepared.handle === null) throw new Error('INVALID_DEPOSIT_HANDLE');
    const saved = handles.get(prepared.handle);
    if (!saved || prepared.card !== 'deposit' || saved.context !== context ||
      prepared.operationId !== saved.prepared.operationId || !sameScope(prepared.scope, saved.prepared.scope) ||
      !sameScope(context.scope, saved.prepared.scope) || context.epoch !== saved.prepared.epoch) {
      throw new Error('INVALID_DEPOSIT_HANDLE');
    }
    check(prepared.scope, context, deps.snapshot());
    return saved;
  }

  function project(prepared: PreparedDeposit, response: DepositResult | undefined, context: OperationContext): OperationResult {
    const snapshot = deps.snapshot();
    check(prepared.scope, context, snapshot);
    const trustworthy = response !== undefined && matches(prepared, response);
    const pending = trustworthy && response.status === 'pending' && validHash(response.txHash);
    const hash = trustworthy && response.status !== 'not-submitted' && validHash(response.txHash) ? response.txHash : undefined;
    const operation = { scope: prepared.scope, operationId: prepared.operationId, attemptIds: [],
      txHashes: hash ? [hash as TxHash] : [], chainOutcome: pending ? 'pending' as const : 'unknown' as const,
      receiptState: 'none' as const };
    const card = { ...snapshot.cards.deposit, phase: pending ? 'pending' as const : 'unknown' as const,
      reason: pending ? undefined : trustworthy ? reason(response) : 'RESULT_UNKNOWN' as const,
      approvalPurpose: undefined };
    return { scope: prepared.scope, operation, card: 'deposit', view: { ...snapshot,
      cards: { ...snapshot.cards, deposit: card },
      operations: [...snapshot.operations.filter(item => !same(item.operationId, prepared.operationId)), operation],
      operationCards: { ...snapshot.operationCards, [prepared.operationId]: 'deposit' },
      operationActions: { ...snapshot.operationActions, [prepared.operationId]: ['recheck'] },
      allowedActions: snapshot.allowedActions.filter(action => action !== 'start:deposit'),
      reasons: { ...snapshot.reasons, 'start:deposit': 'RESULT_UNKNOWN' },
    } };
  }

  return {
    outputIds: (context, operationId) => {
      check(context.scope, context, deps.snapshot());
      const found = outputs.get(outputKey(context.scope, operationId));
      return found?.epoch === context.epoch ? [...found.ids] : undefined;
    },
    async prepareDeposit(scope, input, context) {
      check(scope, context, deps.snapshot());
      const amount = parseEthAmount(input.amount ?? '');
      const bound = deps.createDependencies(context);
      const verified = bound.resolveVerified(scope.deploymentId);
      if (!verified) throw new Error('SCOPE_CHANGED');
      const unsigned = context.recipientInfo();
      const typed = recipientInfoTypedData(verified.context, unsigned, scope.owner);
      const signed = await context.typedSign(typed, 'recipient-info');
      check(scope, context, deps.snapshot());
      if (signed.epoch !== context.epoch || !sameScope(signed.scope, scope)) throw new Error('SCOPE_CHANGED');
      if (!validSignature(signed.value)) throw new Error('INVALID_RECIPIENT_SIGNATURE');
      const recipient = { ...unsigned, signature: signed.value };
      await verifyRecipientInfo(verified.context, recipient, scope.owner);
      check(scope, context, deps.snapshot());
      const coordinator = createDepositCoordinator({ ...bound, context });
      const deposit = await coordinator.prepare(amount, recipient);
      check(scope, context, deps.snapshot());
      if (!sameScope(deposit.scope, scope) || deposit.epoch !== context.epoch || !validHash(deposit.operationId) ||
        deposit.outputIds.length !== 1 || deposit.outputIds.some(id => !validHash(id))) throw new Error('INVALID_DEPOSIT');
      const token = Object.freeze({});
      handles.set(token, { context, coordinator, prepared: deposit, used: false });
      outputs.set(outputKey(scope, deposit.operationId), { epoch: context.epoch, ids: [...deposit.outputIds] });
      return { scope, card: 'deposit', operationId: deposit.operationId, handle: token };
    },
    async completePreparation(prepared: PreparedOperation, proof, context): Promise<PreparationResult> {
      unwrap(prepared, context);
      if (proof !== undefined || prepared.proof !== undefined) throw new Error('INVALID_DEPOSIT_PROOF');
      return { kind: 'prepared', prepared };
    },
    async authorize(prepared: PreparedOperation, context): Promise<OperationResult> {
      const saved = unwrap(prepared, context);
      if (saved.used) throw new Error('OPERATION_ALREADY_AUTHORIZED');
      saved.used = true;
      let response: DepositResult | undefined;
      try {
        response = await saved.coordinator.authorizeAndSubmit(saved.prepared, true);
      } catch (error) {
        context.check();
        if (error instanceof Error && error.message === 'SCOPE_CHANGED') throw error;
      }
      context.check();
      return project(saved.prepared, response, context);
    },
  };
}
