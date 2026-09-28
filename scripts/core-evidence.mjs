import { writeFile } from "node:fs/promises";

/** @typedef {{ schemaVersion: 1, caseId: string, operationOutcome: "success" | "rejected" | "rolled-back" | "unconfirmed" | "unavailable", testOutcome: "pass" | "fail" | "not-run", commit: string, artifactHashes: Record<string, string>, environment: { os: string, arch: string, node: string, pnpm: string, foundry: string, memoryBytes?: string }, evidence: Record<string, unknown> }} CaseResult */

const hex32 = /^0x[0-9a-f]{64}$/i;
const hex4 = /^0x[0-9a-f]{8}$/i;
const decimal = /^(0|[1-9]\d*)$/;
const sourcePath = /^(?:(?:tests\/integration\/core\/|contracts\/test\/)[a-zA-Z0-9/_-]+\.(?:test\.ts|test\.mjs|t\.sol)|scripts\/core-sepolia\.mjs)$/;
const outcomes = new Set(["success", "rejected", "rolled-back", "unconfirmed", "unavailable"]);
const testOutcomes = new Set(["pass", "fail", "not-run"]);
const evidenceKinds = new Set(["test", "foundry", "transaction", "rejection"]);
const evidenceKeys = new Set(["kind", "source", "testName", "transactions", "errorSelector", "blockNumber",
  "blockHash", "txHash", "operationId", "gasUsed", "status", "foundryGas", "eventName",
  "calldataSha256", "from", "valueWei"]);
const unsafeText = /https?:\/\/|(?:passphrase|private.?key|recipientPrivateKey|opening|blinding|amountWei|rpcUrl|rawCalldata|secret)\s*[:=]/i;
const knownKeys = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"42".repeat(32)}`,
];
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function requireShape(condition, stage) { if (!condition) throw new Error(`invalid public evidence: ${stage}`); }
function exactKeys(value, allowed, required, stage) {
  requireShape(plain(value), stage);
  for (const key of Object.keys(value)) requireShape(allowed.has(key), `${stage}.${key}`);
  for (const key of required) requireShape(Object.hasOwn(value, key), `${stage}.${key}`);
}
function cleanText(value, stage) {
  requireShape(typeof value === "string" && value.length > 0 && value.length <= 500, stage);
  requireShape(!unsafeText.test(value), stage);
  for (const key of knownKeys) requireShape(!value.toLowerCase().includes(key), stage);
  return value;
}
function publicTransaction(value) {
  exactKeys(value, new Set(["operationId", "txHash", "blockNumber", "blockHash", "gasUsed", "status"]),
    ["operationId", "txHash", "blockNumber", "blockHash", "gasUsed", "status"], "transaction");
  requireShape(hex32.test(value.operationId) && hex32.test(value.txHash) && hex32.test(value.blockHash), "transaction.hash");
  requireShape(decimal.test(value.blockNumber) && decimal.test(value.gasUsed), "transaction.number");
  requireShape(["success", "reverted"].includes(value.status), "transaction.status");
  for (const field of ["operationId", "txHash", "blockHash"]) cleanText(value[field], `transaction.${field}`);
  return { operationId: value.operationId, txHash: value.txHash, blockNumber: value.blockNumber,
    blockHash: value.blockHash, gasUsed: value.gasUsed, status: value.status };
}
function publicEvidence(value) {
  exactKeys(value, evidenceKeys, ["kind", "source", "testName"], "evidence");
  requireShape(evidenceKinds.has(value.kind), "evidence.kind");
  requireShape(sourcePath.test(value.source), "evidence.source");
  cleanText(value.testName, "evidence.testName");
  if (value.transactions !== undefined)
    requireShape(Array.isArray(value.transactions) && value.transactions.length > 0, "evidence.transactions");
  const transactions = value.transactions?.map(publicTransaction);
  for (const field of ["txHash", "operationId", "blockHash"]) {
    if (value[field] !== undefined) requireShape(hex32.test(value[field]), `evidence.${field}`);
  }
  for (const field of ["blockNumber", "gasUsed", "foundryGas"]) {
    if (value[field] !== undefined) requireShape(decimal.test(value[field]), `evidence.${field}`);
  }
  if (value.errorSelector !== undefined) {
    requireShape(hex4.test(value.errorSelector) && decimal.test(value.blockNumber) &&
      hex32.test(value.blockHash), "evidence.rejection");
  }
  if (value.calldataSha256 !== undefined) requireShape(/^[0-9a-f]{64}$/i.test(value.calldataSha256), "evidence.calldataSha256");
  if (value.from !== undefined) requireShape(/^0x[0-9a-f]{40}$/i.test(value.from), "evidence.from");
  if (value.valueWei !== undefined) requireShape(decimal.test(value.valueWei), "evidence.valueWei");
  if (value.kind === "rejection") requireShape(value.errorSelector !== undefined, "evidence.rejection");
  if (value.kind === "transaction") requireShape(transactions?.length > 0, "evidence.transaction");
  if (value.kind === "foundry") requireShape(value.foundryGas !== undefined, "evidence.foundry");
  if (value.eventName !== undefined) requireShape(["OutputCreated", "OperationSucceeded", "InputConsumed"].includes(value.eventName), "evidence.eventName");
  if (value.status !== undefined) requireShape(["success", "reverted", "pending", "unknown"].includes(value.status), "evidence.status");
  const safe = { kind: value.kind, source: value.source, testName: value.testName };
  for (const field of ["errorSelector", "blockNumber", "blockHash", "txHash", "operationId", "gasUsed",
    "status", "foundryGas", "eventName", "calldataSha256", "from", "valueWei"])
    if (value[field] !== undefined) safe[field] = value[field];
  if (transactions) safe.transactions = transactions;
  return safe;
}
function publicResult(value, requirePass = false) {
  exactKeys(value, new Set(["schemaVersion", "caseId", "operationOutcome", "testOutcome", "commit",
    "artifactHashes", "environment", "evidence", "execution", "network"]),
  ["schemaVersion", "caseId", "operationOutcome", "testOutcome", "commit", "artifactHashes", "environment", "evidence"], "result");
  requireShape(value.schemaVersion === 1 && /^S-\d{2}-[a-z0-9-]+$/.test(value.caseId), "result.caseId");
  requireShape(outcomes.has(value.operationOutcome) && testOutcomes.has(value.testOutcome), "result.outcome");
  if (requirePass) requireShape(value.testOutcome === "pass", "result.not-pass");
  requireShape(/^[0-9a-f]{40}$/i.test(value.commit), "result.commit");
  requireShape(plain(value.artifactHashes), "result.artifactHashes");
  const hashes = {};
  for (const [key, hash] of Object.entries(value.artifactHashes)) {
    requireShape(/^[a-z][a-z0-9-]*$/.test(key) && /^[0-9a-f]{64}$/i.test(hash), "result.artifactHashes");
    hashes[key] = hash;
  }
  exactKeys(value.environment, new Set(["os", "arch", "node", "pnpm", "foundry", "memoryBytes"]),
    ["os", "arch", "node", "pnpm", "foundry"], "result.environment");
  const environment = {};
  for (const field of ["os", "arch", "node", "pnpm", "foundry"]) environment[field] = cleanText(value.environment[field], `environment.${field}`);
  if (value.environment.memoryBytes !== undefined) {
    requireShape(decimal.test(value.environment.memoryBytes), "environment.memoryBytes");
    environment.memoryBytes = value.environment.memoryBytes;
  }
  let execution;
  if (value.execution !== undefined) {
    exactKeys(value.execution, new Set(["durationMs", "timeoutMs", "failureReason"]),
      ["durationMs", "timeoutMs"], "result.execution");
    requireShape(decimal.test(value.execution.durationMs) && decimal.test(value.execution.timeoutMs),
      "result.execution.duration");
    execution = { durationMs: value.execution.durationMs, timeoutMs: value.execution.timeoutMs };
    if (value.execution.failureReason !== undefined)
      execution.failureReason = cleanText(value.execution.failureReason, "result.execution.failureReason");
  }
  let network;
  if (value.network !== undefined) {
    exactKeys(value.network, new Set(["chainId", "pool", "deploymentTxHash", "manifestSha256",
      "finalizedBlockNumber", "finalizedBlockHash", "declaredFork", "forkBasis"]),
    ["chainId", "pool", "deploymentTxHash", "manifestSha256", "finalizedBlockNumber",
      "finalizedBlockHash", "declaredFork", "forkBasis"], "result.network");
    requireShape(decimal.test(value.network.chainId) && decimal.test(value.network.finalizedBlockNumber) &&
      /^0x[0-9a-f]{40}$/i.test(value.network.pool) && hex32.test(value.network.deploymentTxHash) &&
      /^[0-9a-f]{64}$/i.test(value.network.manifestSha256) &&
      hex32.test(value.network.finalizedBlockHash), "result.network.values");
    network = { ...value.network, declaredFork: cleanText(value.network.declaredFork, "result.network.declaredFork"),
      forkBasis: cleanText(value.network.forkBasis, "result.network.forkBasis") };
  }
  const safe = { schemaVersion: 1, caseId: value.caseId, operationOutcome: value.operationOutcome,
    testOutcome: value.testOutcome, commit: value.commit, artifactHashes: hashes,
    environment, evidence: publicEvidence(value.evidence),
    ...(execution ? { execution } : {}), ...(network ? { network } : {}) };
  const encoded = JSON.stringify(safe);
  requireShape(!unsafeText.test(encoded), "result.secret");
  for (const key of knownKeys) requireShape(!encoded.toLowerCase().includes(key), "result.known-key");
  return safe;
}

export function validateCaseResults(cases, results) {
  requireShape(Array.isArray(cases) && Array.isArray(results), "results");
  const expected = new Set(cases.map(item => item.caseId));
  requireShape(expected.size === cases.length, "cases.duplicate");
  const seen = new Set();
  for (const result of results) {
    const safe = publicResult(result, true);
    requireShape(expected.has(safe.caseId) && !seen.has(safe.caseId), "result.unknown-or-duplicate");
    seen.add(safe.caseId);
  }
  requireShape(seen.size === expected.size, "result.missing");
}

export async function writePublicEvidence(path, results) {
  requireShape(Array.isArray(results), "results");
  const seen = new Set();
  const safe = results.map(result => {
    const projected = publicResult(result);
    requireShape(!seen.has(projected.caseId), "result.duplicate");
    seen.add(projected.caseId);
    return projected;
  });
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
