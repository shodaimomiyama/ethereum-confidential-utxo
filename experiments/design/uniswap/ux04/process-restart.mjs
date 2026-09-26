import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const persistence = join(here, ".cache", "process-restart");
rmSync(persistence, { recursive: true, force: true });
mkdirSync(persistence, { recursive: true });
const phases = [];
for (const name of ["init", "verify"]) {
  const child = spawnSync(process.execPath, [join(here, "process-phase.mjs"), name], { cwd: here, encoding: "utf8" });
  if (child.status !== 0) throw new Error(`${name} child failed: ${child.stderr}\n${child.stdout}`);
  const parsed = JSON.parse(child.stdout.trim());
  if (!parsed.passed || parsed.phase !== name) throw new Error(`${name} result invalid`);
  phases.push(parsed);
}
if (phases[0].pid === phases[1].pid) throw new Error("phase processes reused a PID");
const result = {
  experiment: "UX-04 separate-process restart",
  passed: true,
  runtime: { node: process.version, miniflare: "4.20260730.0", compatibilityDate: "2026-07-30", storage: "local SQLite Durable Object", deployment: false },
  method: "Two sequential independent Node child processes, each creating and disposing its own Miniflare/workerd instance, opened the same persistent directory.",
  phases,
  limits: ["Synthetic operation model, no production authentication, actual broadcast, finalized-chain reconciliation, or deployed Cloudflare persistence", "PID difference is only a process-independence check; durability conclusion is limited to this local storage runtime"]
};
writeFileSync(join(here, "process-restart-result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`UX-04 separate-process restart: ${phases[0].pid} -> ${phases[1].pid}, all assertions passed`);
