import { Miniflare } from "miniflare";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const persistence = join(here, ".cache", "sqlite");
const output = join(here, "result.json");
rmSync(persistence, { recursive: true, force: true });
mkdirSync(persistence, { recursive: true });
const options = {
  modules: true,
  scriptPath: join(here, "worker.mjs"),
  compatibilityDate: "2026-07-30",
  durableObjects: { STATE: { className: "State", useSQLite: true } },
  durableObjectsPersist: persistence,
  port: 0
};
let mf = new Miniflare(options);
const traces = [];
async function call(action, params = {}) {
  const response = await mf.dispatchFetch("http://local.test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...params }) });
  const body = await response.json();
  traces.push({ action, params, status: response.status, body });
  return body;
}
function check(value, label) { if (!value) throw new Error(label); }
try {
  const reserve = { inputId: "u1", owner: "alice", operationId: "pay-1", contentHash: "terms-a" };
  const cryptoProbe = await call("cryptoProbe");
  check(cryptoProbe.ok && cryptoProbe.value.nonceSamples === 1000 && cryptoProbe.value.aadChangeRejected && cryptoProbe.value.ciphertextChangeRejected, "ciphertext integrity and nonce samples");
  const concurrent = await Promise.all([call("reserve", reserve), call("reserve", { ...reserve, operationId: "withdraw-1", contentHash: "terms-b" })]);
  check(concurrent.filter(x => x.ok).length === 1 && concurrent.filter(x => !x.ok).length === 1, "concurrent reservation");
  check((await call("reserve", reserve)).value.operation_id === "pay-1", "lost reservation ACK retry");
  check(!(await call("revise", { inputId: "u1", owner: "alice", expectedRevision: 1, phase: "signed" })).ok, "stale revision");
  check((await call("revise", { inputId: "u1", owner: "alice", expectedRevision: 0, phase: "signed" })).ok, "revision update");
  check(!(await call("revise", { inputId: "u1", owner: "alice", expectedRevision: 0, phase: "replaced" })).ok, "repeated stale revision");
  const reward = { requestId: "r1", owner: "alice", contentHash: "amount-and-recipient-1", operationId: "transfer-1" };
  const twoRewards = await Promise.all([call("reward", reward), call("reward", { requestId: "r2", owner: "alice", contentHash: "amount-and-recipient-2", operationId: "transfer-2" })]);
  check(twoRewards.filter(x => x.ok).length === 1 && twoRewards.filter(x => !x.ok).length === 1, "parallel reward intents");
  check((await call("reward", reward)).value.operation_id === "transfer-1", "lost reward ACK retry");
  check(!(await call("reward", { ...reward, contentHash: "changed" })).ok, "immutable reward content");
  check(!(await call("broadcastUnknown", { requestId: "r1" })).ok, "broadcast before raw persistence");
  const tx = { requestId: "r1", rawTx: "0x01aabb", txHash: "0xhash1" };
  check((await call("prepare", tx)).ok, "persist signed transaction");
  check((await call("broadcastUnknown", { requestId: "r1" })).value.phase === "uncertain", "lost broadcast ACK");
  await mf.dispose();
  mf = new Miniflare(options);
  const restarted = await call("snapshot");
  check(restarted.value.rewards[0].raw_tx === tx.rawTx && restarted.value.rewards[0].phase === "uncertain", "restart persistence");
  check(!(await call("reward", { requestId: "r3", owner: "alice", contentHash: "new", operationId: "transfer-3" })).ok, "no new reward while uncertain");
  check((await call("prepare", tx)).value.tx_hash === tx.txHash, "same raw retry");
  check((await call("finalize", { requestId: "r1", txHash: tx.txHash })).value.phase === "finalized", "finalized reconciliation model");
  check((await call("reorg", { requestId: "r1" })).value.phase === "uncertain", "reorg quarantine");
  check(!(await call("reward", { requestId: "r4", owner: "alice", contentHash: "new", operationId: "transfer-4" })).ok, "reorg prevents new reward");
  const result = { experiment: "UX-04", passed: true, runtime: { miniflare: "4.20260730.0", compatibilityDate: options.compatibilityDate, storage: "SQLite Durable Object local workerd", restart: "Miniflare dispose then new instance using same persistent directory; Node controller process retained; see process-restart-result.json for independent Node process restart", deployment: false }, sources: ["https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/", "https://developers.cloudflare.com/durable-objects/platform/limits/"], scenarios: traces, finalSnapshot: (await call("snapshot")).value, limits: ["Model contract only, not production API/authentication or chain integration", "No actual broadcast, finalized-chain verification, rollback of persisted DB, or encrypted bundle persistence and key derivation", "Nonce uniqueness checked for 1000 draws only; not a proof against future random collisions", "No deployed Cloudflare persistence test", "Local workerd does not establish production Cloudflare Free behavior"] };
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(`UX-04 local model: ${traces.length} calls, all assertions passed`);
} finally {
  await mf.dispose();
}
