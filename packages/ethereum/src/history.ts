import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData } from "viem";
import type { Hex, PublicClient } from "viem";
import { operationId, outputId, validateOperationShape } from "@confidential-utxo/core";
import type { Checkpoint, Context, HistoryPort, Observation, ObservedOperation, OperationRequest, OperationSuccess, PublicOutput, UtxoState } from "@confidential-utxo/core";
import { poolAbi } from "./abi.js";
import type { VerifiedDeployment } from "./deployment.js";
import { EthereumFailure } from "./errors.js";
import { canonicalHeader, readPinnedCall, readWithPolicy } from "./rpc.js";
import type { RpcPolicy } from "./rpc.js";

type Position = { operationId: Hex; blockNumber: bigint; blockHash: Hex;
  transactionHash: Hex; transactionIndex: number; logIndex: number };
type InputEvent = { name: "InputConsumed"; inputId: Hex; position: Position };
type OutputEvent = { name: "OutputCreated"; outputId: Hex; outputIndex: number;
  output: PublicOutput; position: Position };
type SuccessEvent = { name: "OperationSucceeded"; kind: 0 | 1 | 2; owner: `0x${string}`;
  salt: Hex; inputIds: Hex[]; outputIds: Hex[]; d: bigint; w: bigint;
  destination: `0x${string}`; position: Position };
type PoolEvent = InputEvent | OutputEvent | SuccessEvent;
type RawLog = Awaited<ReturnType<PublicClient["getLogs"]>>[number];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const incomplete = (reason: "RPC" | "GAP" | "HASH_MISMATCH"): Observation<ObservedOperation[]> =>
  ({ complete: false, reason });

export function chunkInclusive(from: bigint, to: bigint, width: bigint): [bigint, bigint][] {
  if (from < 0n || to < from || width < 1n) return [];
  const result: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += width) {
    const end = start + width - 1n;
    result.push([start, end > to ? to : end]);
  }
  return result;
}

function decode(log: RawLog): PoolEvent {
  if (log.blockNumber === null || !log.blockHash || !log.transactionHash || log.transactionIndex === null ||
      log.logIndex === null || log.removed || !Number.isSafeInteger(log.transactionIndex) ||
      !Number.isSafeInteger(log.logIndex)) throw new Error("incomplete log metadata");
  const parsed = decodeEventLog({ abi: poolAbi, topics: log.topics, data: log.data });
  const args = parsed.args as Record<string, unknown>;
  const position: Position = { operationId: args.operationId as Hex,
    blockNumber: log.blockNumber, blockHash: log.blockHash,
    transactionHash: log.transactionHash, transactionIndex: log.transactionIndex, logIndex: log.logIndex };
  if (parsed.eventName === "InputConsumed") {
    return { name: "InputConsumed", inputId: args.inputId as Hex, position };
  }
  if (parsed.eventName === "OutputCreated") {
    return { name: "OutputCreated", outputId: args.utxoId as Hex, outputIndex: Number(args.outputIndex),
      output: { owner: args.owner as `0x${string}`, commitment: { x: args.Cx as bigint, y: args.Cy as bigint },
        receiptFormat: args.receiptFormat as 1, packet: args.packet as Hex }, position };
  }
  if (parsed.eventName === "OperationSucceeded") {
    return { name: "OperationSucceeded", kind: args.kind as 0 | 1 | 2, owner: args.owner as `0x${string}`,
      salt: args.salt as Hex, inputIds: [...args.inputIds as Hex[]], outputIds: [...args.outputIds as Hex[]],
      d: args.d as bigint, w: args.w as bigint, destination: args.destination as `0x${string}`, position };
  }
  throw new Error("unrecognized Pool event");
}

function fromCall(request: Record<string, unknown>): OperationRequest {
  const outputs = request.outputs as { owner: `0x${string}`; Cx: bigint; Cy: bigint; receiptFormat: 1; packet: Hex }[];
  return { kind: request.kind as 0 | 1 | 2, owner: request.owner as `0x${string}`,
    salt: request.salt as Hex, inputIds: [...request.inputIds as Hex[]],
    outputs: outputs.map(item => ({ owner: item.owner, commitment: { x: item.Cx, y: item.Cy },
      receiptFormat: item.receiptFormat, packet: item.packet })),
    d: request.d as bigint, w: request.w as bigint, destination: request.destination as `0x${string}` };
}

async function assemble(client: PublicClient, context: Context, events: PoolEvent[], policy: RpcPolicy): Promise<ObservedOperation[]> {
  const groups = new Map<string, PoolEvent[]>();
  for (const event of events) {
    const p = event.position;
    const key = `${p.blockHash.toLowerCase()}:${p.transactionHash.toLowerCase()}:${p.operationId.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const operations: ObservedOperation[] = [];
  for (const group of groups.values()) {
    const successes = group.filter((event): event is SuccessEvent => event.name === "OperationSucceeded");
    if (successes.length !== 1) throw new Error("missing or repeated success log");
    const success = successes[0]!;
    const inputs = group.filter((event): event is InputEvent => event.name === "InputConsumed")
      .sort((a, b) => a.position.logIndex - b.position.logIndex);
    const outputs = group.filter((event): event is OutputEvent => event.name === "OutputCreated")
      .sort((a, b) => a.position.logIndex - b.position.logIndex);
    if (inputs.length !== success.inputIds.length || outputs.length !== success.outputIds.length) throw new Error("event count mismatch");
    const first = success.position.logIndex - inputs.length - outputs.length;
    for (let i = 0; i < inputs.length; i++) {
      const log = inputs[i]!;
      if (!same(log.inputId, success.inputIds[i]!) || log.position.logIndex !== first + i) throw new Error("input log mismatch");
    }
    for (let i = 0; i < outputs.length; i++) {
      const log = outputs[i]!;
      if (log.outputIndex !== i || !same(log.outputId, success.outputIds[i]!) ||
          log.position.logIndex !== first + inputs.length + i) throw new Error("output log mismatch");
    }
    if (success.position.logIndex !== first + inputs.length + outputs.length) throw new Error("success position mismatch");
    const request: OperationRequest = { kind: success.kind, owner: success.owner, salt: success.salt,
      inputIds: success.inputIds, outputs: outputs.map(item => item.output), d: success.d, w: success.w,
      destination: success.destination };
    validateOperationShape(request);
    const id = operationId(context, request);
    if (!same(id, success.position.operationId) || outputs.some((entry, i) => !same(entry.outputId, outputId(id, i)))) {
      throw new Error("operation identity mismatch");
    }
    for (const event of group) {
      const p = event.position;
      if (p.blockNumber !== success.position.blockNumber || !same(p.blockHash, success.position.blockHash) ||
          !same(p.transactionHash, success.position.transactionHash) || p.transactionIndex !== success.position.transactionIndex) {
        throw new Error("mixed transaction evidence");
      }
    }
    const transaction = await readWithPolicy(() => client.getTransaction({ hash: success.position.transactionHash }), policy);
    if (transaction.to && same(transaction.to, context.pool)) {
      const call = decodeFunctionData({ abi: poolAbi, data: transaction.input });
      const expectedName = request.kind === 0 ? "deposit" : request.kind === 1 ? "transfer" : "withdraw";
      if (call.functionName !== expectedName || !call.args?.[0] ||
          !same(operationId(context, fromCall(call.args[0] as Record<string, unknown>)), id)) {
        throw new Error("direct calldata mismatch");
      }
    }
    operations.push({ request,
      success: { ...success.position },
      inputLogs: inputs.map(item => ({ ...item.position, inputId: item.inputId })),
      outputLogs: outputs.map(item => ({ ...item.position, output: item.output,
        outputId: item.outputId, outputIndex: item.outputIndex })) });
  }
  operations.sort((a, b) => {
    const x = a.success!, y = b.success!;
    return x.blockNumber < y.blockNumber ? -1 : x.blockNumber > y.blockNumber ? 1 :
      x.transactionIndex - y.transactionIndex || x.logIndex - y.logIndex;
  });
  return operations;
}

export async function getPoolOperations(client: PublicClient, context: Context, fromBlock: bigint,
  point: Checkpoint, policy: RpcPolicy): Promise<Observation<ObservedOperation[]>> {
  if (fromBlock < context.deploymentBlock || fromBlock > point.number) return incomplete("GAP");
  const before = await canonicalHeader(client, point.number, point);
  if (!before.complete) return incomplete(before.reason);
  const logs: RawLog[] = [];
  let start = fromBlock;
  let width = policy.chunkBlocks;
  const deadline = Date.now() + policy.overallTimeoutMs;
  try {
    while (start <= point.number) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return incomplete("GAP");
      const end = start + width - 1n > point.number ? point.number : start + width - 1n;
      try {
        const part = await readWithPolicy(() => client.getLogs({ address: context.pool, fromBlock: start, toBlock: end }),
          { ...policy, overallTimeoutMs: remaining });
        for (const log of part) {
          if (log.blockNumber === null || log.blockNumber < start || log.blockNumber > end ||
              !same(log.address, context.pool)) throw new Error("out of range log");
          logs.push(log);
        }
        start = end + 1n;
      } catch (error) {
        if (error instanceof Error && ("code" in error) && (error as { code?: string }).code === "ABORTED") return incomplete("RPC");
        if (width === 1n) return incomplete("GAP");
        width = width / 2n || 1n;
      }
    }
    const seen = new Map<string, RawLog>();
    for (const log of logs) {
      if (!log.blockHash || !log.transactionHash || log.logIndex === null) return incomplete("GAP");
      const key = `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      const old = seen.get(key);
      if (old && (old.data !== log.data || JSON.stringify(old.topics) !== JSON.stringify(log.topics))) return incomplete("GAP");
      seen.set(key, log);
    }
    const headers = new Map<bigint, Hex>();
    for (const log of seen.values()) {
      const number = log.blockNumber!;
      if (!headers.has(number)) {
        const header = await canonicalHeader(client, number, point);
        if (!header.complete) return incomplete(header.reason);
        headers.set(number, header.value.hash);
      }
      if (!same(headers.get(number)!, log.blockHash!)) return incomplete("HASH_MISMATCH");
    }
    const events = [...seen.values()].map(decode);
    const operations = await assemble(client, context, events, policy);
    const after = await canonicalHeader(client, point.number, point);
    return after.complete ? { complete: true, blockHash: point.hash, value: operations } : incomplete(after.reason);
  } catch (error) {
    if (error instanceof EthereumFailure && error.code === "RPC") return incomplete("RPC");
    if (error instanceof EthereumFailure && error.code === "HASH_MISMATCH") return incomplete("HASH_MISMATCH");
    return incomplete("GAP");
  }
}

const incompleteState = (reason: "RPC" | "GAP" | "HASH_MISMATCH") => ({ complete: false as const, reason });
const completeState = <T>(point: Checkpoint, value: T): Observation<T> =>
  ({ complete: true, blockHash: point.hash, value });
const samePoint = (point: Checkpoint, context: Context) =>
  point.mode === context.finalityMode && point.number >= context.deploymentBlock;

export function createHistoryPort(verified: VerifiedDeployment, client: PublicClient, policy: RpcPolicy): HistoryPort {
  const context = verified.context;
  const checked = (point: Checkpoint) => samePoint(point, context) ? undefined : incompleteState("GAP");
  const allOperations = (point: Checkpoint) =>
    getPoolOperations(client, context, context.deploymentBlock, point, policy);

  const utxo = async (id: Hex, point: Checkpoint): Promise<Observation<UtxoState>> => {
    const invalid = checked(point);
    if (invalid) return invalid;
    try {
      const data = await readPinnedCall(client, context.pool,
        encodeFunctionData({ abi: poolAbi, functionName: "getUtxo", args: [id] }), point);
      const [status, owner, x, y] = decodeFunctionResult({ abi: poolAbi, functionName: "getUtxo", data });
      if (status === 0) return completeState(point, { exists: false });
      if (status !== 1 && status !== 2) return incompleteState("GAP");
      const value: UtxoState = { exists: true, owner, commitment: { x, y } };
      if (status === 2) {
        const operations = await allOperations(point);
        if (!operations.complete) return incompleteState(operations.reason);
        const consumers = operations.value.filter(op => op.request.inputIds.some(input => same(input, id)));
        if (consumers.length !== 1 || !consumers[0]?.success) return incompleteState("GAP");
        value.consumedBy = consumers[0].success.operationId;
      }
      const after = await canonicalHeader(client, point.number, point);
      return after.complete ? completeState(point, value) : incompleteState(after.reason);
    } catch (error) {
      return incompleteState(error instanceof EthereumFailure && error.code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "RPC");
    }
  };

  const success = async (id: Hex, point: Checkpoint): Promise<Observation<OperationSuccess>> => {
    const invalid = checked(point);
    if (invalid) return invalid;
    try {
      const data = await readPinnedCall(client, context.pool,
        encodeFunctionData({ abi: poolAbi, functionName: "isOperationExecuted", args: [id] }), point);
      const executed = decodeFunctionResult({ abi: poolAbi, functionName: "isOperationExecuted", data });
      if (!executed) return completeState(point, { executed: false });
      const operations = await allOperations(point);
      if (!operations.complete) return incompleteState(operations.reason);
      const matches = operations.value.filter(op => op.success && same(op.success.operationId, id));
      if (matches.length !== 1 || !matches[0]) return incompleteState("GAP");
      const after = await canonicalHeader(client, point.number, point);
      return after.complete ? completeState(point, { executed: true, operation: matches[0].request }) : incompleteState(after.reason);
    } catch (error) {
      return incompleteState(error instanceof EthereumFailure && error.code === "HASH_MISMATCH" ? "HASH_MISMATCH" : "RPC");
    }
  };

  return {
    async getFinalizedCheckpoint() {
      try {
        const block = await readWithPolicy(() => client.getBlock({ blockTag: context.finalityMode === "finalized" ? "finalized" : "latest" }), policy);
        if (!block.hash || block.number < context.deploymentBlock) return null;
        return { number: block.number, hash: block.hash, mode: context.finalityMode };
      } catch { return null; }
    },
    async getContext(point) {
      const invalid = checked(point);
      if (invalid) return invalid;
      const header = await canonicalHeader(client, point.number, point);
      return header.complete ? completeState(point, context) : incompleteState(header.reason);
    },
    getCanonicalHeader(number, point) {
      const invalid = checked(point);
      return invalid ? Promise.resolve(invalid) : canonicalHeader(client, number, point);
    },
    getOperations(fromBlock, point) {
      const invalid = checked(point);
      return invalid ? Promise.resolve(invalid) : getPoolOperations(client, context, fromBlock, point, policy);
    },
    getUtxo: utxo,
    getOperationSuccess: success,
    async getLatestHeader() {
      try {
        const block = await readWithPolicy(() => client.getBlock({ blockTag: "latest" }), policy);
        return block.hash ? { number: block.number, hash: block.hash } : null;
      } catch { return null; }
    },
    getLatestUtxo(id, point) { return utxo(id, { ...point, mode: context.finalityMode }); },
    getLatestOperationSuccess(id, point) { return success(id, { ...point, mode: context.finalityMode }); },
  };
}
