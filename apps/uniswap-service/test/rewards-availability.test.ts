import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { classifyRewardFailure, resumeRewardAvailability, rewardAvailability, setRewardAvailability } from '../src/rewards/availability.js';
import { CoreFailure } from '@confidential-utxo/core';
import { EthereumFailure } from '@confidential-utxo/ethereum';
import { initializeEnvironment } from '../src/recovery.js';

it('keeps reward-only and common recovery stops independent', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-availability'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    const healthy = { generation: 'test-g1', stopped: false };
    initializeEnvironment(state.storage, { ...healthy, initialize: true });
    expect(rewardAvailability(state.storage, healthy, 'local-v1')).toMatchObject({
      accept: true, distribute: true, receive: true, reason: 'healthy',
    });
    setRewardAvailability(state.storage, 'local-v1', 'funds-short');
    expect(rewardAvailability(state.storage, healthy, 'local-v1')).toMatchObject({
      accept: false, distribute: false, receive: true, reason: 'funds-short',
    });
    expect(rewardAvailability(state.storage, { ...healthy, stopped: true }, 'local-v1')).toMatchObject({
      accept: false, distribute: false, receive: false, reason: 'restore-stopped',
    });
    setRewardAvailability(state.storage, 'local-v1', 'healthy');
    expect(rewardAvailability(state.storage, { ...healthy, stopped: true }, 'local-v1').receive).toBe(false);
    setRewardAvailability(state.storage, 'local-v1', 'rpc-unavailable');
    expect(rewardAvailability(state.storage, healthy, 'local-v1')).toMatchObject({
      distribute: false, receive: false, reason: 'rpc-unavailable',
    });
    setRewardAvailability(state.storage, 'local-v1', 'quota-stopped');
    expect(rewardAvailability(state.storage, healthy, 'local-v1').receive).toBe(false);
  });
});

it('classifies transient history, funds and gas failures without exposing details', () => {
  expect(classifyRewardFailure(new Error('REWARD_FUNDS_UNKNOWN'))).toBe('rpc-unavailable');
  expect(classifyRewardFailure(new CoreFailure('INSUFFICIENT', 'selection'))).toBe('funds-short');
  expect(classifyRewardFailure(new EthereumFailure('SIMULATION_FAILED', 'submission.balance')))
    .toBe('gas-short');
  expect(classifyRewardFailure(new Error('private key details'))).toBe('operator-stopped');
});

it('requires operator evidence and the healthy external generation before resuming', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-availability-resume'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    const healthy = { generation: 'test-g1', stopped: false };
    initializeEnvironment(state.storage, { ...healthy, initialize: true });
    setRewardAvailability(state.storage, 'local-v1', 'funds-short');
    expect(() => resumeRewardAvailability(state.storage, { ...healthy, stopped: true },
      'local-v1', true, { fundsReady: true })).toThrow('SERVICE_UNAVAILABLE');
    expect(() => resumeRewardAvailability(state.storage, healthy, 'local-v1', true,
      { fundsReady: false })).toThrow('REWARD_RESUME_EVIDENCE');
    expect(() => resumeRewardAvailability(state.storage, healthy, 'local-v1', true,
      { fundsReady: true })).not.toThrow();
    setRewardAvailability(state.storage, 'local-v1', 'restore-stopped');
    expect(() => resumeRewardAvailability(state.storage, healthy, 'local-v1', true,
      { recordsComplete: false, chainReconciled: true, keysReadable: true, attemptsChecked: true }))
      .toThrow('REWARD_RESUME_EVIDENCE');
  });
});

it('keeps restore and operator stops when a later transient RPC failure is recorded', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-availability-overlap'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    const gate = { generation: 'test-g1', stopped: false };
    initializeEnvironment(state.storage, { ...gate, initialize: true });
    setRewardAvailability(state.storage, 'local-v1', 'restore-stopped');
    setRewardAvailability(state.storage, 'local-v1', 'operator-stopped');
    setRewardAvailability(state.storage, 'local-v1', 'rpc-unavailable');
    expect(rewardAvailability(state.storage, gate, 'local-v1').reason).toBe('restore-stopped');
    expect(() => resumeRewardAvailability(state.storage, gate, 'local-v1', true, {}))
      .toThrow('REWARD_RESUME_EVIDENCE');
    resumeRewardAvailability(state.storage, gate, 'local-v1', true,
      { recordsComplete: true, chainReconciled: true, keysReadable: true, attemptsChecked: true });
    expect(rewardAvailability(state.storage, gate, 'local-v1').reason).toBe('operator-stopped');
  });
});

it('does not let RPC recovery clear a separate funds shortage', async () => {
  const ns = (env as unknown as { UNISWAP_STATE: DurableObjectNamespace }).UNISWAP_STATE;
  const stub = ns.get(ns.idFromName('reward-availability-transient-overlap'));
  await stub.fetch('https://site.test/v1/operations');
  await runInDurableObject(stub, (_object, state) => {
    const gate = { generation: 'test-g1', stopped: false };
    initializeEnvironment(state.storage, { ...gate, initialize: true });
    setRewardAvailability(state.storage, 'local-v1', 'funds-short');
    setRewardAvailability(state.storage, 'local-v1', 'rpc-unavailable');
    setRewardAvailability(state.storage, 'local-v1', 'healthy');
    expect(rewardAvailability(state.storage, gate, 'local-v1').reason).toBe('funds-short');
    expect(() => resumeRewardAvailability(state.storage, gate, 'local-v1', true, {}))
      .toThrow('REWARD_RESUME_EVIDENCE');
  });
});
