import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateCaseResults, writePublicEvidence } from "../../../scripts/core-evidence.mjs";
import { convertVitestResults, convertFoundryResults, convertTapResults } from "../../../scripts/core-local.mjs";

const expected = [{ caseId: "S-01-deposit" }];
const safe = () => ({ schemaVersion: 1, caseId: "S-01-deposit", operationOutcome: "success",
  testOutcome: "pass", commit: "2e11fab178c5e64ae8b4e80460fb679850dd895d",
  artifactHashes: { pool: "ab".repeat(32) },
  environment: { os: "darwin", arch: "arm64", node: "24.21.0", pnpm: "10.34.5", foundry: "1.8.3" },
  evidence: { kind: "transaction", source: "tests/integration/core/flow.test.ts", testName: "S-01-deposit",
    transactions: [{ operationId: `0x${"11".repeat(32)}`, txHash: `0x${"22".repeat(32)}`,
      blockNumber: "5", blockHash: `0x${"33".repeat(32)}`, gasUsed: "123456", status: "success" }] } });

test("rejects missing, duplicate and not-run case results", () => {
  assert.throws(() => validateCaseResults(expected, []));
  assert.throws(() => validateCaseResults(expected, [safe(), safe()]));
  assert.throws(() => validateCaseResults(expected, [{ ...safe(), testOutcome: "not-run" }]));
});

test("rejects incomplete transaction and rejection evidence", () => {
  const noGas = safe();
  delete noGas.evidence.transactions[0].gasUsed;
  assert.throws(() => validateCaseResults(expected, [noGas]));
  const rejected = { ...safe(), operationOutcome: "rejected",
    evidence: { kind: "rejection", source: "tests/integration/core/rejection.test.ts",
      testName: "S-01-deposit", errorSelector: "0x12345678" } };
  assert.throws(() => validateCaseResults(expected, [rejected]));
});

test("S-16-calldata rejects private fields and naked RPC credentials", () => {
  for (const evidence of [
    { ...safe().evidence, rawCalldata: "0x1234" },
    { ...safe().evidence, packet: "0x1234" },
    { ...safe().evidence, rpcUrl: "https://user:password@example.test" },
  ]) assert.throws(() => validateCaseResults(expected, [{ ...safe(), evidence }]));
});

test("S-16-events rejects plaintext openings in public event metadata", () => {
  const event = { ...safe().evidence, eventName: "OutputCreated", opening: { amount: "123" } };
  assert.throws(() => validateCaseResults(expected, [{ ...safe(), evidence: event }]));
});

test("S-16-cli-json rejects private CLI amount and passphrase", () => {
  for (const evidence of [
    { ...safe().evidence, availableWei: "123" },
    { ...safe().evidence, testName: "passphrase=secret" },
  ]) assert.throws(() => validateCaseResults(expected, [{ ...safe(), evidence }]));
});

test("S-16-public-results writes a new private-mode sanitized file and refuses overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-evidence-"));
  try {
    const path = join(root, "result.json");
    await writePublicEvidence(path, [safe()]);
    const value = JSON.parse(await readFile(path, "utf8"));
    assert.equal(value[0].caseId, "S-01-deposit");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writePublicEvidence(path, [safe()]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("binds grouped Vitest IDs to their actual test file and rejects skip or unknown IDs", () => {
  const cases = ["S-01-deposit", "S-03-partial-transfer"].map(caseId => ({ caseId,
    evidenceRef: "tests/integration/core/flow.test.ts" }));
  const report = { testResults: [{ name: "/repo/tests/integration/core/flow.test.ts",
    assertionResults: [{ fullName: "S-01-deposit S-03-partial-transfer", status: "passed" }] }] };
  assert.equal(convertVitestResults(cases, report, "/repo").length, 2);
  assert.throws(() => convertVitestResults(cases, { testResults: [{ ...report.testResults[0],
    assertionResults: [{ fullName: "S-01-deposit", status: "pending" }] }] }, "/repo"));
  assert.equal(convertVitestResults(cases, { testResults: [{ ...report.testResults[0],
    assertionResults: [{ fullName: "S-01-deposit", status: "pending" }] }] }, "/repo",
  { strict: false })[0].status, "pending");
  assert.throws(() => convertVitestResults(cases, { testResults: [{ ...report.testResults[0],
    assertionResults: [{ fullName: "S-01-unknown", status: "passed" }] }] }, "/repo"));
});

test("binds Foundry function names and Node TAP names without treating missing tests as passes", () => {
  const foundry = [{ caseId: "S-12-donation", runner: "foundry", evidenceRef: "contracts/test/PoolWithdrawal.t.sol",
    testName: "test_ordinaryReceiveDoesNotMint" }];
  const report = { "test/PoolWithdrawal.t.sol:PoolWithdrawalTest": { test_results: {
    "test_ordinaryReceiveDoesNotMint()": { status: "Success", kind: { Unit: { gas: 1234 } } },
  } } };
  assert.equal(convertFoundryResults(foundry, report)[0].foundryGas, "1234");
  assert.throws(() => convertFoundryResults(foundry, {}));
  assert.equal(convertFoundryResults(foundry, {}, { strict: false })[0].status, "skipped");
  const tap = "TAP version 13\nok 1 - S-16-calldata rejects raw data\nnot ok 2 - S-16-events rejects openings\n";
  assert.deepEqual(convertTapResults(tap), [
    { caseId: "S-16-calldata", status: "passed", testName: "S-16-calldata rejects raw data" },
    { caseId: "S-16-events", status: "failed", testName: "S-16-events rejects openings" },
  ]);
});
