import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import type { Checkpoint, Observation } from "@confidential-utxo/core";
import { EthereumFailure } from "./errors.js";

export type RpcPolicy = {
  chunkBlocks: bigint;
  minChunkBlocks: 1n;
  retries: number;
  requestTimeoutMs: number;
  overallTimeoutMs: number;
  signal?: AbortSignal;
};
export type RpcConnection = { client: PublicClient; policy: RpcPolicy; mode: Checkpoint["mode"] };

export const defaultRpcPolicy: RpcPolicy = {
  chunkBlocks: 2_000n, minChunkBlocks: 1n, retries: 2,
  requestTimeoutMs: 10_000, overallTimeoutMs: 120_000,
};

export function validateRpcPolicy(options: Partial<RpcPolicy> = {}): RpcPolicy {
  const value: RpcPolicy = { ...defaultRpcPolicy, ...options };
  if (typeof value.chunkBlocks !== "bigint" || value.chunkBlocks < 1n || value.chunkBlocks > 1_000_000n ||
      value.minChunkBlocks !== 1n || !Number.isSafeInteger(value.retries) || value.retries < 0 || value.retries > 10 ||
      !Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs < 1 || value.requestTimeoutMs > 600_000 ||
      !Number.isSafeInteger(value.overallTimeoutMs) || value.overallTimeoutMs < 1 || value.overallTimeoutMs > 3_600_000) {
    throw new EthereumFailure("INVALID_CONFIG", "rpc.policy");
  }
  return value;
}

export function createEthereumRpc(input: { url: string; mode: Checkpoint["mode"]; policy?: Partial<RpcPolicy> }): RpcConnection {
  const policy = validateRpcPolicy(input.policy);
  let url: URL;
  try { url = new URL(input.url); }
  catch { throw new EthereumFailure("INVALID_CONFIG", "rpc.url"); }
  if (input.mode !== "finalized" && input.mode !== "local-simulated") throw new EthereumFailure("INVALID_CONFIG", "rpc.mode");
  if (input.mode === "finalized" && url.protocol !== "https:") throw new EthereumFailure("INVALID_CONFIG", "rpc.url");
  if (input.mode === "local-simulated" &&
      !(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new EthereumFailure("INVALID_CONFIG", "rpc.localUrl");
  }
  return { client: createPublicClient({ transport: http(input.url, { timeout: policy.requestTimeoutMs, retryCount: 0 }) }),
    policy, mode: input.mode };
}

export async function readWithPolicy<T>(operation: (signal: AbortSignal) => Promise<T>, options: RpcPolicy): Promise<T> {
  const policy = validateRpcPolicy(options);
  const deadline = Date.now() + policy.overallTimeoutMs;
  if (policy.signal?.aborted) throw new EthereumFailure("ABORTED", "rpc.read");
  for (let attempt = 0; attempt <= policy.retries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new EthereumFailure("TIMEOUT", "rpc.read");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let timedOut = false;
    try {
      const stop = new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new EthereumFailure("ABORTED", "rpc.read")); };
        policy.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort();
          reject(new EthereumFailure("TIMEOUT", "rpc.read")); }, Math.min(policy.requestTimeoutMs, remaining));
      });
      const result = await Promise.race([operation(controller.signal), stop]);
      return result;
    } catch (error) {
      if (policy.signal?.aborted) throw new EthereumFailure("ABORTED", "rpc.read");
      if (error instanceof EthereumFailure && error.code === "ABORTED") throw error;
      if (error instanceof EthereumFailure && (error.code === "INVALID_CONFIG" || error.code === "DEPLOYMENT_MISMATCH")) throw error;
      if (attempt === policy.retries || Date.now() >= deadline) {
        if (timedOut || Date.now() >= deadline) throw new EthereumFailure("TIMEOUT", "rpc.read");
        throw new EthereumFailure("RPC", "rpc.read");
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) policy.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new EthereumFailure("RPC", "rpc.read");
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function remainingRpcPolicy(policy: RpcPolicy, deadline: number): RpcPolicy {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new EthereumFailure("TIMEOUT", "rpc.deadline");
  return { ...policy, overallTimeoutMs: Math.min(policy.overallTimeoutMs, remaining) };
}

export async function canonicalHeader(client: PublicClient, number: bigint,
  point: Checkpoint, policy: RpcPolicy = defaultRpcPolicy): Promise<Observation<{ number: bigint; hash: Hex }>> {
  if (number < 0n || number > point.number) return { complete: false, reason: "GAP" };
  const deadline = Date.now() + policy.overallTimeoutMs;
  try {
    const start = await readWithPolicy(() => client.getBlock({ blockNumber: point.number }),
      remainingRpcPolicy(policy, deadline));
    if (!start.hash || !same(start.hash, point.hash)) return { complete: false, reason: "HASH_MISMATCH" };
    const header = number === point.number ? start : await readWithPolicy(() => client.getBlock({ blockNumber: number }),
      remainingRpcPolicy(policy, deadline));
    const end = await readWithPolicy(() => client.getBlock({ blockNumber: point.number }),
      remainingRpcPolicy(policy, deadline));
    if (!header.hash || header.number !== number || !end.hash || !same(end.hash, point.hash)) {
      return { complete: false, reason: "HASH_MISMATCH" };
    }
    return { complete: true, blockHash: point.hash, value: { number, hash: header.hash } };
  } catch { return { complete: false, reason: "RPC" }; }
}

export async function readPinnedCall(client: PublicClient, to: Address, data: Hex, point: Checkpoint,
  policy: RpcPolicy = defaultRpcPolicy): Promise<Hex> {
  const deadline = Date.now() + policy.overallTimeoutMs;
  const before = await canonicalHeader(client, point.number, point, remainingRpcPolicy(policy, deadline));
  if (!before.complete) throw new EthereumFailure(before.reason, "rpc.pinnedCall");
  let result: Hex;
  try {
    result = await readWithPolicy(() => client.request({ method: "eth_call", params: [
      { to, data }, { blockHash: point.hash, requireCanonical: true },
    ] } as Parameters<PublicClient["request"]>[0]) as Promise<Hex>, remainingRpcPolicy(policy, deadline));
  } catch { throw new EthereumFailure("RPC", "rpc.pinnedCall"); }
  const after = await canonicalHeader(client, point.number, point, remainingRpcPolicy(policy, deadline));
  if (!after.complete) throw new EthereumFailure(after.reason, "rpc.pinnedCall");
  return result;
}
