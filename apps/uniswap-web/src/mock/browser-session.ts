import type { UiAction } from '../contracts/controller.js';

export type RecordedStep =
  | { readonly kind: 'action'; readonly action: UiAction }
  | { readonly kind: 'advance' };

export function encodeSession(steps: readonly RecordedStep[]): string {
  return JSON.stringify({ version: 1, steps });
}

export function decodeSession(serialized: string): readonly RecordedStep[] {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1) {
    throw new Error('Unsupported mock session version');
  }
  if (!('steps' in parsed) || !Array.isArray(parsed.steps) || parsed.steps.some((step: unknown) =>
    typeof step !== 'object' || step === null || !('kind' in step)
    || (step.kind !== 'advance' && (step.kind !== 'action' || !('action' in step)
      || typeof step.action !== 'object' || step.action === null
      || !('type' in step.action) || typeof step.action.type !== 'string')))) {
    throw new Error('Malformed mock session steps');
  }
  return parsed.steps as RecordedStep[];
}
