import type { ParsedApiRequest, Scope } from '@confidential-utxo/uniswap';
import type { Migration } from './schema.js';
import type { RecoveryGate } from './recovery.js';
import { ensureWritable } from './recovery.js';
import type { DeploymentConfig } from './config.js';
import type { ServiceEnv } from './index.js';
import type { HistoryPort } from '@confidential-utxo/core';

export interface ServiceContext {
  readonly scope?: Scope;
  readonly deploymentId?: string;
  readonly deployment?: DeploymentConfig;
  readonly env?: ServiceEnv;
  readonly readRewardFunds?: (deploymentId: string) => Promise<bigint | undefined>;
  readonly readRewardHistory?: (deploymentId: string) => Promise<HistoryPort>;
  readonly storage: DurableObjectStorage;
  transactionSync<T>(callback: () => T): T;
  ensureWritable(): void;
  scheduleAlarm(atMs: number): Promise<void>;
}

export interface ServiceExtension {
  readonly migrations: readonly Migration[];
  readonly routes: readonly {
    readonly route: ParsedApiRequest['route'];
    handle(request: ParsedApiRequest, context: ServiceContext): Promise<Response> | Response;
  }[];
  alarm?(context: ServiceContext): Promise<void>;
}

const extensions: ServiceExtension[] = [];

export function registerServiceExtension(extension: ServiceExtension): void {
  const installed = new Set([1, ...extensions.flatMap((entry) => entry.migrations.map(({ version }) => version))]);
  if (extension.migrations.some(({ version }) => installed.has(version))
    || new Set(extension.migrations.map(({ version }) => version)).size !== extension.migrations.length) {
    throw new Error('DUPLICATE_MIGRATION_VERSION');
  }
  extensions.push(extension);
}

export function getServiceExtensions(): readonly ServiceExtension[] { return extensions; }

export function makeServiceContext(
  storage: DurableObjectStorage, gate: RecoveryGate, scope?: Scope,
  trusted?: { deploymentId: string; deployment: DeploymentConfig; env: ServiceEnv },
): ServiceContext {
  return {
    ...(scope === undefined ? {} : { scope }), storage,
    ...(trusted === undefined ? {} : trusted),
    transactionSync: (callback) => storage.transactionSync(callback),
    ensureWritable: () => ensureWritable(storage, gate),
    scheduleAlarm: async (atMs) => {
      const current = await storage.getAlarm();
      if (current === null || atMs < current) await storage.setAlarm(atMs);
    },
  };
}
