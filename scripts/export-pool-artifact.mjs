import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactPath, createPoolRecord, outputPath } from './pool-artifact.mjs';

const record = createPoolRecord(JSON.parse(readFileSync(artifactPath, 'utf8')));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Pool artifact: ${outputPath}; runtime sha256 ${record.manifest.runtimeSha256}`);
