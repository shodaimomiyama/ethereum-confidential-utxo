#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { run } from "./main.js";

process.exitCode = await run(process.argv.slice(2), {
  stdin, stdout, stderr,
  stdinTTY: Boolean(stdin.isTTY), stdoutTTY: Boolean(stdout.isTTY), stderrTTY: Boolean(stderr.isTTY),
});
