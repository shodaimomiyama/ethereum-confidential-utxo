import type { Scope } from '@confidential-utxo/uniswap';
import type { UiAction } from '../contracts/controller.js';

export type RecordedStep =
  | { readonly kind: 'action'; readonly action: UiAction }
  | { readonly kind: 'advance' };

export function encodeSession(scope: Scope, steps: readonly RecordedStep[]): string {
  return JSON.stringify({ version: 2, scope, steps });
}

export function decodeSession(serialized: string, scope: Scope): readonly RecordedStep[] {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 2) {
    throw new Error('Unsupported mock session version');
  }
  if (!('steps' in parsed) || !Array.isArray(parsed.steps) || parsed.steps.some((step: unknown) =>
    typeof step !== 'object' || step === null || !('kind' in step)
    || (step.kind !== 'advance' && (step.kind !== 'action' || !('action' in step)
      || typeof step.action !== 'object' || step.action === null
      || !('type' in step.action) || typeof step.action.type !== 'string')))) {
    throw new Error('Malformed mock session steps');
  }
  if (!('scope' in parsed) || typeof parsed.scope !== 'object' || parsed.scope === null
    || !('deploymentId' in parsed.scope) || parsed.scope.deploymentId !== scope.deploymentId
    || !('owner' in parsed.scope) || parsed.scope.owner !== scope.owner) {
    throw new Error('Mock session scope mismatch');
  }
  return parsed.steps as RecordedStep[];
}
