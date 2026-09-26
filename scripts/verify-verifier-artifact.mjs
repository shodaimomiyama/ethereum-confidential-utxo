import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { artifactPath, outputPath, verifyVerifierRecord } from './verifier-artifact.mjs';
import { deployAndCheck, withAnvil } from './verifier-deployment.mjs';

execFileSync('forge', ['build', '--root', 'contracts'], { stdio: 'inherit' });
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const record = JSON.parse(readFileSync(outputPath, 'utf8'));
verifyVerifierRecord(record, artifact);
const deployed = await withAnvil(environment => deployAndCheck(record, environment));
for (const key of ['chainId', 'hardfork', 'blockGasLimit', 'gasUsed', 'runtimeBytes', 'fullInitcodeBytes',
  'runtimeSha256', 'initcodeSha256', 'constructorInputSha256', 'initialStateSha256']) {
  if (record.deployment?.[key] !== deployed[key]) throw new Error(`deployment ${key} mismatch`);
}
console.log(`Verifier artifact and normal deployment verified: ${record.manifest.runtimeSha256}`);
