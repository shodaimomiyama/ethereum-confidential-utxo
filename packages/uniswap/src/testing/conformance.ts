import type { ApiTransport } from '../api.js';
import { parseApiRequest, parseApiResponse } from '../api.js';
import type { ManualClock } from './clock.js';
import type { HttpScenario, HttpStep } from './fixtures.js';
import {
  fixtureOtherOwner,
  fixtureScope,
  httpScenarios,
} from './fixtures.js';
import type { StoreControl } from './store.js';

const syntheticSignature = `0x${'aa'.repeat(65)}`;

export interface HttpScenarioHarness {
  readonly transport: ApiTransport;
  readonly clock: ManualClock;
  readonly store: { readonly control: StoreControl };
  rejectAuth(reason: 'wrong-domain' | 'wrong-chain' | 'wrong-owner' | 'invalid-signature'): void;
}

function request(path: string, method: string, body?: unknown, cookie?: string): Request {
  return new Request(`https://mock.invalid${path}`, {
    method,
    headers: {
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

export async function runHttpScenario(scenario: HttpScenario, harness: HttpScenarioHarness): Promise<void> {
  const { transport, clock, store } = harness;
  let scope = fixtureScope;
  let cookie: string | undefined;
  let challengeId: string | undefined;

  async function challenge(): Promise<void> {
    const response = await transport(request('/v1/auth/challenge', 'POST', { scope }));
    assertEqual(response.status, 200, `${scenario.id} challenge`);
    const body = await response.json() as { challengeId: string };
    parseApiResponse('POST /v1/auth/challenge', response.status, body);
    challengeId = body.challengeId;
  }

  async function verify(expectedStatus: number, expectedCode?: string): Promise<void> {
    if (challengeId === undefined) throw new Error(`${scenario.id}: challenge missing`);
    const response = await transport(request('/v1/auth/verify', 'POST', {
      scope, challengeId, siweMessage: 'synthetic SIWE', signature: syntheticSignature,
    }));
    assertEqual(response.status, expectedStatus, `${scenario.id} verify status`);
    const body = await response.json() as { error?: { code: string } };
    parseApiResponse('POST /v1/auth/verify', response.status, body);
    if (expectedCode !== undefined) assertEqual(body.error?.code, expectedCode, `${scenario.id} verify code`);
    if (expectedStatus === 200) cookie = response.headers.get('set-cookie')?.split(';')[0];
  }

  if (scenario.autoLogin) {
    await challenge();
    await verify(200);
  }

  for (const step of scenario.steps) {
    if (step.kind === 'challenge') await challenge();
    else if (step.kind === 'verify') await verify(step.status, step.code);
    else if (step.kind === 'clock') clock.set(step.at);
    else if (step.kind === 'reject-auth') harness.rejectAuth(step.reason);
    else if (step.kind === 'lose-ack') store.control.loseNextAck(step.route);
    else if (step.kind === 'unavailable') store.control.setUnavailable(true);
    else if (step.kind === 'rollback') store.control.simulateRollback();
    else if (step.kind === 'partial-rollback') store.control.simulateRollback('partial');
    else if (step.kind === 'login-other') {
      scope = { deploymentId: fixtureScope.deploymentId, owner: fixtureOtherOwner as never };
      await challenge();
      await verify(200);
    } else {
      await runRequest(step, cookie, transport, scenario.id);
    }
  }

  const entries = store.control.journal();
  assertEqual(entries.filter((entry) => entry.kind === 'operation-put').length, scenario.expected.reservations, `${scenario.id} reservations`);
  assertEqual(entries.filter((entry) => entry.kind === 'reward-create').length, scenario.expected.requests, `${scenario.id} requests`);
  assertEqual(entries.filter((entry) => entry.kind === 'reward-received').length, scenario.expected.receipts, `${scenario.id} receipts`);
}

async function runRequest(
  step: Extract<HttpStep, { readonly kind: 'request' }>,
  cookie: string | undefined,
  transport: ApiTransport,
  scenarioId: string,
): Promise<void> {
  const outbound = request(step.path, step.method, step.body, cookie);
  const route = parseApiRequest(step.method, step.path, step.body).route;
  if (step.reject !== undefined) {
    try {
      await transport(outbound);
    } catch (error) {
      if (error instanceof Error && error.message.includes(step.reject)) return;
      throw new Error(`${scenarioId}: wrong rejection`);
    }
    throw new Error(`${scenarioId}: expected ${step.reject} rejection`);
  }
  const response = await transport(outbound);
  assertEqual(response.status, step.status ?? 200, `${scenarioId} ${step.method} ${step.path} status`);
  const body = await response.json() as Record<string, unknown>;
  parseApiResponse(route, response.status, body);
  if (step.code !== undefined) {
    const error = body.error as { code?: string } | undefined;
    assertEqual(error?.code, step.code, `${scenarioId} error code`);
  }
  if (step.recordId !== undefined) {
    const records = body.records as { record: { recordId: string } }[] | undefined;
    assertEqual(records?.[0]?.record.recordId, step.recordId, `${scenarioId} recovered record`);
  }
  if (step.recordsLength !== undefined) {
    const records = body.records as unknown[] | undefined;
    assertEqual(records?.length, step.recordsLength, `${scenarioId} record count`);
  }
  if (step.requestId !== undefined) {
    const rewards = body.rewards as { requestId: string }[] | undefined;
    assertEqual(rewards?.[0]?.requestId, step.requestId, `${scenarioId} recovered reward`);
  }
}

export async function assertHttpConformance(
  factory: (scenario: HttpScenario) => HttpScenarioHarness | Promise<HttpScenarioHarness>,
): Promise<void> {
  for (const scenario of httpScenarios) {
    await runHttpScenario(scenario, await factory(scenario));
  }
}
