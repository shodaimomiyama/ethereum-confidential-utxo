import { expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { canonicalHeader, createEthereumRpc, readPinnedCall, readWithPolicy } from "../src/rpc.js";

const policy = { chunkBlocks: 2_000n, minChunkBlocks: 1n as const, retries: 2,
  requestTimeoutMs: 30, overallTimeoutMs: 100 };
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const point = { number: 101n, hash: hash("a"), mode: "finalized" as const };

it("requires an explicit RPC URL and bounded policy", () => {
  expect(() => createEthereumRpc({ url: "", mode: "finalized" })).toThrow();
  expect(() => createEthereumRpc({ url: "http://rpc.example", mode: "finalized" })).toThrow();
  expect(() => createEthereumRpc({ url: "https://rpc.example/SECRET_TOKEN", mode: "finalized",
    policy: { ...policy, retries: -1 } })).toThrow();
  expect(() => createEthereumRpc({ url: "http://127.0.0.1:8545", mode: "local-simulated" })).not.toThrow();
});

it("retries a transient read only within the finite budget", async () => {
  let attempts = 0;
  const result = await readWithPolicy(async () => {
    attempts++;
    if (attempts < 3) throw new Error("temporary network failure");
    return 7;
  }, policy);
  expect(result).toBe(7);
  expect(attempts).toBe(3);
  await expect(readWithPolicy(async () => { throw new Error("https://rpc.example/SECRET_TOKEN"); },
    { ...policy, retries: 0 })).rejects.toMatchObject({ code: "RPC", message: "RPC:rpc.read" });
});

it("stops on cancellation and timeout without retrying", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await expect(readWithPolicy(async () => { attempts++; return 1; },
    { ...policy, signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
  expect(attempts).toBe(0);
  await expect(readWithPolicy(() => new Promise<never>(() => {}),
    { ...policy, requestTimeoutMs: 5, overallTimeoutMs: 15 })).rejects.toMatchObject({ code: "TIMEOUT" });
});

it("proves a header is on the checkpoint's current canonical chain", async () => {
  const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber, hash: blockNumber === 101n ? point.hash : hash("b"),
  }) } as PublicClient;
  expect(await canonicalHeader(client, 100n, point)).toEqual({ complete: true, blockHash: point.hash,
    value: { number: 100n, hash: hash("b") } });
  const reorged = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber, hash: hash("c"),
  }) } as PublicClient;
  expect(await canonicalHeader(reorged, 100n, point)).toEqual({ complete: false, reason: "HASH_MISMATCH" });
});

it("uses an EIP-1898 hash-pinned call with requireCanonical", async () => {
  let identifier: unknown;
  const client = {
    request: async ({ params }: { params: unknown[] }) => { identifier = params[1]; return "0x1234"; },
    getBlock: async () => ({ number: 101n, hash: point.hash }),
  } as PublicClient;
  expect(await readPinnedCall(client, "0x1111111111111111111111111111111111111111" as Address,
    "0x12345678", point)).toBe("0x1234");
  expect(identifier).toEqual({ blockHash: point.hash, requireCanonical: true });
});
