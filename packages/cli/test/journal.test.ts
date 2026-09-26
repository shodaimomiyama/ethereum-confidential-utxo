import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildOperation, operationId, recipientInfoTypedData, toPublicSubmission } from "@confidential-utxo/core";
import { privateKeyToAccount } from "viem/accounts";
import { encodePoolSubmission } from "@confidential-utxo/ethereum";
import type { PreparedSend } from "@confidential-utxo/ethereum";
import type { Hex } from "viem";
import { appendPrepared, listAttempts, recordSendResult } from "../src/journal.js";
import { createAtomicFiles, replacePrivateFile } from "../src/atomic-file.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const vector = JSON.parse(readFileSync(new URL("../../../tests/vectors/cases/pool-operations.json", import.meta.url), "utf8"))[0];
const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const alice = privateKeyToAccount(`0x${"01".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"02".repeat(32)}`);
const submitter = privateKeyToAccount(`0x${"03".repeat(32)}`);
const binding = { chainId: 31337n, pool: vector.input.pool as Hex, submitter: submitter.address };
const context = { chainId: binding.chainId, pool: binding.pool, deploymentBlock: 1n,
  verifier: binding.pool, parametersHash: hash("00"), finalityMode: "local-simulated" as const };

function aliceIntent(): PreparedSend {
  const input = vector.input;
  const request = { kind: 0 as const, owner: input.owner as Hex, salt: input.salt as Hex,
    inputIds: [] as Hex[], outputs: input.outputs.map((item: any) => ({ owner: item.owner as Hex,
      commitment: { x: BigInt(item.Cx), y: BigInt(item.Cy) }, receiptFormat: 1 as const, packet: item.packet as Hex })),
    d: BigInt(input.d), w: 0n, destination: input.destination as Hex };
  const submission = { request, balanceProof: {
    Rx: BigInt(vector.expected.balanceProof.Rx), Ry: BigInt(vector.expected.balanceProof.Ry),
    s: BigInt(vector.expected.balanceProof.s) }, rangeProofs: [], signature: vector.expected.signature as Hex };
  const call = encodePoolSubmission(submission);
  return { operationId: operationId(context, request), account: submitter.address, request: submission,
    calldata: call.data, value: call.value, nonce: 7, gas: 100000n,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };
}
async function bobIntent(): Promise<PreparedSend> {
  const key = new Uint8Array(32).fill(9);
  // Node X25519 public key corresponding to the test scalar.
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const privateObject = createPrivateKey({ key: Buffer.from(`302e020100300506032b656e04220420${Buffer.from(key).toString("hex")}`, "hex"), format: "der", type: "pkcs8" });
  const publicKey = `0x${createPublicKey(privateObject).export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as Hex;
  const unsigned = { chainId: context.chainId, pool: context.pool, owner: bob.address,
    receivePublicKey: publicKey, receiptFormat: 1 as const, recipientInfoVersion: 1 as const };
  const recipient = { ...unsigned, signature: await bob.signTypedData(recipientInfoTypedData(context, unsigned, bob.address)) };
  const draft = await buildOperation({ kind: 0, owner: bob.address, amount: 1n, recipient }, context,
    { inputs: [], randomSalt: () => new Uint8Array(32).fill(8) });
  const signature = await bob.signTypedData({ domain: { name: "Ethereum Confidential UTXO", version: "1", chainId: context.chainId, verifyingContract: context.pool },
    primaryType: "OperationAuthorization", types: { OperationAuthorization: [
      { name: "operationId", type: "bytes32" }, { name: "owner", type: "address" },
      { name: "authScheme", type: "uint8" }, { name: "authVersion", type: "uint8" },
    ] }, message: { operationId: draft.operationId, owner: bob.address, authScheme: 1, authVersion: 1 } });
  const submission = toPublicSubmission({ ...draft, signature });
  const call = encodePoolSubmission(submission);
  return { operationId: draft.operationId, account: submitter.address, request: submission,
    calldata: call.data, value: call.value, nonce: 8, gas: 100000n,
    maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };
}

it("stores only public attempts for two owners and rejects binding or secret fields", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "cutxo-journal-")), "submitter"); roots.push(join(dir, ".."));
  const first = aliceIntent(); const second = await bobIntent();
  expect(await appendPrepared(dir, binding, first, hash("a1"))).toBe("saved");
  expect(await appendPrepared(dir, binding, second, hash("b2"))).toBe("saved");
  expect((await listAttempts(dir, binding)).map(item => item.operationId)).toEqual([first.operationId, second.operationId]);
  expect((await listAttempts(dir, binding)).map(item => item.owner.toLowerCase())).toEqual([alice.address.toLowerCase(), bob.address.toLowerCase()]);
  await expect(listAttempts(dir, { ...binding, pool: bob.address })).rejects.toThrow();
  await expect(listAttempts(dir, { ...binding, chainId: 1n })).rejects.toThrow();
  await expect(listAttempts(dir, { ...binding, submitter: alice.address })).rejects.toThrow();
  await expect(appendPrepared(dir, binding, first, hash("a1"))).rejects.toThrow();
  await expect(appendPrepared(dir, binding, { ...second, nonce: 7 }, hash("c3"))).rejects.toThrow();
  await expect(appendPrepared(dir, binding, { ...second, calldata: hash("ff") }, hash("c3"))).rejects.toThrow();
  await expect(appendPrepared(dir, binding, { ...second, operationId: hash("ff") }, hash("c3"))).rejects.toThrow();
  const path = join(dir, "journal.json");
  const file = JSON.parse(await readFile(path, "utf8"));
  file.secretKey = "0xdead";
  await writeFile(path, JSON.stringify(file));
  await expect(listAttempts(dir, binding)).rejects.toThrow();
});

it("keeps whole journal generations around every write stage in a fresh process", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-journal-")); roots.push(root);
  const dir = join(root, "submitter");
  const first = aliceIntent(); const second = await bobIntent();
  expect(await appendPrepared(dir, binding, first, hash("a1"))).toBe("saved");
  const original = await readFile(join(dir, "journal.json"));
  const reader = `import { listAttempts } from ${JSON.stringify(new URL("../dist/journal.js", import.meta.url).href)};
    const binding = { chainId: 31337n, pool: ${JSON.stringify(binding.pool)}, submitter: ${JSON.stringify(binding.submitter)} };
    process.stdout.write(JSON.stringify((await listAttempts(process.argv[1], binding)).map(item => item.operationId)));`;
  for (const phase of ["after-temp-create", "after-write", "after-file-sync", "after-rename", "after-dir-sync"] as const) {
    await replacePrivateFile(join(dir, "journal.json"), original);
    const atomic = createAtomicFiles(async point => { if (point === phase) throw new Error("interrupted"); });
    expect(await appendPrepared(dir, binding, second, hash("b2"), atomic.replacePrivateFile)).toBe("unknown");
    const child = spawn(process.execPath, ["--input-type=module", "-e", reader, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let stderr = "";
    child.stdout.on("data", data => { output += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `reader exit ${code}`)));
      child.once("error", reject);
    });
    expect(JSON.parse(output)).toEqual(["after-temp-create", "after-write", "after-file-sync"].includes(phase) ?
      [first.operationId] : [first.operationId, second.operationId]);
  }
});

it("keeps both attempts when separate processes race for the writer lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-journal-")); roots.push(root);
  const dir = join(root, "submitter");
  const first = aliceIntent(); const second = await bobIntent();
  const payload = JSON.stringify({ dir, binding: { ...binding, chainId: binding.chainId.toString() },
    intent: second, attemptId: hash("b2") }, (_, value) => typeof value === "bigint" ? value.toString() : value);
  const script = `import { appendPrepared } from ${JSON.stringify(new URL("../dist/journal.js", import.meta.url).href)};
    const input = JSON.parse(process.argv[1], (key, value) => {
      if (typeof value === "string" && /^\\d+$/.test(value) && ["d","w","x","y","Rx","Ry","s","value","gas","maxFeePerGas","maxPriorityFeePerGas"].includes(key)) return BigInt(value);
      if (["coords","scalars","ls","rs"].includes(key)) return value.map(BigInt);
      return value;
    });
    input.binding.chainId = BigInt(input.binding.chainId);
    for (let i = 0; i < 30; i++) {
      try { const result = await appendPrepared(input.dir, input.binding, input.intent, input.attemptId); if (result !== "saved") throw new Error(result); process.exit(0); }
      catch (error) { if (String(error).includes("STORE_LOCKED") || error?.code === "ENOENT") await new Promise(resolve => setTimeout(resolve, 10)); else throw error; }
    }
    throw new Error("lock timeout");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, payload], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += String(data); });
  const childDone = new Promise<void>((resolve, reject) => {
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `child exit ${code}`)));
    child.once("error", reject);
  });
  let firstSaved = false;
  for (let i = 0; i < 30 && !firstSaved; i++) {
    try { firstSaved = await appendPrepared(dir, binding, first, hash("a1")) === "saved"; }
    catch (error) {
      if (!String(error).includes("STORE_LOCKED")) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  expect(firstSaved).toBe(true);
  await childDone;
  expect((await listAttempts(dir, binding)).map(item => item.operationId).sort()).toEqual([first.operationId, second.operationId].sort());
});

it("never treats an orphan prepared entry as proof that nothing was sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutxo-journal-")); roots.push(root);
  const dir = join(root, "submitter");
  const intent = aliceIntent();
  expect(await appendPrepared(dir, binding, intent, hash("a1"))).toBe("saved");
  expect((await listAttempts(dir, binding))[0]?.state).toBe("unknown");
  const result = { operationId: intent.operationId, account: intent.account, request: intent.request,
    calldata: intent.calldata, value: intent.value, nonce: intent.nonce, gas: intent.gas,
    maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
    attempt: { outer: "pending" as const, txHash: hash("cc") }, attempts: [{ outer: "pending" as const, txHash: hash("cc") }] };
  expect(await recordSendResult(dir, binding, hash("a1"), result)).toBe("saved");
  expect((await listAttempts(dir, binding))[0]).toMatchObject({ state: "pending", txHash: hash("cc") });
});
