import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const phase = process.argv[2];
const persistentPath = join(here, ".cache", "process-restart");
const mf = new Miniflare({
  modules: true,
  scriptPath: join(here, "worker.mjs"),
  compatibilityDate: "2026-07-30",
  durableObjects: { STATE: { className: "State", useSQLite: true } },
  durableObjectsPersist: persistentPath,
  port: 0
});
const trace = [];
async function call(action, params = {}) {
  const response = await mf.dispatchFetch("http://local.test/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...params }) });
  const body = await response.json();
  trace.push({ action, params, status: response.status, body });
  return body;
}
function check(ok, label) { if (!ok) throw new Error(label); }
try {
  const reservation = { inputId: "restart-u1", owner: "alice", operationId: "restart-pay1", contentHash: "fixed-terms" };
  const reward = { requestId: "restart-r1", owner: "alice", contentHash: "amount-recipient", operationId: "restart-transfer1" };
  const tx = { requestId: "restart-r1", rawTx: "0x010203", txHash: "0xrestarttx1" };
  if (phase === "init") {
    check((await call("reserve", reservation)).ok, "initial reservation");
    check((await call("reward", reward)).ok, "initial request");
    check((await call("prepare", tx)).ok, "persist raw transaction before broadcast");
    check((await call("broadcastUnknown", { requestId: reward.requestId })).value.phase === "uncertain", "persist uncertain state");
  } else if (phase === "verify") {
    const snapshot = (await call("snapshot")).value;
    check(snapshot.reservations.length === 1 && snapshot.reservations[0].operation_id === reservation.operationId, "reservation survived process restart");
    check(snapshot.rewards.length === 1 && snapshot.rewards[0].operation_id === reward.operationId && snapshot.rewards[0].raw_tx === tx.rawTx && snapshot.rewards[0].phase === "uncertain", "reward and raw transaction survived process restart");
    check((await call("reserve", reservation)).value.operation_id === reservation.operationId, "same reservation retry");
    check(!(await call("reserve", { ...reservation, operationId: "different-pay", contentHash: "changed" })).ok, "conflicting reservation rejected");
    check((await call("reward", reward)).value.operation_id === reward.operationId, "same reward retry");
    check(!(await call("reward", { requestId: "new-request", owner: "alice", contentHash: "new-terms", operationId: "new-transfer" })).ok, "new reward blocked while old broadcast uncertain");
    check((await call("prepare", tx)).value.raw_tx === tx.rawTx, "same raw transaction reused");
  } else throw new Error("phase must be init or verify");
  console.log(JSON.stringify({ phase, pid: process.pid, passed: true, trace }));
} finally {
  await mf.dispose();
}
