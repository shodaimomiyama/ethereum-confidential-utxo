import { expect, it } from 'vitest';
import { scenarios, runUiScenario } from '../src/mock/scenario-catalog.js';
import { createMockUiController } from '../src/mock/controller.js';
import { createMemoryStore, createManualClock } from '@confidential-utxo/uniswap/testing';
import type { Scope } from '@confidential-utxo/uniswap';

const scope = { deploymentId: 'local-v1', owner: `0x${'11'.repeat(20)}` } as Scope;

it('maps each required specification row to an executable case', () => {
  for (let n = 25; n <= 48; n += 1) {
    expect(scenarios.some((scenario) => scenario.specIds.includes(`S-${n}`)), `S-${n}`).toBe(true);
  }
  for (let n = 3; n <= 8; n += 1) {
    expect(scenarios.some((scenario) => scenario.specIds.includes(`S-${String(n).padStart(2, '0')}`)), `S-${n}`).toBe(true);
  }
  for (const scenario of scenarios) {
    expect(scenario.steps.length, scenario.id).toBeGreaterThan(0);
    expect(scenario.expected.allowedActions.length + scenario.expected.forbiddenActions.length, scenario.id).toBeGreaterThan(0);
  }
});

it('runs every case against the public controller contract and its testing driver', async () => {
  for (const scenario of scenarios) {
    const store = createMemoryStore(scenario.seed);
    const clock = createManualClock(0);
    const controller = createMockUiController({ scope, store, clock, scenario: scenario.initialScenario });
    await runUiScenario(scenario, { controller, driver: controller.control, clock, store });
  }
});

it('rejects an adapter that reports unknown Pay as success', async () => {
  const scenario = scenarios.find((item) => item.id === 'S-27/rpc-down');
  if (scenario === undefined) throw new Error('missing fixture');
  const store = createMemoryStore();
  const clock = createManualClock(0);
  const mock = createMockUiController({ scope, store, clock, scenario: scenario.initialScenario });
  await expect(runUiScenario(scenario, {
    controller: {
      ...mock,
      snapshot() {
        const state = mock.snapshot();
        return { ...state, operations: state.operations.map((operation) => ({ ...operation, chainOutcome: 'finalized-success' as const })) };
      },
    },
    driver: mock.control,
    clock,
    store,
  })).rejects.toThrowError(/outcome/);
});
