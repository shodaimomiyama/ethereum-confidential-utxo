export class State {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservations (input_id TEXT PRIMARY KEY, owner TEXT NOT NULL, operation_id TEXT NOT NULL, content_hash TEXT NOT NULL, revision INTEGER NOT NULL, phase TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rewards (request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, content_hash TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, raw_tx TEXT, tx_hash TEXT, phase TEXT NOT NULL)`);
  }
  row(query, ...args) { return this.sql.exec(query, ...args).toArray()[0] ?? null; }
  async fetch(request) {
    const { action, ...p } = await request.json();
    try {
      const value = action === "cryptoProbe" ? await this.cryptoProbe() : this.ctx.storage.transactionSync(() => this.act(action, p));
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json({ ok: false, error: String(error.message) }, { status: 409 });
    }
  }
  async cryptoProbe() {
    const seen = new Set();
    for (let n = 0; n < 1000; n++) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const key = Array.from(nonce).join(",");
      if (seen.has(key)) throw new Error("nonce-reuse");
      seen.add(key);
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("opaque-operation-record");
    const aad = new TextEncoder().encode("environment|owner|record|revision=1");
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
    const decoded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, ciphertext));
    if (new TextDecoder().decode(decoded) !== "opaque-operation-record") throw new Error("decryption-mismatch");
    let changedAadRejected = false;
    try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("environment|owner|record|revision=0"), tagLength: 128 }, key, ciphertext); } catch { changedAadRejected = true; }
    const tampered = ciphertext.slice(); tampered[0] ^= 1;
    let changedCiphertextRejected = false;
    try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, tampered); } catch { changedCiphertextRejected = true; }
    if (!changedAadRejected || !changedCiphertextRejected) throw new Error("tamper-accepted");
    return { nonceSamples: seen.size, aadChangeRejected: changedAadRejected, ciphertextChangeRejected: changedCiphertextRejected, algorithm: "AES-256-GCM" };
  }
  act(action, p) {
    if (action === "reserve") {
      const old = this.row("SELECT * FROM reservations WHERE input_id=?", p.inputId);
      if (old) {
        if (old.owner !== p.owner || old.operation_id !== p.operationId || old.content_hash !== p.contentHash) throw new Error("input-conflict");
        return old;
      }
      this.sql.exec("INSERT INTO reservations VALUES (?,?,?,?,?,?)", p.inputId, p.owner, p.operationId, p.contentHash, 0, "reserved");
      return this.row("SELECT * FROM reservations WHERE input_id=?", p.inputId);
    }
    if (action === "revise") {
      const before = this.row("SELECT * FROM reservations WHERE input_id=?", p.inputId);
      if (!before || before.owner !== p.owner || before.revision !== p.expectedRevision) throw new Error("stale-revision");
      this.sql.exec("UPDATE reservations SET revision=revision+1,phase=? WHERE input_id=? AND owner=? AND revision=?", p.phase, p.inputId, p.owner, p.expectedRevision);
      const row = this.row("SELECT * FROM reservations WHERE input_id=?", p.inputId);
      if (!row || row.revision !== p.expectedRevision + 1) throw new Error("revision-failed");
      return row;
    }
    if (action === "reward") {
      const old = this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
      if (old) {
        if (old.owner !== p.owner || old.content_hash !== p.contentHash) throw new Error("request-conflict");
        return old;
      }
      if (this.row("SELECT request_id FROM rewards WHERE owner=? AND phase NOT IN ('received','cancelled')", p.owner)) throw new Error("owner-active-request");
      this.sql.exec("INSERT INTO rewards VALUES (?,?,?,?,?,?,?)", p.requestId, p.owner, p.contentHash, p.operationId, null, null, "accepted");
      return this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
    }
    if (action === "prepare") {
      const row = this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
      if (!row) throw new Error("unknown-request");
      if (row.raw_tx && (row.raw_tx !== p.rawTx || row.tx_hash !== p.txHash)) throw new Error("different-transaction");
      if (!row.raw_tx) this.sql.exec("UPDATE rewards SET raw_tx=?,tx_hash=?,phase='prepared' WHERE request_id=? AND phase='accepted'", p.rawTx, p.txHash, p.requestId);
      return this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
    }
    if (action === "broadcastUnknown") {
      const row = this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
      if (!row?.raw_tx) throw new Error("transaction-not-persisted");
      this.sql.exec("UPDATE rewards SET phase='uncertain' WHERE request_id=? AND phase='prepared'", p.requestId);
      return this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
    }
    if (action === "finalize") {
      const row = this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
      if (!row?.raw_tx || row.tx_hash !== p.txHash) throw new Error("unrecognized-transaction");
      this.sql.exec("UPDATE rewards SET phase='finalized' WHERE request_id=?", p.requestId);
      return this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
    }
    if (action === "reorg") {
      this.sql.exec("UPDATE rewards SET phase='uncertain' WHERE request_id=? AND phase='finalized'", p.requestId);
      return this.row("SELECT * FROM rewards WHERE request_id=?", p.requestId);
    }
    if (action === "snapshot") return {
      reservations: this.sql.exec("SELECT * FROM reservations ORDER BY input_id").toArray(),
      rewards: this.sql.exec("SELECT * FROM rewards ORDER BY request_id").toArray()
    };
    throw new Error("unknown-action");
  }
}

export default {
  fetch(request, env) {
    const id = env.STATE.idFromName("environment-sepolia-test");
    return env.STATE.get(id).fetch(request);
  }
};
