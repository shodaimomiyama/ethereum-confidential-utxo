import { expect, it } from 'vitest';
import { createManualClock, createMemoryStore, createMockHttp } from '../src/testing/index.js';
import { httpScenarios } from '../src/testing/fixtures.js';
import { assertHttpConformance } from '../src/testing/conformance.js';

it('declares the required transport and storage failure fixtures', () => {
  for (const id of [
    'challenge/reuse', 'challenge/expiry', 'session/expiry',
    'operation/ack-lost', 'operation/revision-conflict', 'operation/pay-withdraw-conflict',
    'reward/ack-lost', 'reward/duplicate-id', 'reward/pending-other-id',
    'reward/owner-isolation', 'storage/unavailable', 'storage/rollback', 'storage/partial-rollback',
  ]) {
    expect(httpScenarios.some((scenario) => scenario.id === id), id).toBe(true);
  }
});

it('runs the HTTP contract scenarios against a supplied transport and store driver', async () => {
  await assertHttpConformance((scenario) => {
    const store = createMemoryStore(scenario.seed);
    const clock = createManualClock(0);
    const mock = createMockHttp({ store, clock });
    return { transport: mock.fetch, store, clock, rejectAuth: mock.control.rejectNextAuth };
  });
});
