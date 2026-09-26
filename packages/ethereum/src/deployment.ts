import { BlockNotFoundError, TransactionNotFoundError, TransactionReceiptNotFoundError,
  encodeAbiParameters, encodeFunctionData, sha256, toBytes } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import type { Context } from "@confidential-utxo/core";
import { poolAbi, verifierAbi } from "./abi.js";
import { poolArtifact, verifierArtifact } from "./artifacts.js";
import { EthereumFailure } from "./errors.js";

type DeploymentRecord = {
  address: Address;
  transactionHash: Hex;
  blockNumber: string;
  gasUsed: string;
  blockGasLimit: string;
  runtimeSha256: string;
  initcodeSha256: string;
  constructorArgsSha256: string;
};
export type DeploymentManifestV1 = {
  schemaVersion: 1;
  chainId: number;
  hardfork: string;
  artifacts: { pool: string; verifier: string };
  parametersHash: Hex;
  pool: DeploymentRecord;
  verifier: DeploymentRecord;
};
export type VerifiedDeployment = { context: Context; manifest: DeploymentManifestV1 };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hashBytes = (hex: Hex) => sha256(toBytes(hex)).slice(2);
const mismatch = (stage: string): never => { throw new EthereumFailure("DEPLOYMENT_MISMATCH", stage); };
async function capability<T>(stage: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch { throw new EthereumFailure("UNSUPPORTED", stage); }
}
const bytes = (value: unknown, n: number): value is Hex =>
  typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(value);

function parseManifest(value: unknown): DeploymentManifestV1 {
  if (!value || typeof value !== "object") mismatch("deployment.manifest");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.chainId) ||
      typeof record.hardfork !== "string" || !record.hardfork ||
      !record.artifacts || typeof record.artifacts !== "object" ||
      !bytes(record.parametersHash, 32)) mismatch("deployment.manifest");
  for (const label of ["pool", "verifier"] as const) {
    const item = record[label];
    if (!item || typeof item !== "object") mismatch(`deployment.${label}`);
    const data = item as Record<string, unknown>;
    if (!bytes(data.address, 20) || !bytes(data.transactionHash, 32) ||
        typeof data.blockNumber !== "string" || !/^\d+$/.test(data.blockNumber) ||
        typeof data.gasUsed !== "string" || !/^\d+$/.test(data.gasUsed) ||
        typeof data.blockGasLimit !== "string" || !/^\d+$/.test(data.blockGasLimit) ||
        !["runtimeSha256", "initcodeSha256", "constructorArgsSha256"].every(key =>
          typeof data[key] === "string" && /^[0-9a-fA-F]{64}$/.test(data[key]))) mismatch(`deployment.${label}`);
  }
  return value as DeploymentManifestV1;
}

function expectedPoolRuntime(verifier: Address): Hex {
  let runtime = poolArtifact.runtimeBytecode.slice(2).toLowerCase();
  const refs: readonly { start: number; length: number }[] = poolArtifact.immutableReferences;
  if (refs.length === 0 || refs.some(ref => ref.length !== 32)) mismatch("deployment.immutable");
  const word = verifier.slice(2).toLowerCase().padStart(64, "0");
  for (const ref of refs) {
    const start = ref.start * 2;
    runtime = `${runtime.slice(0, start)}${word}${runtime.slice(start + 64)}`;
  }
  return `0x${runtime}`;
}

async function verifyContract(client: PublicClient, record: DeploymentRecord, expected: {
  creation: Hex; runtime: Hex; args: Hex;
}): Promise<{ blockNumber: bigint; blockHash: Hex }> {
  const transaction = await client.getTransaction({ hash: record.transactionHash });
  const receipt = await client.getTransactionReceipt({ hash: record.transactionHash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const code = await client.getCode({ address: record.address });
  const input = `${expected.creation}${expected.args.slice(2)}` as Hex;
  if (!code || !same(code, expected.runtime) || !same(transaction.input, input) ||
      transaction.to !== null || receipt.status !== "success" ||
      !receipt.contractAddress || !same(receipt.contractAddress, record.address) ||
      receipt.blockNumber !== BigInt(record.blockNumber) || !same(receipt.blockHash, block.hash) ||
      !same(hashBytes(code), record.runtimeSha256) ||
      !same(hashBytes(input), record.initcodeSha256) ||
      !same(hashBytes(expected.args), record.constructorArgsSha256) ||
      receipt.gasUsed !== BigInt(record.gasUsed) || block.gasLimit !== BigInt(record.blockGasLimit)) {
    mismatch("deployment.contract");
  }
  return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

export async function verifyEthereumDeployment(client: PublicClient, input: unknown,
  mode: Context["finalityMode"]): Promise<VerifiedDeployment> {
  const manifest = parseManifest(input);
  if (mode !== "finalized" && mode !== "local-simulated") mismatch("deployment.mode");
  if (mode === "local-simulated" && manifest.chainId !== 31337) mismatch("deployment.mode");
  const artifacts = manifest.artifacts as Record<string, unknown>;
  if (artifacts.pool !== poolArtifact.runtimeSha256 || artifacts.verifier !== verifierArtifact.runtimeSha256 ||
      !same(manifest.parametersHash, verifierArtifact.parametersHash)) mismatch("deployment.artifacts");
  try {
    if (await client.getChainId() !== manifest.chainId) mismatch("deployment.chain");
    await verifyContract(client, manifest.verifier, {
      creation: verifierArtifact.creationBytecode as Hex,
      runtime: verifierArtifact.runtimeBytecode as Hex,
      args: verifierArtifact.constructorArgs as Hex,
    });
    const poolArgs = encodeAbiParameters([{ type: "address" }], [manifest.verifier.address]);
    const poolPosition = await verifyContract(client, manifest.pool, {
      creation: poolArtifact.creationBytecode as Hex,
      runtime: expectedPoolRuntime(manifest.verifier.address), args: poolArgs,
    });
    const referenced = await client.readContract({ address: manifest.pool.address, abi: poolAbi, functionName: "verifier" });
    const parameters = await client.readContract({ address: manifest.verifier.address, abi: verifierAbi, functionName: "parametersHash" });
    if (!same(referenced, manifest.verifier.address) || !same(parameters, manifest.parametersHash)) mismatch("deployment.references");

    // Probe every RPC capability the history adapter needs against this known deployment.
    await capability("deployment.logs", () => client.getLogs({ address: manifest.pool.address,
      fromBlock: poolPosition.blockNumber, toBlock: poolPosition.blockNumber }));
    const transaction = await capability("deployment.transactionInput", () =>
      client.getTransaction({ hash: manifest.pool.transactionHash }));
    if (!transaction.input || transaction.input === "0x") throw new EthereumFailure("UNSUPPORTED", "deployment.transactionInput");
    const callData = encodeFunctionData({ abi: poolAbi, functionName: "verifier" });
    await capability("deployment.pinnedState", () => client.request({ method: "eth_call", params: [
      { to: manifest.pool.address, data: callData },
      { blockHash: poolPosition.blockHash, requireCanonical: true },
    ] } as Parameters<PublicClient["request"]>[0]));
    if (mode === "finalized") {
      const finalized = await capability("deployment.finalized", () => client.getBlock({ blockTag: "finalized" }));
      if (!finalized.hash || finalized.number < poolPosition.blockNumber) throw new EthereumFailure("UNSUPPORTED", "deployment.finalized");
    }
    return { manifest, context: {
      chainId: BigInt(manifest.chainId), pool: manifest.pool.address,
      deploymentBlock: poolPosition.blockNumber, verifier: manifest.verifier.address,
      parametersHash: manifest.parametersHash, finalityMode: mode,
    } };
  } catch (error) {
    if (error instanceof EthereumFailure) throw error;
    if (error instanceof TransactionNotFoundError || error instanceof TransactionReceiptNotFoundError ||
        error instanceof BlockNotFoundError) mismatch("deployment.missing");
    throw new EthereumFailure("RPC", "deployment.rpc");
  }
}
