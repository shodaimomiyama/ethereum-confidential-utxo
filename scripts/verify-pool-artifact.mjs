import { readFileSync } from 'node:fs';
import { artifactPath, outputPath, verifyPoolRecord } from './pool-artifact.mjs';

verifyPoolRecord(JSON.parse(readFileSync(outputPath, 'utf8')),
  JSON.parse(readFileSync(artifactPath, 'utf8')));
console.log(`Pool artifact verified: ${outputPath}`);
