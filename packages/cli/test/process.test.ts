import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commit } from "@confidential-utxo/crypto";
import { initializeOwnerState, readOwnerState } from "../src/state.js";
import type { WalletStateV1 } from "../src/state.js";
import { privateBalance, renderResult } from "../src/render.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bin = new URL("../dist/bin.js", import.meta.url).pathname;
it("shows fixed Pay conditions while keeping its amount out of JSON", () => {
  const amount = 123456789n;
  const result = { kind: "payment" as const, operationId: `0x${"11".repeat(32)}` as const,
    paymentId: `0x${"22".repeat(32)}` as const, status: "prepared",
    confirmation: { inputId: `0x${"33".repeat(32)}` as const, amount: privateBalance(amount),
      token: `0x${"44".repeat(20)}` as const, minAmountOut: 15n,
      recipient: `0x${"55".repeat(20)}` as const, deadline: 1000n } };
  const render = (format: "human" | "json") => {
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) {
      output += String(chunk); callback();
    } });
    expect(renderResult(result, { stdout: stream, stderr: stream, isTTY: true }, format)).toBe(0);
    return output;
  };
  const json = render("json");
  expect(JSON.parse(json)).toMatchObject({ status: "prepared", confirmation: {
    inputId: result.confirmation.inputId, minAmountOut: "15", deadline: "1000" } });
  expect(json).not.toContain(amount.toString());
  expect(render("human")).toContain(`paymentWei=${amount}`);
});
async function collectProcess(command: string, args: string[], input = "") {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("exit", value => resolve(value ?? -1)); child.once("error", reject);
  });
  return { code, stdout, stderr };
}

async function terminalProcess(args: string[]) {
  const root = await mkdtemp(join(tmpdir(), "cutxo-expect-")); roots.push(root);
  const script = join(root, "terminal.exp");
  await writeFile(script, 'set timeout 30\nspawn {*}$argv\nexpect {\n  -re {(Passphrase|passphrase): } { send -- "secret\\r"; exp_continue }\n  eof {}\n}\nexit [lindex [wait] 3]\n');
  const child = spawn("expect", [script, process.execPath, bin, ...args],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("exit", value => resolve(value ?? -1)); child.once("error", reject);
  });
  return { code, output };
}

it("returns a single public JSON error for unknown, duplicate and incomplete commands", async () => {
  for (const args of [
    ["unknown", "--json"],
    ["balance", "--json", "--json"],
    ["create", "--json", "--store", "/tmp/never-created", "--owner", "0x1111111111111111111111111111111111111111",
      "--manifest", "/tmp/manifest", "--rpc", "http://127.0.0.1:1", "--kind", "deposit", "--amount", "123456789"],
    ["init", "--store", "/tmp/never-created", "--owner", "0x1111111111111111111111111111111111111111", "--json"],
  ]) {
    const output = await collectProcess(process.execPath, [bin, ...args]);
    expect(output.code).toBe(2);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({ schemaVersion: 1, kind: "error",
      reason: "INVALID_OR_INCOMPLETE_INPUT", allowedActions: ["help"] });
    expect(output.stdout + output.stderr).not.toContain("Error:");
  }
});

it("advertises the reward and Pay replay commands", async () => {
  const output = await collectProcess(process.execPath, [bin, "help", "--json"]);
  expect(output.code).toBe(0);
  const commands = JSON.parse(output.stdout).commands as string[];
  for (const command of ["reward request", "reward list", "reward status", "reward received",
    "pay quote", "pay prepare", "pay authorize", "pay export", "pay submit",
    "pay status", "pay resume", "pay retry", "pay change-terms"]) {
    expect(commands).toContain(command);
  }
});

it("rejects non-TTY unlock without exposing a cached private amount", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-process-")); roots.push(root);
  const store = join(root, "owner");
  const owner = "0x1111111111111111111111111111111111111111" as const;
  const pool = "0x2222222222222222222222222222222222222222" as const;
  const context = { chainId: 31337n, pool, deploymentBlock: 1n, verifier: pool,
    parametersHash: `0x${"ab".repeat(32)}` as const, finalityMode: "local-simulated" as const };
  const checkpoint = { number: 1n, hash: `0x${"ab".repeat(32)}` as const, mode: "local-simulated" as const };
  const privateWei = 123456789n;
  const opening = { amount: privateWei, blinding: 1n };
  const state: WalletStateV1 = { schemaVersion: 1, context, owner, receiptKeys: [], activeReceiptKeyId: null,
    operations: {}, restoration: "ready", sync: { status: "complete",
      checkpoint, utxos: [{ id: `0x${"cc".repeat(32)}`, owner, opening, commitment: commit(opening),
        checkpoint, status: "available", chainId: context.chainId, pool }],
      receiptFailures: [], availableWei: privateWei } };
  await initializeOwnerState(store, new TextEncoder().encode("secret"), state);
  expect((await readOwnerState(store, new TextEncoder().encode("secret"), undefined, owner)).sync?.status).toBe("complete");
  const output = await collectProcess(process.execPath, [bin, "balance", "--json", "--store", store, "--owner", owner], "secret\n");
  expect(output.code).toBe(2);
  expect(output.stdout + output.stderr).not.toContain("secret");
  expect(output.stdout + output.stderr).not.toContain(privateWei.toString());
  expect(JSON.parse(output.stdout)).toMatchObject({ kind: "error", code: "INPUT" });
  const terminal = await terminalProcess(["balance", "--json", "--store", store, "--owner", owner]);
  const jsonLines = terminal.output.split(/\r?\n/).filter(line => line.startsWith("{"));
  expect(jsonLines, JSON.stringify(terminal)).toHaveLength(1);
  expect(JSON.parse(jsonLines[0]!), JSON.stringify(terminal)).toMatchObject({ kind: "balance", status: "available" });
  expect(terminal.output).not.toContain(privateWei.toString());
  const wrongOwner = await terminalProcess(["balance", "--json", "--store", store,
    "--owner", "0x3333333333333333333333333333333333333333"]);
  expect(wrongOwner.code).toBe(3);
  expect(wrongOwner.output).not.toContain(privateWei.toString());
  expect(wrongOwner.output).not.toContain("Error:");
  expect(wrongOwner.output).toContain('"code":"STORAGE"');
});
