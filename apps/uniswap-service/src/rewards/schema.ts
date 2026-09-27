import type { Migration } from '../schema.js';

export const rewardMigrations: readonly Migration[] = [{
  version: 2,
  statements: [
    `CREATE TABLE reward_requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL,
      amount_wei TEXT NOT NULL, recipient_info_json TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 1,
      operation_id TEXT, checkpoint_hash TEXT, output_id TEXT,
      UNIQUE (deployment_id, request_id)
    )`,
    `CREATE UNIQUE INDEX reward_one_active_owner
      ON reward_requests(deployment_id, owner)
      WHERE status IN ('accepted', 'queued', 'processing', 'pending')`,
    `CREATE TABLE reward_reservations (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, amount_wei TEXT NOT NULL,
      released INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (deployment_id, request_id)
    )`,
    `CREATE TABLE reward_drafts (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, phase TEXT NOT NULL,
      version INTEGER NOT NULL, encrypted_json TEXT,
      PRIMARY KEY (deployment_id, request_id)
    )`,
    `CREATE TABLE reward_inputs (
      deployment_id TEXT NOT NULL, input_id TEXT NOT NULL, request_id TEXT NOT NULL,
      status TEXT NOT NULL, PRIMARY KEY (deployment_id, input_id)
    )`,
    `CREATE TABLE reward_attempts (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
      kind TEXT NOT NULL, operation_id TEXT NOT NULL, nonce INTEGER NOT NULL, tx_hash TEXT NOT NULL,
      encrypted_raw TEXT NOT NULL, outer_status TEXT NOT NULL,
      PRIMARY KEY (deployment_id, request_id, attempt_no)
    )`,
    `CREATE TABLE reward_availability (
      deployment_id TEXT PRIMARY KEY, reason TEXT NOT NULL, checked_at_ms INTEGER NOT NULL
    )`,
  ],
}, {
  version: 3,
  statements: [
    `CREATE TABLE reward_cancellations (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL,
      phase TEXT NOT NULL, operation_id TEXT NOT NULL, input_id TEXT NOT NULL,
      encrypted_draft TEXT NOT NULL, encrypted_raw TEXT,
      tx_hash TEXT, nonce INTEGER, checkpoint_hash TEXT,
      PRIMARY KEY (deployment_id, request_id)
    )`,
  ],
}, {
  version: 4,
  statements: [
    `CREATE TABLE reward_input_history (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, input_id TEXT NOT NULL,
      PRIMARY KEY (deployment_id, request_id, input_id)
    )`,
    `INSERT INTO reward_input_history (deployment_id, request_id, input_id)
      SELECT deployment_id, request_id, input_id FROM reward_inputs`,
    `CREATE TABLE reward_stop_flags (
      deployment_id TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY (deployment_id, reason)
    )`,
    `INSERT INTO reward_stop_flags (deployment_id, reason)
      SELECT deployment_id, reason FROM reward_availability
      WHERE reason IN ('operator-stopped', 'quota-stopped', 'restore-stopped')`,
    `CREATE TABLE reward_transient_stop (
      deployment_id TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY (deployment_id, reason)
    )`,
    `INSERT INTO reward_transient_stop (deployment_id, reason)
      SELECT deployment_id, reason FROM reward_availability
      WHERE reason IN ('rpc-unavailable', 'funds-short', 'gas-short')`,
  ],
}, {
  version: 5,
  statements: [
    `CREATE TABLE reward_consolidations (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, round INTEGER NOT NULL,
      phase TEXT NOT NULL, operation_id TEXT, input_ids_json TEXT,
      encrypted_draft TEXT, encrypted_raw TEXT, tx_hash TEXT, nonce INTEGER,
      checkpoint_hash TEXT,
      PRIMARY KEY (deployment_id, request_id, round)
    )`,
  ],
}];
