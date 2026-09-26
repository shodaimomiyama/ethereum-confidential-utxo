import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactPath, createUniswapPaymentRecord, outputPath } from './uniswap-payment-artifact.mjs';

const record = createUniswapPaymentRecord(JSON.parse(readFileSync(artifactPath, 'utf8')));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`Adapter artifact: ${outputPath}; runtime sha256 ${record.manifest.runtimeSha256}`);
