import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
mkdirSync(dirname(output), { recursive: true });
const outputFd = openSync(output, 'wx');
const pending = `${output}.pending.jsonl`;
let pendingFd;
let deployed = false;
let saved = false;
try {
  pendingFd = openSync(pending, 'wx');
  const manifest = await deployPool({ rpcUrl, expectedChainId: Number(chainValue),
    privateKey: process.env.POOL_DEPLOY_PRIVATE_KEY, hardfork,
    onDeployment: evidence => {
      deployed = true;
      const record = { chainId: Number(chainValue), hardfork, ...evidence };
      console.error(`${evidence.label} ${evidence.stage}: ${evidence.transactionHash}${evidence.address ? ` at ${evidence.address}` : ''}`);
      writeSync(pendingFd, `${JSON.stringify(record)}\n`);
      fsyncSync(pendingFd);
    } });
  writeFileSync(outputFd, `${JSON.stringify(manifest, null, 2)}\n`);
  fsyncSync(outputFd);
  saved = true;
  console.log(`Pool deployed at ${manifest.pool.address}; manifest ${output}`);
} finally {
  if (pendingFd !== undefined) closeSync(pendingFd);
  closeSync(outputFd);
  if (saved || !deployed) {
    if (pendingFd !== undefined) unlinkSync(pending);
  }
  if (!saved) {
    unlinkSync(output);
    if (deployed) console.error(`Deployment evidence retained at ${pending}`);
  }
}
