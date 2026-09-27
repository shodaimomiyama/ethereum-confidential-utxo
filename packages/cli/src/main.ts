import { readFile, stat } from "node:fs/promises";
import type { Writable } from "node:stream";
import { createWalletClient, http, publicActions } from "viem";
import { foundry, sepolia } from "viem/chains";
import type { Address, Hex } from "viem";
import type { BuildIntent, Context, RecipientInfo } from "@confidential-utxo/core";
import { createEthereumRpc, createHistoryPort, verifyEthereumDeployment } from "@confidential-utxo/ethereum";
import type { VerifiedDeployment } from "@confidential-utxo/ethereum";
import { readPrivateFile, replacePrivateFile } from "./atomic-file.js";
import { OwnerService } from "./owner.js";
import { decodeRecipientInfo } from "./public-files.js";
import { classifyError, privateBalance, renderResult } from "./render.js";
import type { CliResult } from "./render.js";
import { promptPassphrase, readLocalSigner } from "./secret-input.js";
import type { SecretInput, SecretOutput } from "./secret-input.js";
import { readOwnerState } from "./state.js";
import { decimalWei, hexBytes, parseExactObject } from "./strict-json.js";
import { SubmitterService } from "./submitter.js";

export type CliIO = { stdin: SecretInput; stdout: Writable & {isTTY?: boolean}; stderr: SecretOutput;
  stdinTTY: boolean; stdoutTTY: boolean; stderrTTY: boolean };
type Options = Record<string, string | string[]>;
function invalid(): never { throw new Error("CLI_INPUT"); }
function value(options: Options, name: string): string {
  const found = options[name];
  if (typeof found !== "string" || found.length === 0) invalid();
  return found;
}
function optional(options: Options, name: string): string | undefined {
  const found = options[name];
  return typeof found === "string" ? found : undefined;
}
function address(source: string): Address { return hexBytes(source, 20) as Address; }
function hash(source: string): Hex { return hexBytes(source, 32); }
function parse(argv: readonly string[]) {
  const command = argv[0] === "key" || argv[0] === "passphrase" ? `${argv[0]} ${argv[1] ?? ""}` : argv[0] ?? "";
  const start = command.includes(" ") ? 2 : 1;
  const options: Options = {};
  let json = false;
  for (let index = start; index < argv.length; index++) {
    const item = argv[index]!;
    if (item === "--json") { if (json) invalid(); json = true; continue; }
    if (!/^--[a-z][a-z-]*$/.test(item)) invalid();
    const name = item.slice(2);
    const next = argv[++index];
    if (!next || next.startsWith("--")) invalid();
    if (name === "input-id") {
      const list = options[name] ?? [];
      if (!Array.isArray(list) || list.length >= 2) invalid();
      list.push(next); options[name] = list;
    } else {
      if (options[name] !== undefined) invalid();
      options[name] = next;
    }
  }
  return { command, options, json };
}
const ownerBase = ["store", "owner"];
const ownerOnline = [...ownerBase, "manifest", "rpc"];
const senderBase = ["journal", "manifest", "rpc", "signer", "submitter"];
const schemas: Record<string, {required: string[]; optional?: string[]}> = {
  init: { required: ownerOnline }, "key add": { required: ownerBase },
  "key select": { required: [...ownerBase, "key-id"] },
  recipient: { required: [...ownerBase, "signer", "out"] },
  sync: { required: ownerOnline }, balance: { required: ownerBase }, utxos: { required: ownerBase },
  create: { required: [...ownerOnline, "kind", "amount-file"], optional: ["recipient", "change-recipient", "destination", "input-id"] },
  prove: { required: [...ownerBase, "id"] },
  abandon: { required: [...ownerBase, "id"] },
  authorize: { required: [...ownerBase, "id", "signer"] },
  export: { required: [...ownerBase, "id", "out"] },
  submit: { required: [...senderBase, "public"] },
  retry: { required: [...senderBase, "id"] },
  "replace-fee": { required: [...senderBase, "attempt-id", "max-fee-per-gas", "max-priority-fee-per-gas"] },
  operation: { required: ["id"], optional: [...ownerBase, ...senderBase] },
  backup: { required: [...ownerBase, "out"] },
  restore: { required: [...ownerBase, "backup"] },
  "passphrase change": { required: ownerBase },
};
function validate(command: string, options: Options) {
  const schema = schemas[command];
  if (!schema) invalid();
  const allowed = new Set([...schema.required, ...(schema.optional ?? [])]);
  if (schema.required.some(name => options[name] === undefined) ||
      Object.keys(options).some(name => !allowed.has(name))) invalid();
  if (command === "operation") {
    const hasStore = options.store !== undefined;
    const hasJournal = options.journal !== undefined;
    if (hasStore === hasJournal) invalid();
    const required = hasStore ? ownerBase : senderBase;
    if (required.some(name => options[name] === undefined)) invalid();
    const specific = new Set(["id", ...required]);
    if (Object.keys(options).some(name => !specific.has(name))) invalid();
  }
}
async function readBounded(path: string, max = 2 * 1024 * 1024): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) invalid();
  return readFile(path);
}
async function online(options: Options) {
  const rpcUrl = value(options, "rpc");
  const manifestBytes = await readBounded(value(options, "manifest"), 1024 * 1024);
  const manifest = parseExactObject(manifestBytes, ["schemaVersion", "chainId", "hardfork", "signer", "tool", "artifacts", "parametersHash", "pool", "verifier"]);
  const mode = manifest.chainId === 31337 ? "local-simulated" : "finalized";
  const rpc = createEthereumRpc({ url: rpcUrl, mode });
  const verified = await verifyEthereumDeployment(rpc.client, manifest, mode);
  const history = createHistoryPort(verified, rpc.client, rpc.policy);
  return { rpc, verified, history };
}
async function recipientFile(path: string, context: Context): Promise<RecipientInfo> {
  const bytes = await readBounded(path, 4096);
  const raw = parseExactObject(bytes, ["schemaVersion", "chainId", "pool", "owner", "receivePublicKey", "receiptFormat", "recipientInfoVersion", "signature"]);
  return decodeRecipientInfo(bytes, context, address(raw.owner as string));
}
async function intent(options: Options, context: Context, owner: Address): Promise<BuildIntent> {
  const kind = value(options, "kind");
  const amountBytes = await readPrivateFile(value(options, "amount-file"), 4096);
  let amount: bigint;
  try { amount = decimalWei(parseExactObject(amountBytes, ["amountWei"]).amountWei); }
  finally { amountBytes.fill(0); }
  const explicitIds = (options["input-id"] as string[] | undefined)?.map(hash);
  if (kind === "deposit") {
    if (optional(options, "destination") || optional(options, "change-recipient") || explicitIds) invalid();
    return { kind: 0, owner, amount, recipient: await recipientFile(value(options, "recipient"), context) };
  }
  if (kind === "transfer") {
    if (optional(options, "destination")) invalid();
    return { kind: 1, owner, amount, recipient: await recipientFile(value(options, "recipient"), context),
      ...(optional(options, "change-recipient") ? { changeRecipient: await recipientFile(value(options, "change-recipient"), context) } : {}),
      ...(explicitIds ? { explicitIds } : {}) };
  }
  if (kind === "withdraw") {
    if (optional(options, "recipient")) invalid();
    return { kind: 2, owner, amount, destination: address(value(options, "destination")),
      ...(optional(options, "change-recipient") ? { changeRecipient: await recipientFile(value(options, "change-recipient"), context) } : {}),
      ...(explicitIds ? { explicitIds } : {}) };
  }
  invalid();
}
async function submitter(options: Options, verified: VerifiedDeployment, history: ReturnType<typeof createHistoryPort>,
  client: ReturnType<typeof createEthereumRpc>["client"]): Promise<SubmitterService> {
  const signer = await readLocalSigner(value(options, "signer"), address(value(options, "submitter")));
  const chain = verified.context.chainId === 31337n ? foundry : sepolia;
  if (BigInt(chain.id) !== verified.context.chainId) invalid();
  const wallet = createWalletClient({ account: signer, chain, transport: http(value(options, "rpc")) }).extend(publicActions);
  return new SubmitterService(wallet, history, client);
}
async function perform(command: string, options: Options, io: CliIO): Promise<CliResult> {
  const secret = (mode: "unlock" | "new" | "change") => promptPassphrase(mode, io.stdin, io.stderr);
  const owner = options.owner ? address(value(options, "owner")) : undefined;
  const service = owner ? new OwnerService({ dir: value(options, "store"), owner,
    manifestPath: optional(options, "manifest") ?? "", rpcUrl: optional(options, "rpc") ?? "" }) : undefined;
  if (command === "init") {
    const pass = await secret("new");
    try { return await service!.init(pass); } finally { pass.fill(0); }
  }
  if (command === "restore") {
    const bytes = await readBounded(value(options, "backup"), 16 * 1024 * 1024);
    const pass = await secret("unlock");
    try { return await service!.restore(bytes, value(options, "store"), pass); } finally { pass.fill(0); }
  }
  if (command === "submit" || command === "retry" || command === "replace-fee" ||
      (command === "operation" && options.journal)) {
    const remote = await online(options);
    const client = await submitter(options, remote.verified, remote.history, remote.rpc.client);
    if (command === "submit") return client.submit(await readBounded(value(options, "public")),
      value(options, "signer"), value(options, "journal"), remote.verified);
    if (command === "retry") return client.retry(hash(value(options, "id")), value(options, "signer"),
      value(options, "journal"), remote.verified);
    if (command === "replace-fee") return client.replaceFee(hash(value(options, "attempt-id")),
      decimalWei(value(options, "max-fee-per-gas")), decimalWei(value(options, "max-priority-fee-per-gas")),
      value(options, "signer"), value(options, "journal"), remote.verified);
    return client.inspect(hash(value(options, "id")), value(options, "journal"), remote.verified);
  }
  if (!service) invalid();
  if (command === "passphrase change") {
    const oldPass = await secret("unlock");
    try {
      const newPass = await secret("change");
      try { return await service.changePassphrase(oldPass, newPass); }
      finally { newPass.fill(0); }
    } finally { oldPass.fill(0); }
  }
  const pass = await secret("unlock");
  try {
    switch (command) {
      case "key add": return await service.addReceiptKey(pass);
      case "key select": return await service.selectReceiptKey(hash(value(options, "key-id")), pass);
      case "recipient": {
        const bytes = await service.recipientInfo(pass, value(options, "signer"));
        await replacePrivateFile(value(options, "out"), bytes);
        return { kind: "recipient", owner: owner!, path: value(options, "out") };
      }
      case "sync": return await service.sync(pass);
      case "balance": return await service.balance(pass);
      case "utxos": {
        const state = await readOwnerState(value(options, "store"), pass, undefined, owner);
        const synced = state.sync;
        if (state.restoration !== "ready" || synced?.status !== "complete")
          return { kind: "utxos", status: "stale", entries: [] };
        return { kind: "utxos", status: "complete", checkpoint: synced.checkpoint,
          entries: synced.utxos.map(item => ({ id: item.id, status: item.status,
            amount: privateBalance(item.opening.amount) })), receiptFailures: synced.receiptFailures };
      }
      case "create": {
        const state = await readOwnerState(value(options, "store"), pass, undefined, owner);
        return await service.create(await intent(options, state.context, owner!), pass);
      }
      case "prove": return await service.prove(hash(value(options, "id")), pass);
      case "abandon": return await service.abandon(hash(value(options, "id")), pass);
      case "authorize": return await service.authorize(hash(value(options, "id")), pass, value(options, "signer"));
      case "export": {
        const id = hash(value(options, "id"));
        await service.exportPublic(id, pass, value(options, "out"));
        return { kind: "export", operationId: id, path: value(options, "out") };
      }
      case "operation": return await service.inspect(hash(value(options, "id")), pass);
      case "backup": {
        const backupPass = await secret("new");
        try { return await service.backup(value(options, "out"), pass, backupPass); }
        finally { backupPass.fill(0); }
      }
      default: invalid();
    }
  } finally { pass.fill(0); }
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const format = argv.includes("--json") ? "json" : "human";
  try {
    if (argv[0] === "help" || argv[0] === "--help") {
      if (format === "json") io.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: "help", commands: Object.keys(schemas) })}\n`);
      else io.stdout.write(`Commands: ${Object.keys(schemas).join(", ")}\n`);
      return 0;
    }
    const parsed = parse(argv);
    validate(parsed.command, parsed.options);
    const result = await perform(parsed.command, parsed.options, io);
    return renderResult(result, { stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutTTY }, parsed.json ? "json" : "human");
  } catch (error) {
    return renderResult(classifyError(error), { stdout: io.stdout, stderr: io.stderr, isTTY: io.stdoutTTY }, format);
  }
}
