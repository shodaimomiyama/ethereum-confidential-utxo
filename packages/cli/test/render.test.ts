import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { CoreFailure } from "@confidential-utxo/core";
import { EthereumFailure } from "@confidential-utxo/ethereum";
import type { Hex } from "viem";
import { classifyError, privateBalance, renderResult } from "../src/render.js";

function capture(isTTY: boolean) {
  let stdout = "";
  let stderr = "";
  const output = new Writable({ write(chunk, _, done) { stdout += String(chunk); done(); } });
  const error = new Writable({ write(chunk, _, done) { stderr += String(chunk); done(); } });
  return { io: { stdout: output, stderr: error, isTTY }, output: () => stdout, error: () => stderr };
}
it("never renders a private balance through JSON or redirected output", () => {
  const result = { kind: "balance" as const, status: "available" as const, amount: privateBalance(123456789n),
    checkpoint: { number: 17n, hash: `0x${"ab".repeat(32)}` as Hex, mode: "finalized" as const } };
  const redirectedJson = capture(false);
  expect(renderResult(result, redirectedJson.io, "json")).toBe(0);
  expect(redirectedJson.output() + redirectedJson.error()).not.toContain("123456789");
  expect(JSON.parse(redirectedJson.output())).toMatchObject({ schemaVersion: 1, kind: "balance", status: "available", checkpoint: { number: "17" } });
  const redirectedHuman = capture(false);
  expect(renderResult(result, redirectedHuman.io, "human")).toBe(0);
  expect(redirectedHuman.output() + redirectedHuman.error()).not.toContain("123456789");
  const terminal = capture(true);
  expect(renderResult(result, terminal.io, "human")).toBe(0);
  expect(terminal.output()).toContain("123456789");
});
it("renders only public operation fields and uses distinct exit classes", () => {
  const output = capture(false);
  expect(renderResult({ kind: "operation", operationId: `0x${"11".repeat(32)}`, status: "executed" }, output.io, "json")).toBe(0);
  expect(JSON.parse(output.output())).toEqual({ schemaVersion: 1, kind: "operation", operationId: `0x${"11".repeat(32)}`, status: "executed" });
  expect(renderResult({ kind: "operation", operationId: `0x${"11".repeat(32)}`, status: "unknown" }, capture(false).io, "json")).toBe(4);
  expect(renderResult({ kind: "operation", operationId: `0x${"11".repeat(32)}`, status: "competing" }, capture(false).io, "json")).toBe(5);
});
it("shows public IDs for excluded undecryptable outputs without private amounts", () => {
  const failures = [{ outputId: `0x${"aa".repeat(32)}` as Hex, status: "unknown" as const, reason: "DECRYPT" as const }];
  for (const result of [
    { kind: "sync" as const, status: "complete" as const, receiptFailures: failures },
    { kind: "balance" as const, status: "available" as const,
      amount: privateBalance(123456789n), receiptFailures: failures },
    { kind: "utxos" as const, status: "complete" as const, entries: [], receiptFailures: failures },
  ]) {
    const stream = capture(false);
    expect(renderResult(result, stream.io, "json")).toBe(0);
    expect(JSON.parse(stream.output())).toMatchObject({ receiptFailures: failures });
    expect(stream.output()).not.toContain("123456789");
  }
});
it("maps failures to stable public classes without provider exception text", () => {
  const variants = [
    [new CoreFailure("INVALID_INPUT", "private: password"), 2],
    [new CoreFailure("STORAGE_UNKNOWN", "private: password"), 3],
    [new EthereumFailure("STORAGE_UNKNOWN", "private: journal"), 3],
    [new EthereumFailure("RPC", "private: token"), 4],
    [new EthereumFailure("OUTER_REVERT", "private: token"), 5],
  ] as const;
  for (const [error, code] of variants) {
    const result = classifyError(error);
    const stream = capture(false);
    expect(renderResult(result, stream.io, "json")).toBe(code);
    expect(stream.output() + stream.error()).not.toContain("private:");
  }
});
