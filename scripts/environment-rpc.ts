import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from 'viem';
import { verifyEnvironmentArtifact } from './environment-artifact.mjs';

interface GeneratedFixture {
  abi: Abi;
  creationBytecode: Hex;
  runtimeBytecode: Hex;
  manifest: Record<string, string>;
}

const sha256Hex = (value: Hex) => createHash('sha256').update(Buffer.from(value.slice(2), 'hex')).digest('hex');

export async function runEnvironmentRpcSmoke(url: string): Promise<{ answer: bigint; chainId: number; runtimeMatched: boolean }> {
  const artifact = JSON.parse(readFileSync(resolve('contracts/out/EnvironmentSmoke.t.sol/EnvironmentSmoke.json'), 'utf8')) as unknown;
  const source = readFileSync(resolve('contracts/test/EnvironmentSmoke.t.sol'), 'utf8');
  const config = readFileSync(resolve('contracts/foundry.toml'), 'utf8');
  const generated = JSON.parse(readFileSync(resolve('packages/ethereum/generated/environment-smoke.json'), 'utf8')) as GeneratedFixture;
  const manifest = verifyEnvironmentArtifact(artifact, generated.manifest, source, config);

  const publicClient = createPublicClient({ transport: http(url) });
  const chainId = await publicClient.getChainId();
  if (chainId !== 31337) throw new Error(`unexpected chain ID: ${chainId}`);

  const walletWithoutAccount = createWalletClient({ transport: http(url) });
  const accounts = await walletWithoutAccount.getAddresses();
  const account = accounts[0];
  if (!account) throw new Error('Anvil has no unlocked development account');
  const wallet = createWalletClient({ account, transport: http(url) });
  const hash = await wallet.deployContract({ abi: generated.abi, bytecode: generated.creationBytecode, chain: null });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('fixture deployment failed');
  const code = await publicClient.getCode({ address: receipt.contractAddress });
  if (!code) throw new Error('deployed fixture has no runtime bytecode');
  const runtimeMatched = sha256Hex(code) === manifest.runtimeSha256;
  if (!runtimeMatched) throw new Error('deployed runtime hash mismatch');
  const answer = await publicClient.readContract({ address: receipt.contractAddress, abi: generated.abi, functionName: 'answer' });
  if (answer !== 42n) throw new Error(`unexpected fixture answer: ${String(answer)}`);
  return { answer, chainId, runtimeMatched };
}
