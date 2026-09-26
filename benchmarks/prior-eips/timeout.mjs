#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [secondsText, command, ...args] = process.argv.slice(2);
const seconds = Number(secondsText);
if (!Number.isFinite(seconds) || seconds <= 0 || !command) {
  throw new Error('usage: node timeout.mjs SECONDS COMMAND [ARGS...]');
}

const child = spawn(command, args, { stdio: 'inherit', detached: true });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}, seconds * 1000);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    console.error(`trial timed out after ${seconds} seconds`);
    process.exitCode = 124;
  } else {
    process.exitCode = code ?? (signal ? 1 : 0);
  }
});
