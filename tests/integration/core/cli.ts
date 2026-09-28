import { spawn } from "node:child_process";
import type { CoreAnvilFixture } from "./anvil.js";

const bin = new URL("../../../packages/cli/dist/bin.js", import.meta.url).pathname;

async function runTerminal(fixture: CoreAnvilFixture, args: string[], json: boolean): Promise<{ code: number; output: string }> {
  const child = spawn("expect", [fixture.terminalScript, process.execPath, bin, ...args, ...(json ? ["--json"] : [])],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("exit", value => resolve(value ?? -1));
    child.once("error", reject);
  });
  return { code, output };
}

export function createCli(fixture: CoreAnvilFixture) {
  async function readJsonResult(args: string[]): Promise<{ code: number; value: Record<string, unknown> }> {
    const started = Date.now();
    if (process.env.CORE_INTEGRATION_TRACE === "1") process.stderr.write(`core CLI start ${args[0]} ${args[1] === "add" ? "add" : ""}\n`);
    const result = await runTerminal(fixture, args, true);
    if (process.env.CORE_INTEGRATION_TRACE === "1") process.stderr.write(`core CLI end ${args[0]} ${Date.now() - started}ms exit=${result.code}\n`);
    const lines = result.output.split(/\r?\n/).filter(line => line.startsWith("{"));
    if (lines.length !== 1) throw new Error(`CLI ${args[0]} returned ${lines.length} JSON records`);
    const parsed: unknown = JSON.parse(lines[0]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`CLI ${args[0]} invalid JSON`);
    const value = parsed as Record<string, unknown>;
    return { code: result.code, value };
  }
  async function runJson(args: string[]): Promise<Record<string, unknown>> {
    const result = await readJsonResult(args);
    if (result.code !== 0 || result.value.kind === "error")
      throw new Error(`CLI ${args[0]} failed: ${String(result.value.code ?? "unknown")}`);
    return result.value;
  }
  async function readOwnerBalanceTTY(args: string[]): Promise<bigint> {
    const result = await runTerminal(fixture, args, false);
    if (result.code !== 0) throw new Error(`CLI ${args[0]} failed with exit ${result.code}`);
    const match = result.output.match(/(?:^|\r?\n)availableWei=(\d+)(?:\r?\n|$)/);
    if (!match) throw new Error("CLI balance omitted availableWei");
    return BigInt(match[1]!);
  }
  return { runOwnerCli: runJson, runSubmitterCli: runJson, runResultCli: readJsonResult, readOwnerBalanceTTY };
}
