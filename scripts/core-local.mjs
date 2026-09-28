import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, mkdir, rm } from "node:fs/promises";
import { totalmem, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateCaseResults, writePublicEvidence } from "./core-evidence.mjs";

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idPattern = /\bS-\d{2}-[a-z0-9-]+\b/g;
const localSource = source => source.startsWith("tests/integration/core/") && source.endsWith(".test.ts");

export function convertVitestResults(cases, report, repoRoot, { strict = true } = {}) {
  if (!Array.isArray(report?.testResults)) throw new Error("missing Vitest testResults");
  const byId = new Map(cases.filter(item => localSource(item.evidenceRef)).map(item => [item.caseId, item]));
  const rows = [];
  const seen = new Set();
  for (const file of report.testResults) {
    const source = relative(repoRoot, file.name).replaceAll("\\", "/");
    if (!source.startsWith("tests/integration/core/")) continue;
    for (const test of file.assertionResults ?? []) {
      const ids = [...new Set(test.fullName.match(idPattern) ?? [])];
      for (const caseId of ids) {
        const expected = byId.get(caseId);
        if (!expected || expected.evidenceRef !== source || seen.has(caseId))
          throw new Error(`unbound Vitest case: ${caseId}`);
        if (strict && test.status !== "passed" && test.status !== "failed")
          throw new Error(`skipped Vitest case: ${caseId}`);
        seen.add(caseId);
        rows.push({ caseId, source, testName: test.fullName,
          status: test.status });
      }
    }
  }
  return rows;
}

export function convertFoundryResults(cases, report, { strict = true } = {}) {
  if (!report || typeof report !== "object") throw new Error("missing Foundry results");
  return cases.filter(item => item.runner === "foundry").map(item => {
    const suffix = `${item.evidenceRef.replace(/^contracts\//, "")}:`;
    const suite = Object.entries(report).find(([name]) => name.startsWith(suffix))?.[1];
    const result = suite?.test_results?.[`${item.testName}()`];
    if (!result || result.status !== "Success" || !Number.isSafeInteger(result.kind?.Unit?.gas)) {
      if (strict) throw new Error(`missing or failed Foundry test: ${item.caseId}`);
      return { caseId: item.caseId, source: item.evidenceRef, testName: item.testName,
        status: result ? "failed" : "skipped" };
    }
    return { caseId: item.caseId, source: item.evidenceRef, testName: item.testName,
      status: "passed", foundryGas: String(result.kind.Unit.gas) };
  });
}

export function convertTapResults(tap) {
  if (typeof tap !== "string") throw new Error("invalid TAP results");
  const rows = [];
  const seen = new Set();
  for (const line of tap.split(/\r?\n/)) {
    const match = /^(ok|not ok) \d+ - (.+)$/.exec(line);
    if (!match) continue;
    const testName = match[2];
    for (const caseId of [...new Set(testName.match(idPattern) ?? [])]) {
      if (seen.has(caseId)) throw new Error(`duplicate TAP case: ${caseId}`);
      seen.add(caseId);
      rows.push({ caseId, status: match[1] === "ok" ? "passed" : "failed", testName });
    }
  }
  return rows;
}

async function command(commandName, args, options = {}) {
  try {
    const result = await runFile(commandName, args, { cwd: root, maxBuffer: 20 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function environment() {
  const [pnpm, foundry] = await Promise.all([command("pnpm", ["--version"]), command("forge", ["--version"])]);
  const version = foundry.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (pnpm.code || foundry.code || !version) throw new Error("core evidence environment unavailable");
  return { os: process.platform, arch: process.arch, node: process.versions.node,
    pnpm: pnpm.stdout.trim(), foundry: version, memoryBytes: String(totalmem()) };
}

async function artifactHashes() {
  const rows = [["pool", "packages/ethereum/generated/pool-v1.json"],
    ["verifier", "packages/ethereum/generated/verifier-v3.json"]];
  return Object.fromEntries(await Promise.all(rows.map(async ([name, path]) =>
    [name, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
}

export async function runLocalAcceptance() {
  const scratch = await mkdtemp(join(tmpdir(), "cutxo-core-results-"));
  let out;
  try {
    const status = await command("git", ["status", "--porcelain", "--untracked-files=all"]);
    if (status.code || status.stdout.split(/\r?\n/).some(line => line &&
      !line.slice(3).startsWith("tests/integration/core/results/")))
      throw new Error("commit core test and runner changes before recording acceptance");
    const cases = JSON.parse(await readFile(join(root, "tests/integration/core/cases.json"), "utf8"))
      .filter(item => item.runner !== "sepolia");
    const reportPath = join(scratch, "vitest.json");
    const transactionsDir = join(scratch, "transactions");
    await mkdir(transactionsDir);
    const vitest = await command(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"),
      "run", "tests/integration/core", "--reporter=json", `--outputFile=${reportPath}`],
    { env: { ...process.env, CORE_PUBLIC_TX_DIR: transactionsDir } });
    const forge = await command("forge", ["test", "--root", "contracts", "--json"]);
    const tap = await command(process.execPath, ["--test", "--test-reporter=tap",
      "tests/integration/core/evidence.test.mjs"]);
    let report;
    try { report = JSON.parse(await readFile(reportPath, "utf8")); }
    catch { report = { testResults: [] }; }
    let foundry;
    try { foundry = JSON.parse(forge.stdout); }
    catch { foundry = {}; }
    let conversionFailed = false;
    let vitestRows;
    try { vitestRows = convertVitestResults(cases, report, root, { strict: false }); }
    catch { vitestRows = []; conversionFailed = true; }
    const foundryRows = convertFoundryResults(cases, foundry, { strict: false });
    const tapRows = convertTapResults(tap.stdout);
    const rows = new Map();
    for (const item of [...vitestRows, ...foundryRows, ...tapRows]) {
      if (!cases.some(expected => expected.caseId === item.caseId) || rows.has(item.caseId)) {
        conversionFailed = true;
        continue;
      }
      rows.set(item.caseId, item);
    }
    const transactions = new Map();
    for (const file of await readdir(transactionsDir)) {
      const recorded = JSON.parse(await readFile(join(transactionsDir, file), "utf8"));
      if (!Array.isArray(recorded.caseIds) || !Array.isArray(recorded.transactions)) {
        conversionFailed = true;
        continue;
      }
      for (const caseId of recorded.caseIds) {
        if (!cases.some(item => item.caseId === caseId)) { conversionFailed = true; continue; }
        transactions.set(caseId, [...(transactions.get(caseId) ?? []), ...recorded.transactions]);
      }
    }
    const commitResult = await command("git", ["rev-parse", "HEAD"]);
    if (commitResult.code) throw new Error("cannot resolve tested commit");
    const commit = commitResult.stdout.trim();
    const [environmentData, hashes] = await Promise.all([environment(), artifactHashes()]);
    const results = cases.map(item => {
      const observed = rows.get(item.caseId);
      const pass = observed?.status === "passed";
      const testOutcome = pass ? "pass" : observed?.status === "failed" ? "fail" : "not-run";
      const txs = pass && item.expectedOperation === "success" ? transactions.get(item.caseId) : undefined;
      return { schemaVersion: 1, caseId: item.caseId,
        operationOutcome: pass ? item.expectedOperation : "unavailable", testOutcome,
        commit, artifactHashes: hashes, environment: environmentData,
        evidence: { kind: observed?.foundryGas ? "foundry" : txs?.length ? "transaction" : "test",
          source: item.evidenceRef, testName: observed?.testName ?? item.caseId,
          ...(observed?.foundryGas ? { foundryGas: observed.foundryGas } : {}),
          ...(txs?.length ? { transactions: txs } : {}) } };
    });
    const outputDir = join(root, "tests/integration/core/results");
    await mkdir(outputDir, { recursive: true });
    out = join(outputDir, `local-${commit.slice(0, 12)}-${Date.now()}-${randomUUID()}.json`);
    await writePublicEvidence(out, results);
    if (vitest.code || forge.code || tap.code || conversionFailed) throw new Error("one or more core test runners failed");
    validateCaseResults(cases, results);
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalAcceptance().then(path => process.stdout.write(`${relative(root, path)}\n`))
    .catch(() => { process.stderr.write("core local acceptance failed; inspect sanitized result if written\n"); process.exitCode = 1; });
}
