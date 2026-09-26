import { readFileSync } from 'node:fs';
import { verifyDeployment } from './pool-deployment.mjs';

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const rpcUrl = option('--rpc');
const manifestPath = option('--manifest');
if (!rpcUrl || !manifestPath) throw new Error('usage: verify-pool-deployment.mjs --rpc URL --manifest JSON');
const result = await verifyDeployment(JSON.parse(readFileSync(manifestPath, 'utf8')), rpcUrl);
console.log(`Pool deployment verified on chain ${result.chainId}: ${result.pool.address}`);
