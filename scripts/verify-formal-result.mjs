import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');

const image = process.argv[2];
if (!image?.includes('@sha256:')) throw new Error('Formal image must have a digest');

const manifest = readJson('packages/ethereum/generated/environment-smoke.json').manifest;
const artifact = readJson('contracts/out/EnvironmentSmoke.t.sol/EnvironmentSmoke.json');
const runtime = Buffer.from(artifact.deployedBytecode.object.slice(2), 'hex');
if (hash(runtime) !== manifest.runtimeSha256) throw new Error('Formal artifact runtime mismatch');

const proof = readJson('contracts/out/proofs/test%EnvironmentProofTest.test_provesAnswer():0/proof.json');
if (proof.admitted || proof.type !== 'APRProof' || proof.init === proof.target) {
  throw new Error('Kontrol proof invalid or vacuous');
}
if (!Array.isArray(proof.terminal) || proof.terminal.length < 2) {
  throw new Error('Kontrol proof did not reach the target');
}

const list = readFileSync('formal/environment/out/kontrol-list.txt', 'utf8');
for (const line of [
  'status: ProofStatus.PASSED',
  'admitted: False',
  'pending: 0',
  'failing: 0',
  'vacuous: 0',
  'stuck: 0',
  'bounded: 0',
]) {
  if (!list.includes(line)) throw new Error(`Kontrol result missing: ${line}`);
}
if (!list.includes(proof.id)) throw new Error('Kontrol result has the wrong proof');
if (readFileSync('formal/environment/out/kprove.txt', 'utf8').trim() !== '#Top') {
  throw new Error('K proof did not reach #Top');
}

const record = {
  image,
  schedule: 'CANCUN',
  workers: 1,
  exitCode: 0,
  artifactSha256: manifest.artifactSha256,
  runtimeSha256: manifest.runtimeSha256,
  kDefinitionSha256: hash(readFileSync('formal/environment/out/model-smoke-kompiled/definition.kore')),
  kontrolDefinitionSha256: hash(readFileSync('contracts/out/kompiled/definition.kore')),
  proofSha256: hash(readFileSync('contracts/out/proofs/test%EnvironmentProofTest.test_provesAnswer():0/proof.json')),
  proofId: proof.id,
  proofStatus: 'PASSED',
  proofNodeCount: Number(list.match(/nodes: (\d+)/)?.[1]),
  pending: 0,
  failing: 0,
  vacuous: 0,
  stuck: 0,
  bounded: 0,
  admitted: false,
  kResult: '#Top',
};
writeFileSync('formal/environment/out/result.json', `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`Formal smoke passed: ${proof.id}\n`);
