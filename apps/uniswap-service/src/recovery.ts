export interface RecoveryGate {
  readonly generation: string;
  readonly stopped: boolean;
  readonly initialize?: boolean;
}

export function resolveRecoveryGate(source: string, deploymentId: string): RecoveryGate {
  try {
    const catalog = JSON.parse(source) as Record<string, RecoveryGate>;
    const gate = Object.hasOwn(catalog, deploymentId) ? catalog[deploymentId] : undefined;
    if (gate === undefined || typeof gate.generation !== 'string' || gate.generation.length === 0
      || typeof gate.stopped !== 'boolean' || (gate.initialize !== undefined && typeof gate.initialize !== 'boolean')) {
      throw new Error('INVALID_RECOVERY_GATE');
    }
    return gate;
  } catch {
    throw new Error('INVALID_RECOVERY_GATE');
  }
}

type State = { status: string; generation: string };

function readState(storage: DurableObjectStorage): State | undefined {
  return storage.sql.exec<State>('SELECT status, generation FROM environment_state WHERE id = 1').toArray()[0];
}

export function getAvailability(storage: DurableObjectStorage, gate: RecoveryGate): 'healthy' | 'rollback' {
  if (gate.stopped || gate.generation.length === 0) return 'rollback';
  const state = readState(storage);
  if (state === undefined) return 'rollback';
  return state.status === 'healthy' && state.generation === gate.generation ? 'healthy' : 'rollback';
}

// Operator-only bootstrap. Never call this from fetch/alarm; #60 must guard invocation externally.
export function initializeEnvironment(storage: DurableObjectStorage, gate: RecoveryGate): void {
  if (gate.stopped || gate.initialize !== true || gate.generation.length === 0 || readState(storage) !== undefined) {
    throw new Error('INITIALIZATION_NOT_ALLOWED');
  }
  storage.sql.exec("INSERT INTO environment_state (id, status, generation) VALUES (1, 'healthy', ?)", gate.generation);
}

export function ensureWritable(storage: DurableObjectStorage, gate: RecoveryGate): void {
  if (getAvailability(storage, gate) !== 'healthy') throw new Error('SERVICE_UNAVAILABLE');
}

export function beginRestore(storage: DurableObjectStorage, gate: RecoveryGate): void {
  if (!gate.stopped || gate.generation.length === 0) throw new Error('EXTERNAL_STOP_REQUIRED');
  storage.sql.exec(
    "INSERT INTO environment_state (id, status, generation, reason) VALUES (1, 'stopped', ?, 'restore') ON CONFLICT(id) DO UPDATE SET status = 'stopped', reason = 'restore'",
    gate.generation,
  );
}

export function completeRestore(
  storage: DurableObjectStorage, gate: RecoveryGate,
  evidence: { readonly acknowledgedRecordsComplete: boolean; readonly chainReconciled: boolean },
): void {
  if (!gate.stopped) throw new Error('EXTERNAL_STOP_REQUIRED');
  if (!evidence.acknowledgedRecordsComplete || !evidence.chainReconciled) throw new Error('RESTORE_EVIDENCE_INCOMPLETE');
  storage.sql.exec("UPDATE environment_state SET status = 'healthy', generation = ?, reason = NULL WHERE id = 1",
    gate.generation);
}
