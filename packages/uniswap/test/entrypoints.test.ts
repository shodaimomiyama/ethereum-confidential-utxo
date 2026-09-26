import { expect, it } from 'vitest';
import { contractVersion } from '../src/index.js';
import { createManualClock } from '../src/testing/clock.js';

it('exposes the contract version and a controllable clock', () => {
  expect(contractVersion).toBe('1');
  const clock = createManualClock(1);
  expect(clock.now()).toBe(1);
  clock.set(2);
  expect(clock.now()).toBe(2);
});
