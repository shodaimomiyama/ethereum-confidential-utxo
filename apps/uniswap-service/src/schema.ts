type Sql = DurableObjectStorage['sql'];

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

const firstMigration: Migration = {
  version: 1,
  statements: [
    `CREATE TABLE challenges (
      challenge_id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, owner TEXT NOT NULL,
      nonce TEXT NOT NULL, issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      used_at_ms INTEGER
    )`,
    `CREATE TABLE sessions (
      session_hash TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, owner TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE operations (
      deployment_id TEXT NOT NULL, owner TEXT NOT NULL, record_id TEXT NOT NULL,
      input_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
      payment_id TEXT, deadline TEXT, content_hash TEXT NOT NULL,
      encrypted_bundle_json TEXT NOT NULL, signature_started INTEGER NOT NULL,
      revision INTEGER NOT NULL, state_version INTEGER NOT NULL, status TEXT NOT NULL,
      checkpoint_block_number TEXT, checkpoint_block_hash TEXT, checkpoint_block_timestamp TEXT,
      PRIMARY KEY (deployment_id, owner, record_id)
    )`,
    `CREATE TABLE active_reservations (
      deployment_id TEXT NOT NULL, owner TEXT NOT NULL, input_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      PRIMARY KEY (deployment_id, owner, input_id),
      UNIQUE (deployment_id, owner, record_id)
    )`,
    `CREATE TABLE operation_attempts (
      deployment_id TEXT NOT NULL, owner TEXT NOT NULL, record_id TEXT NOT NULL,
      position INTEGER NOT NULL, attempt_id TEXT NOT NULL,
      PRIMARY KEY (deployment_id, owner, record_id, position)
    )`,
    `CREATE TABLE environment_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL,
      generation TEXT NOT NULL, reason TEXT
    )`,
  ],
};

export function applyMigrations(storage: DurableObjectStorage, extensions: readonly Migration[] = []): void {
  const migrations = [firstMigration, ...extensions].sort((a, b) => a.version - b.version);
  if (new Set(migrations.map(({ version }) => version)).size !== migrations.length) {
    throw new Error('DUPLICATE_MIGRATION_VERSION');
  }
  storage.transactionSync(() => {
    const sql: Sql = storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS migration_registry (version INTEGER PRIMARY KEY)');
    const installed = new Set(sql.exec<{ version: number }>('SELECT version FROM migration_registry').toArray()
      .map(({ version }) => version));
    if ([...installed].some((version) => !migrations.some((migration) => migration.version === version))) {
      throw new Error('UNSUPPORTED_SCHEMA_VERSION');
    }
    for (const migration of migrations) {
      if (installed.has(migration.version)) continue;
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec('INSERT INTO migration_registry (version) VALUES (?)', migration.version);
    }
  });
}
