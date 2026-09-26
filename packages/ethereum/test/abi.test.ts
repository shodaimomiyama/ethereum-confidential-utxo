import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { decodeEventLog, toEventSelector, toFunctionSelector } from "viem";
import { poolAbi, verifierAbi } from "../src/abi.js";

const verifyPoolRecord: (record: unknown, artifact: unknown) => unknown =
  createRequire(import.meta.url)("../../../scripts/pool-artifact.mjs").verifyPoolRecord;

const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("generated Ethereum ABI", () => {
  it("keeps both exported ABIs identical to their fixed artifact records", () => {
    expect(poolAbi).toEqual(load("packages/ethereum/generated/pool-v1.json").abi);
    expect(verifierAbi).toEqual(load("packages/ethereum/generated/verifier-v3.json").abi);
  });

  it("exposes the fixed Pool entrypoints and events", () => {
    const functions = poolAbi.filter(item => item.type === "function");
    expect(functions.map(item => item.name).sort()).toEqual([
      "deposit", "getAccounting", "getUtxo", "isOperationExecuted", "transfer", "verifier", "withdraw",
    ]);
    const deposit = functions.find(item => item.name === "deposit");
    expect(deposit?.inputs.map(input => input.type)).toEqual(["tuple", "tuple", "bytes"]);
    expect(poolAbi.filter(item => item.type === "event").map(item => item.name).sort()).toEqual([
      "InputConsumed", "OperationSucceeded", "OutputCreated",
    ]);
    expect(toFunctionSelector("deposit((uint8,address,bytes32,bytes32[],(address,uint256,uint256,uint8,bytes)[],uint256,uint256,address),(uint256,uint256,uint256),bytes)"))
      .toBe("0x" + load("packages/ethereum/generated/pool-v1.json").methodIdentifiers["deposit((uint8,address,bytes32,bytes32[],(address,uint256,uint256,uint8,bytes)[],uint256,uint256,address),(uint256,uint256,uint256),bytes)"]);
  });

  it("decodes the independent VEC-06 Pool event bytes", () => {
    const item = load("tests/vectors/cases/abi-observation.json").find((entry: { id: string }) => entry.id === "VEC-06-LOG-DEPOSIT");
    expect(item).toBeTruthy();
    for (const log of item.expected.logs) {
      const decoded = decodeEventLog({ abi: poolAbi, topics: log.topics, data: log.data });
      expect(decoded.eventName).toBe(log.name);
      const event = poolAbi.find(entry => entry.type === "event" && entry.name === log.name);
      if (!event || event.type !== "event") throw new Error(`missing event ${log.name}`);
      expect(log.topics[0]).toBe(toEventSelector(event));
    }
  });

  it("rejects ABI tuple and indexed-location mutations in an artifact record", () => {
    const artifact = load("contracts/out/Pool.sol/Pool.json");
    const original = load("packages/ethereum/generated/pool-v1.json");
    const tupleMutation = structuredClone(original);
    tupleMutation.abi.find((item: { name: string }) => item.name === "deposit")
      .inputs[0].components[4].components[1].type = "uint128";
    expect(() => verifyPoolRecord(tupleMutation, artifact)).toThrow();
    const indexedMutation = structuredClone(original);
    indexedMutation.abi.find((item: { name: string }) => item.name === "OutputCreated")
      .inputs[0].indexed = false;
    expect(() => verifyPoolRecord(indexedMutation, artifact)).toThrow();
  });
});
