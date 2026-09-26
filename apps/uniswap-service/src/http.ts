import type { ErrorCode } from '@confidential-utxo/uniswap';

export const MAX_BODY_BYTES = 1_048_576;
export const MAX_BUNDLE_BYTES = 524_288;

export class BodyTooLarge extends Error {
  constructor() { super('PAYLOAD_TOO_LARGE'); }
}

export function apiError(status: number, code: ErrorCode): Response {
  return Response.json({ error: { code, message: code, allowedActions: [] } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function apiSuccess(body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

export async function readLimitedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function assertBundleSize(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const record = (body as { record?: { encryptedBundle?: { ciphertext?: unknown } } }).record;
  const ciphertext = record?.encryptedBundle?.ciphertext;
  if (typeof ciphertext === 'string' && ciphertext.length > 4 * Math.ceil(MAX_BUNDLE_BYTES / 3)) {
    throw new BodyTooLarge();
  }
}
