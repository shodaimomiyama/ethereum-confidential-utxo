import type {
  AttemptId, Bytes32, DeploymentId, InputId, OperationId, PaymentId,
  RequestId, Scope, TxHash,
} from './domain.js';
import {
  parseAddress,
  parseBytes32,
  parseJsonObject,
  parseRevision,
  parseString,
  parseTimestamp,
  parseUintString,
  SchemaError,
} from './schema.js';
import type {
  EncryptedBundle,
  OperationRecord,
  ReservationBase,
  RewardRecord,
  RewardRequest,
  RewardStatus,
  SignedRecipientInfo,
} from './storage.js';

export type ApiTransport = (request: Request) => Promise<Response>;

export type ApiRoute =
  | 'POST /v1/auth/challenge'
  | 'POST /v1/auth/verify'
  | 'PUT /v1/operations/{id}'
  | 'GET /v1/operations'
  | 'POST /v1/rewards'
  | 'GET /v1/rewards'
  | 'GET /v1/rewards/{id}'
  | 'POST /v1/rewards/{id}/received';

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_USED'
  | 'SCOPE_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'RESERVATION_CONFLICT'
  | 'REQUEST_CONFLICT'
  | 'PENDING_REQUEST'
  | 'INSUFFICIENT_FUNDS'
  | 'NOT_FOUND'
  | 'SERVICE_UNAVAILABLE';

export interface ApiError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly field?: string;
  readonly allowedActions: readonly string[];
}

export interface ParsedApiRequest {
  readonly route: ApiRoute;
  readonly scope: Scope;
  readonly id?: Bytes32;
  readonly challengeId?: Bytes32;
  readonly siweMessage?: string;
  readonly signature?: `0x${string}`;
  readonly expectedRevision?: number;
  readonly record?: OperationRecord;
  readonly reward?: RewardRequest;
  readonly outputId?: Bytes32;
  readonly blockHash?: Bytes32;
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const REWARD_STATUSES: readonly RewardStatus[] = [
  'accepted', 'queued', 'processing', 'pending', 'unknown',
  'finalized', 'received', 'ended-without-distribution',
];

function parseScope(value: unknown): Scope {
  const object = parseJsonObject(value, 'scope');
  return {
    deploymentId: parseString(object.deploymentId, 'scope.deploymentId') as DeploymentId,
    owner: parseAddress(object.owner, 'scope.owner'),
  };
}

function parseQueryScope(url: URL): Scope {
  return parseScope({
    deploymentId: url.searchParams.get('deploymentId'),
    owner: url.searchParams.get('owner'),
  });
}

function parseSignature(value: unknown, field: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new SchemaError('INVALID_FIELD', field);
  }
  return value as `0x${string}`;
}

function parseId<T extends `0x${string}`>(value: unknown, field: string): T {
  return parseBytes32(value, field) as unknown as T;
}

function parseEncryptedBundle(value: unknown): EncryptedBundle {
  const object = parseJsonObject(value, 'record.encryptedBundle');
  const ciphertext = parseString(object.ciphertext, 'record.encryptedBundle.ciphertext');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) {
    throw new SchemaError('INVALID_FIELD', 'record.encryptedBundle.ciphertext');
  }
  const nonce = parseString(object.nonce, 'record.encryptedBundle.nonce');
  const tag = parseString(object.tag, 'record.encryptedBundle.tag');
  if (!/^0x[0-9a-fA-F]{24}$/.test(nonce) || !/^0x[0-9a-fA-F]{32}$/.test(tag)) {
    throw new SchemaError('INVALID_FIELD', 'record.encryptedBundle');
  }
  return { ciphertext, nonce, tag };
}

export function parseOperationRecord(value: unknown, scope: Scope): OperationRecord {
  const object = parseJsonObject(value, 'record');
  if (typeof object.signatureStarted !== 'boolean') {
    throw new SchemaError('INVALID_FIELD', 'record.signatureStarted');
  }
  if (!Array.isArray(object.attemptIds) || !object.attemptIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new SchemaError('INVALID_FIELD', 'record.attemptIds');
  }
  const base: ReservationBase = {
    recordId: parseBytes32(object.recordId, 'record.recordId'),
    scope,
    inputId: parseId<InputId>(object.inputId, 'record.inputId'),
    operationId: parseId<OperationId>(object.operationId, 'record.operationId'),
    contentHash: parseBytes32(object.contentHash, 'record.contentHash'),
    encryptedBundle: parseEncryptedBundle(object.encryptedBundle),
    signatureStarted: object.signatureStarted,
    attemptIds: (object.attemptIds as string[]).map((id) => id as AttemptId),
  };
  if (object.kind === 'pay') {
    const deadline = parseUintString(object.deadline, 'record.deadline', UINT64_MAX);
    if (deadline === 0n) throw new SchemaError('INVALID_FIELD', 'record.deadline');
    return {
      ...base,
      kind: 'pay',
      paymentId: parseId<PaymentId>(object.paymentId, 'record.paymentId'),
      deadline,
    };
  }
  if (object.kind === 'withdraw' && object.paymentId === undefined && object.deadline === undefined) {
    return { ...base, kind: 'withdraw' };
  }
  throw new SchemaError('INVALID_FIELD', 'record.kind');
}

export function parseRecipientInfo(value: unknown): SignedRecipientInfo {
  const object = parseJsonObject(value, 'recipientInfo');
  return {
    owner: parseAddress(object.owner, 'recipientInfo.owner'),
    publicKey: parseBytes32(object.publicKey, 'recipientInfo.publicKey'),
    signature: parseSignature(object.signature, 'recipientInfo.signature'),
  };
}

export function parseRewardRequest(value: unknown): RewardRequest {
  const object = parseJsonObject(value);
  const scope = parseScope(object.scope);
  const amountWei = parseUintString(object.amountWei, 'amountWei', UINT256_MAX);
  if (amountWei === 0n) throw new SchemaError('INVALID_DECIMAL', 'amountWei');
  const recipientInfo = parseRecipientInfo(object.recipientInfo);
  if (recipientInfo.owner.toLowerCase() !== scope.owner.toLowerCase()) {
    throw new SchemaError('INVALID_FIELD', 'recipientInfo.owner');
  }
  return {
    scope,
    requestId: parseId<RequestId>(object.requestId, 'requestId'),
    amountWei,
    recipientInfo,
  };
}

export function parseApiRequest(method: string, path: string, body: unknown): ParsedApiRequest {
  const url = new URL(path, 'https://mock.invalid');
  const pathname = url.pathname;
  if (method === 'POST' && pathname === '/v1/auth/challenge') {
    const object = parseJsonObject(body);
    return { route: 'POST /v1/auth/challenge', scope: parseScope(object.scope) };
  }
  if (method === 'POST' && pathname === '/v1/auth/verify') {
    const object = parseJsonObject(body);
    return {
      route: 'POST /v1/auth/verify', scope: parseScope(object.scope),
      challengeId: parseBytes32(object.challengeId, 'challengeId'),
      siweMessage: parseString(object.siweMessage, 'siweMessage'),
      signature: parseSignature(object.signature, 'signature'),
    };
  }
  const operationMatch = /^\/v1\/operations\/(0x[0-9a-fA-F]{64})$/.exec(pathname);
  if (method === 'PUT' && operationMatch) {
    const object = parseJsonObject(body);
    const scope = parseScope(object.scope);
    const id = parseBytes32(operationMatch[1], 'id');
    const record = parseOperationRecord(object.record, scope);
    if (record.recordId.toLowerCase() !== id.toLowerCase()) {
      throw new SchemaError('INVALID_FIELD', 'record.recordId');
    }
    return {
      route: 'PUT /v1/operations/{id}', scope, id,
      expectedRevision: parseRevision(object.expectedRevision, 'expectedRevision'),
      record,
    };
  }
  if (method === 'GET' && pathname === '/v1/operations') {
    return { route: 'GET /v1/operations', scope: parseQueryScope(url) };
  }
  if (method === 'POST' && pathname === '/v1/rewards') {
    const reward = parseRewardRequest(body);
    return { route: 'POST /v1/rewards', scope: reward.scope, reward };
  }
  if (method === 'GET' && pathname === '/v1/rewards') {
    return { route: 'GET /v1/rewards', scope: parseQueryScope(url) };
  }
  const receivedMatch = /^\/v1\/rewards\/(0x[0-9a-fA-F]{64})\/received$/.exec(pathname);
  if (method === 'POST' && receivedMatch) {
    const object = parseJsonObject(body);
    return {
      route: 'POST /v1/rewards/{id}/received',
      scope: parseScope(object.scope),
      id: parseBytes32(receivedMatch[1], 'id'),
      outputId: parseBytes32(object.outputId, 'outputId'),
      blockHash: parseBytes32(object.blockHash, 'blockHash'),
    };
  }
  const rewardMatch = /^\/v1\/rewards\/(0x[0-9a-fA-F]{64})$/.exec(pathname);
  if (method === 'GET' && rewardMatch) {
    return {
      route: 'GET /v1/rewards/{id}',
      scope: parseQueryScope(url),
      id: parseBytes32(rewardMatch[1], 'id'),
    };
  }
  throw new SchemaError('INVALID_FIELD', 'route');
}

const ERROR_CODES: readonly ErrorCode[] = [
  'INVALID_REQUEST', 'UNAUTHENTICATED', 'CHALLENGE_EXPIRED', 'CHALLENGE_USED',
  'SCOPE_MISMATCH', 'REVISION_CONFLICT', 'RESERVATION_CONFLICT',
  'REQUEST_CONFLICT', 'PENDING_REQUEST', 'INSUFFICIENT_FUNDS',
  'NOT_FOUND', 'SERVICE_UNAVAILABLE',
];

const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  CHALLENGE_EXPIRED: 401,
  CHALLENGE_USED: 401,
  SCOPE_MISMATCH: 403,
  REVISION_CONFLICT: 409,
  RESERVATION_CONFLICT: 409,
  REQUEST_CONFLICT: 409,
  PENDING_REQUEST: 409,
  INSUFFICIENT_FUNDS: 422,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
};

function parseError(value: unknown): ApiError {
  const object = parseJsonObject(value, 'error');
  const code = parseString(object.code, 'error.code');
  if (!ERROR_CODES.includes(code as ErrorCode)) throw new SchemaError('INVALID_FIELD', 'error.code');
  const message = parseString(object.message, 'error.message');
  if (message.length > 160 || /0x[0-9a-fA-F]{64,}/.test(message)) {
    throw new SchemaError('INVALID_FIELD', 'error.message');
  }
  if (!Array.isArray(object.allowedActions) || !object.allowedActions.every((x) => typeof x === 'string')) {
    throw new SchemaError('INVALID_FIELD', 'error.allowedActions');
  }
  const field = object.field === undefined ? undefined : parseString(object.field, 'error.field');
  return { code: code as ErrorCode, message, field, allowedActions: object.allowedActions as string[] };
}

function parseRewardRecord(value: unknown): RewardRecord {
  const object = parseJsonObject(value, 'reward');
  const request = parseRewardRequest(object);
  if (!REWARD_STATUSES.includes(object.status as RewardStatus)) {
    throw new SchemaError('INVALID_FIELD', 'reward.status');
  }
  if (!Array.isArray(object.attemptIds) || !object.attemptIds.every((x) => typeof x === 'string')) {
    throw new SchemaError('INVALID_FIELD', 'reward.attemptIds');
  }
  if (!Array.isArray(object.txHashes)) throw new SchemaError('INVALID_FIELD', 'reward.txHashes');
  return {
    ...request,
    status: object.status as RewardStatus,
    operationId: object.operationId === undefined ? undefined : parseId<OperationId>(object.operationId, 'reward.operationId'),
    attemptIds: (object.attemptIds as string[]).map((x) => x as AttemptId),
    txHashes: object.txHashes.map((x: unknown) => parseId<TxHash>(x, 'reward.txHashes')),
    outputId: object.outputId === undefined ? undefined : parseBytes32(object.outputId, 'reward.outputId'),
    blockHash: object.blockHash === undefined ? undefined : parseBytes32(object.blockHash, 'reward.blockHash'),
  };
}

export function parseApiResponse(route: ApiRoute, status: number, body: unknown): unknown {
  const object = parseJsonObject(body);
  if (status >= 400) {
    const error = parseError(object.error);
    if (ERROR_STATUS[error.code] !== status) {
      throw new SchemaError('INVALID_FIELD', 'status');
    }
    return { error };
  }
  if (status < 200 || status >= 300) throw new SchemaError('INVALID_FIELD', 'status');
  if (route === 'POST /v1/auth/challenge') {
    return {
      challengeId: parseBytes32(object.challengeId, 'challengeId'),
      nonce: parseBytes32(object.nonce, 'nonce'),
      issuedAt: parseTimestamp(object.issuedAt, 'issuedAt'),
      expiresAt: parseTimestamp(object.expiresAt, 'expiresAt'),
    };
  }
  if (route === 'POST /v1/auth/verify') {
    return { sessionExpiresAt: parseTimestamp(object.sessionExpiresAt, 'sessionExpiresAt') };
  }
  if (route === 'PUT /v1/operations/{id}') {
    const scope = parseScope(object.scope);
    return {
      scope,
      record: parseOperationRecord(object.record, scope),
      revision: parseRevision(object.revision, 'revision'),
    };
  }
  if (route === 'GET /v1/operations') {
    if (!Array.isArray(object.records)) throw new SchemaError('INVALID_FIELD', 'records');
    return { records: object.records.map((item: unknown) => {
      const saved = parseJsonObject(item, 'records');
      const scope = parseScope(saved.scope);
      return {
        scope,
        record: parseOperationRecord(saved.record, scope),
        revision: parseRevision(saved.revision, 'revision'),
      };
    }) };
  }
  if (route === 'POST /v1/rewards' || route === 'GET /v1/rewards/{id}' || route === 'POST /v1/rewards/{id}/received') {
    return { reward: parseRewardRecord(object.reward) };
  }
  if (!Array.isArray(object.rewards)) throw new SchemaError('INVALID_FIELD', 'rewards');
  return { rewards: object.rewards.map(parseRewardRecord) };
}
