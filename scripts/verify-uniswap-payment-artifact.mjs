import { readFileSync } from 'node:fs';
import { artifactPath, outputPath, verifyUniswapPaymentRecord } from './uniswap-payment-artifact.mjs';

verifyUniswapPaymentRecord(JSON.parse(readFileSync(outputPath, 'utf8')),
  JSON.parse(readFileSync(artifactPath, 'utf8')));
console.log(`Adapter artifact verified: ${outputPath}`);
