import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { artifactPath, outputPath, verifyVerifierRecord } from './verifier-artifact.mjs';
import { compareDeploymentRecord, deployAndCheck, withAnvil } from './verifier-deployment.mjs';

execFileSync('forge', ['build', '--root', 'contracts'], { stdio: 'inherit' });
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const record = JSON.parse(readFileSync(outputPath, 'utf8'));
verifyVerifierRecord(record, artifact);
const deployed = await withAnvil(environment => deployAndCheck(record, environment));
compareDeploymentRecord(record.deployment, deployed);
execFileSync('node', ['scripts/measure-verifier.mjs', '--check'], { stdio: 'inherit' });
console.log(`Verifier artifact and normal deployment verified: ${record.manifest.runtimeSha256}`);
