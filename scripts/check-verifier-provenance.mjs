import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const provenance = JSON.parse(readFileSync('contracts/src/verifier/provenance.json', 'utf8'));
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const checkHash = (path, expected) => {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new Error(`Invalid SHA-256 for ${path}`);
  }
  if (hashFile(path) !== expected.toLowerCase()) {
    throw new Error(`Source digest mismatch: ${path}`);
  }
};

if (provenance.upstream?.license !== 'MIT' || !provenance.upstream?.repository || !provenance.upstream?.commit) {
  throw new Error('Upstream provenance missing');
}
checkHash(provenance.upstream.noticePath, provenance.upstream.noticeSha256);
if (!Array.isArray(provenance.sources) || provenance.sources.length !== 3) {
  throw new Error('Expected exactly three Solidity migration sources');
}
for (const source of provenance.sources) checkHash(source.path, source.sha256);
checkHash(provenance.profile.path, provenance.profile.sha256);
checkHash(provenance.profile.parametersPath, provenance.profile.parametersSha256);
const profile = JSON.parse(readFileSync(provenance.profile.path, 'utf8'));
if (profile.expectedParametersHash !== provenance.profile.parametersHash) {
  throw new Error('Parameters hash mismatch');
}
if (!Array.isArray(provenance.plannedChanges) || provenance.plannedChanges.length < 5 ||
    !Array.isArray(provenance.passCriteria) || provenance.passCriteria.length < 6) {
  throw new Error('Migration gates missing');
}
console.log('Verifier source, license, profile, and migration gates match their recorded values.');
