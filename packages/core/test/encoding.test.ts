import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CoreFailure, operationId, operationPreimage, outputId, receiptInfo, validateOperationShape } from "../src/index.js";
import type { OperationRequest } from "../src/index.js";

type Input = {
  chainId: string; pool: Address; kind: OperationRequest["kind"]; owner: Address;
  salt: Hex; inputIds: Hex[]; d: string; w: string; destination: Address;
  outputs: { owner: Address; Cx: string; Cy: string; receiptFormat: 1; packet: Hex }[];
};
type Vector = { id: string; input: Input; expected: { info: { hash: Hex; preimage: Hex }[]; operationId: Hex; operationPreimage: Hex; outputIds: { hash: Hex; preimage: Hex }[] } };
function load<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`../../../tests/vectors/cases/${name}.json`, import.meta.url), "utf8")) as T[];
}
const vectors = load<Vector>("operation");
function decode(input: Input) {
  return {
    context: { chainId: BigInt(input.chainId), pool: input.pool },
    request: { ...input, d: BigInt(input.d), w: BigInt(input.w), outputs: input.outputs.map(o => ({
      owner: o.owner, commitment: { x: BigInt(o.Cx), y: BigInt(o.Cy) }, receiptFormat: o.receiptFormat, packet: o.packet,
    })) } satisfies OperationRequest,
  };
}
function base(id = "VEC-01-TRANSFER-CHANGE") { return structuredClone(vectors.find(v => v.id === id)!.input); }

describe("AC-01: canonical operation encoding", () => {
  it.each(vectors)("matches $id", ({ input, expected }) => {
    const { context, request } = decode(input);
    expect(operationPreimage(context, request)).toBe(expected.operationPreimage);
    expect(operationId(context, request)).toBe(expected.operationId);
    expect(request.outputs.map((_, i) => receiptInfo(context, request, i))).toEqual(expected.info.map(i => i.hash));
    expect(request.outputs.map((_, i) => outputId(expected.operationId, i))).toEqual(expected.outputIds.map(i => i.hash));
    expect(() => validateOperationShape(request)).not.toThrow();
  });
});

type Binding = { id: string; baseCase: string; mutatedField: string; consumers: string[];
  input: { replacement: string | number }; expected: { operationId: Hex; operationPreimage: Hex; relation: string; baselineOperationId: Hex } };
it.each(load<Binding>("operation-binding").filter(v => v.consumers.includes("#29")))("AC-04: binds $id", vector => {
  const input = base(vector.baseCase);
  const field = vector.mutatedField;
  if (field.startsWith("outputs[0].")) {
    Object.assign(input.outputs[0]!, { [field.slice("outputs[0].".length)]: vector.input.replacement });
  } else if (field === "inputIds[0]") {
    input.inputIds[0] = vector.input.replacement as Hex;
  } else {
    Object.assign(input, { [field]: vector.input.replacement });
  }
  const { context, request } = decode(input);
  expect(operationPreimage(context, request)).toBe(vector.expected.operationPreimage);
  expect(operationId(context, request)).toBe(vector.expected.operationId);
  expect(operationId(context, request) === vector.expected.baselineOperationId).toBe(vector.expected.relation === "same");
});

it.each(load<{ id: string; input: Input; consumers: string[] }>("operation-rejected").filter(v => v.consumers.includes("#29")))("rejects $id", ({ input }) => {
  expect(() => validateOperationShape(decode(input).request)).toThrow(CoreFailure);
});

it("requires shape validation even when the request has a canonical operation ID", () => {
  const { context, request } = decode(base());
  request.d = 1n;
  expect(operationId(context, request)).toMatch(/^0x[0-9a-f]{64}$/);
  expect(() => validateOperationShape(request)).toThrow(CoreFailure);
});

it("binds output order and every packet byte while receipt info precedes encryption", () => {
  const { context, request } = decode(base());
  const id = operationId(context, request);
  const info = receiptInfo(context, request, 0);
  request.outputs.reverse();
  expect(operationId(context, request)).not.toBe(id);
  request.outputs.reverse();
  request.outputs[0]!.packet = "0x";
  expect(receiptInfo(context, request, 0)).toBe(info);
  expect(() => validateOperationShape(request)).toThrow(CoreFailure);
  request.outputs[0]!.packet = `${base().outputs[0]!.packet.slice(0, -2)}ff` as Hex;
  expect(operationId(context, request)).not.toBe(id);
  expect(receiptInfo(context, request, 0)).toBe(info);
});

const invalidMutations: [string, (r: OperationRequest) => void][] = [
  ["short owner", r => { r.owner = "0x01"; }],
  ["nonhex output owner", r => { r.outputs[0]!.owner = `0x${"zz".repeat(20)}`; }],
  ["short salt", r => { r.salt = "0x00"; }],
  ["short input", r => { r.inputIds[0] = "0x01"; }],
  ["negative amount", r => { r.d = -1n; }],
  ["non-bigint amount", r => { Object.assign(r, { w: 0 }); }],
  ["uint overflow", r => { r.w = 1n << 256n; }],
  ["off curve", r => { r.outputs[0]!.commitment = { x: 1n, y: 1n }; }],
  ["negative coordinate", r => { r.outputs[0]!.commitment = { x: -1n, y: 2n }; }],
  ["noncanonical coordinate", r => { r.outputs[0]!.commitment = { x: 1n << 256n, y: 2n }; }],
  ["long packet", r => { r.outputs[0]!.packet = `${r.outputs[0]!.packet}00`; }],
  ["nonhex packet", r => { r.outputs[0]!.packet = `0x${"gg".repeat(112)}`; }],
  ["no transfer inputs", r => { r.inputIds = []; }],
  ["three inputs", r => { r.inputIds = ["11", "22", "33"].map(v => `0x${v.repeat(32)}` as Hex); }],
  ["no transfer outputs", r => { r.outputs = []; }],
  ["three outputs", r => { r.outputs.push(r.outputs[0]!); }],
  ["change owner", r => { r.outputs[1]!.owner = r.outputs[0]!.owner; }],
];
it.each(invalidMutations)("rejects %s", (_, mutate) => {
  const { request } = decode(base());
  mutate(request);
  expect(() => validateOperationShape(request)).toThrow(CoreFailure);
});

it("enforces deposit and withdrawal bounds and output ownership", () => {
  const { request: deposit } = decode(base("VEC-01-DEPOSIT"));
  deposit.d = 1n << 64n;
  expect(() => validateOperationShape(deposit)).not.toThrow();
  deposit.d++;
  expect(() => validateOperationShape(deposit)).toThrow(CoreFailure);
  deposit.d = 1n;
  deposit.outputs[0]!.owner = base().outputs[0]!.owner;
  expect(() => validateOperationShape(deposit)).toThrow(CoreFailure);
  const { request: withdrawal } = decode(base("VEC-01-WITHDRAW-PARTIAL"));
  withdrawal.w = 1n << 65n;
  expect(() => validateOperationShape(withdrawal)).not.toThrow();
  withdrawal.w++;
  expect(() => validateOperationShape(withdrawal)).toThrow(CoreFailure);
  withdrawal.w = 0n;
  expect(() => validateOperationShape(withdrawal)).toThrow(CoreFailure);
  withdrawal.w = 1n;
  withdrawal.outputs[0]!.owner = base().outputs[0]!.owner;
  expect(() => validateOperationShape(withdrawal)).toThrow(CoreFailure);
});

it("rejects invalid indexes and accepts canonical identity pending amount verification", () => {
  const { context, request } = decode(base());
  request.outputs[0]!.commitment = { x: 0n, y: 0n };
  expect(() => validateOperationShape(request)).not.toThrow();
  for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => receiptInfo(context, request, index)).toThrow(CoreFailure);
    expect(() => outputId(operationId(context, request), index)).toThrow(CoreFailure);
  }
  expect(() => receiptInfo(context, request, 2)).toThrow(CoreFailure);
  expect(() => outputId("0x00", 0)).toThrow(CoreFailure);
  expect(() => outputId(operationId(context, request), 1n << 256n)).toThrow(CoreFailure);
});
