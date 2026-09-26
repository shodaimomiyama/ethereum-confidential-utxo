import { test, expect } from 'vitest';
import { runEnvironmentRpcSmoke } from '../../scripts/environment-rpc.ts';

test('deploys the compiled fixture and reads 42 through its generated ABI', async () => {
  const result = await runEnvironmentRpcSmoke('http://127.0.0.1:18545');
  expect(result.answer).toBe(42n);
  expect(result.chainId).toBe(31337);
  expect(result.runtimeMatched).toBe(true);
});
