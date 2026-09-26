import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactPath, createVerifierRecord, outputPath } from './verifier-artifact.mjs';
import { deployAndCheck, withAnvil } from './verifier-deployment.mjs';

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const record = createVerifierRecord(artifact);
record.deployment = await withAnvil(environment => deployAndCheck(record, environment));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Verifier artifact: ${outputPath}`);
console.log(`Runtime: ${record.deployment.runtimeBytes} bytes, initcode: ${record.deployment.fullInitcodeBytes} bytes`);
console.log(`Deployment gas: ${record.deployment.gasUsed}/${record.deployment.blockGasLimit}`);
