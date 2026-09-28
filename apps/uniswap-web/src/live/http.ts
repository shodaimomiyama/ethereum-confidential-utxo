import {
  parseApiRequest, parseApiResponse,
  type ApiRequestBodyMap, type ApiRoute, type ApiSuccessResponseMap,
  type ApiTransport, type Bytes32, type ErrorCode, type Scope,
} from '@confidential-utxo/uniswap';

export type HttpFailureKind = 'network' | 'abort' | 'schema' | 'api' | 'scope';

/** Carries only stable codes; server text, request bodies and provider errors stay private. */
export class HttpFailure extends Error {
  constructor(readonly kind: HttpFailureKind, readonly code?: ErrorCode) {
    super(code ?? kind);
    this.name = 'HttpFailure';
  }
}

export interface HttpClient {
  call<Route extends ApiRoute>(route: Route, input: {
    scope: Scope; id?: Bytes32; body?: ApiRequestBodyMap[Route]; signal?: AbortSignal;
    cursor?: Route extends 'GET /v1/operations' ? Bytes32 : never;
  }): Promise<ApiSuccessResponseMap[Route]>;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.deploymentId === b.deploymentId && a.owner.toLowerCase() === b.owner.toLowerCase();
}

export function createHttpClient({ origin, transport = request => fetch(request) }: {
  origin: string; transport?: ApiTransport;
}): HttpClient {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new HttpFailure('schema');
  return {
    async call(route, input) {
      const scope = { ...input.scope };
      const id = input.id;
      const cursor = input.cursor;
      let request: Request;
      let parsedRequest: ReturnType<typeof parseApiRequest>;
      try {
        const [method, template] = route.split(' ');
        if (cursor !== undefined && route !== 'GET /v1/operations') throw new HttpFailure('schema');
        if (!template || (template.includes('{id}') && (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)))
          || (!template.includes('{id}') && id !== undefined)) throw new HttpFailure('schema');
        const url = new URL(template.replace('{id}', id ?? ''), base.origin);
        if (url.origin !== base.origin) throw new HttpFailure('schema');
        if (method === 'GET') {
          if (input.body !== undefined) throw new HttpFailure('schema');
          url.searchParams.set('deploymentId', scope.deploymentId);
          url.searchParams.set('owner', scope.owner);
          if (cursor !== undefined) url.searchParams.set('cursor', cursor);
        }
        const serialized = input.body === undefined ? undefined : JSON.stringify(input.body);
        parsedRequest = parseApiRequest(method!, url.href, serialized === undefined ? undefined : JSON.parse(serialized));
        if (parsedRequest.route !== route || !sameScope(parsedRequest.scope, scope)
          || parsedRequest.id?.toLowerCase() !== id?.toLowerCase()) throw new HttpFailure('scope');
        request = new Request(url, { method, body: serialized, signal: input.signal,
          credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: serialized === undefined ? {} : { 'content-type': 'application/json' } });
      } catch (error) {
        throw error instanceof HttpFailure ? error : new HttpFailure('schema');
      }
      let response: Response;
      try { response = await transport(request); }
      catch (error) {
        throw new HttpFailure(input.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'abort' : 'network');
      }
      let body: unknown;
      try { body = await response.json(); }
      catch (error) {
        throw new HttpFailure(input.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'abort'
          : error instanceof SyntaxError ? 'schema' : 'network');
      }
      let parsed: ReturnType<typeof parseApiResponse<typeof route>>;
      try { parsed = parseApiResponse(route, response.status, body); }
      catch { throw new HttpFailure('schema'); }
      if ('error' in parsed) throw new HttpFailure('api', parsed.error.code);
      const checkScope = (returned: Scope): void => { if (!sameScope(returned, scope)) throw new HttpFailure('scope'); };
      if ('scope' in parsed) {
        checkScope(parsed.scope);
        if (parsed.record.recordId.toLowerCase() !== id?.toLowerCase()) throw new HttpFailure('scope');
      }
      if ('records' in parsed) for (const saved of parsed.records) checkScope(saved.scope);
      if ('rewards' in parsed) for (const reward of parsed.rewards) checkScope(reward.scope);
      if ('reward' in parsed) {
        checkScope(parsed.reward.scope);
        const expectedId = id ?? parsedRequest.reward?.requestId;
        if (parsed.reward.requestId.toLowerCase() !== expectedId?.toLowerCase()) throw new HttpFailure('scope');
      }
      return parsed;
    },
  };
}
