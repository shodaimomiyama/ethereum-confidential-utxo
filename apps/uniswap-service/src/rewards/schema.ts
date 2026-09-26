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
      WHERE status NOT IN ('received', 'ended-without-distribution')`,
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
}];
