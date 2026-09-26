import { expect, it } from 'vitest';
import { allowedFor, isActionAllowed } from '../src/contracts/controller.js';
import type { UiAction } from '../src/contracts/controller.js';

const operationId = ('0x' + '11'.repeat(32)) as never;

it('permits rechecking an unknown result without allowing another start', () => {
  const action: UiAction = { type: 'recheck', operationId };
  const state = { allowedActions: ['recheck'] } as const;
  expect(isActionAllowed(state, action)).toBe(true);
  expect(isActionAllowed(state, { type: 'start', card: 'pay' })).toBe(false);
  expect(isActionAllowed(state, { type: 'retry-attempt', operationId })).toBe(false);
});

it('does not treat one card start permission as permission for another card', () => {
  const state = { allowedActions: ['start:deposit'] } as const;
  expect(isActionAllowed(state, { type: 'start', card: 'deposit' })).toBe(true);
  expect(isActionAllowed(state, { type: 'start', card: 'pay' })).toBe(false);
});

it('does not show a retry button for a different operation', () => {
  const otherId = ('0x' + '22'.repeat(32)) as never;
  const state = {
    allowedActions: ['retry-attempt'],
    operationActions: { [operationId]: ['retry-attempt'] },
  } as never;
  expect(allowedFor(state, { type: 'retry-attempt', operationId })).toBe(true);
  expect(allowedFor(state, { type: 'retry-attempt', operationId: otherId })).toBe(false);
});
