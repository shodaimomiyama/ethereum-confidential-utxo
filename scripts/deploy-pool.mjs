import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployPool } from './pool-deployment.mjs';

function option(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const rpcUrl = option('--rpc');
const chainValue = option('--chain-id');
const output = option('--out');
const hardfork = option('--hardfork');
if (!rpcUrl || !chainValue || !output || !hardfork || !/^[0-9]+$/.test(chainValue)) {
  throw new Error('usage: deploy-pool.mjs --rpc URL --chain-id ID --hardfork LABEL --out MANIFEST; set POOL_DEPLOY_PRIVATE_KEY');
}
const manifest = await deployPool({ rpcUrl, expectedChainId: Number(chainValue),
  privateKey: process.env.POOL_DEPLOY_PRIVATE_KEY, hardfork });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(`Pool deployed at ${manifest.pool.address}; manifest ${output}`);
