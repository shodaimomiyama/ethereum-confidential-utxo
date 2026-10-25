import { createSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import { parseApiResponse } from "@confidential-utxo/uniswap";
import type { ApiRoute, ApiSuccessResponseMap, ApiTransport, Bytes32, ReservationPort,
  RewardRecord, RewardRequest, Scope, SavedReservation } from "@confidential-utxo/uniswap";
import type { OperationRecord } from "@confidential-utxo/uniswap";
import type { OperationResponse } from "@confidential-utxo/uniswap";

export class ServiceClientError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ServiceClientError"; }
}

type Signer = { address: Address; signMessage(args: { message: string }): Promise<Hex> };
export type ServiceClientOptions = { baseUrl: string; origin: string; siweUri: string;
  chainId: number; scope: Scope; signer: Signer; fetch?: ApiTransport };
export type ServiceClient = { authenticate(): Promise<void>; createReward(request: RewardRequest): Promise<RewardRecord>;
  listRewards(): Promise<readonly RewardRecord[]>; getReward(id: Bytes32): Promise<RewardRecord>;
  markReceived(id: Bytes32, outputId: Bytes32, blockHash: Bytes32): Promise<RewardRecord>;
  reservations: ReservationPort };

function cleanUrl(value: string): URL {
  const url = new URL(value);
  if (!url.username && !url.password && ![...url.searchParams.keys()].some(key =>
    /key|secret|token|auth|password|credential/i.test(key))) return url;
  throw new ServiceClientError("INVALID_SERVICE_URL");
}
function wireRecord(record: OperationRecord): Record<string, unknown> {
  const { scope: _scope, ...rest } = record;
  return { ...rest, ...(rest.kind === "pay" ? { deadline: rest.deadline.toString() } : {}) };
}

function confirmedReservation(response: OperationResponse, scope: Scope, recordId?: Bytes32): SavedReservation {
  const sameScope = (observed: Scope) => observed.deploymentId === scope.deploymentId
    && observed.owner.toLowerCase() === scope.owner.toLowerCase();
  const active = response.status === "reserved" && response.reservationState === "active";
  const released = (response.status === "released" || response.status === "consumed"
    || response.status === "finalized-success")
    && response.reservationState === "released" && response.checkpoint !== undefined;
  if (!sameScope(response.scope) || !sameScope(response.record.scope)
    || (recordId !== undefined && response.record.recordId.toLowerCase() !== recordId.toLowerCase())
    || (!active && !released)) {
    throw new ServiceClientError("SERVICE_PROTOCOL_ERROR");
  }
  return response as SavedReservation;
}

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  const base = cleanUrl(options.baseUrl);
  const origin = cleanUrl(options.origin);
  const siweUri = cleanUrl(options.siweUri);
  if (origin.origin !== options.origin || siweUri.origin !== origin.origin ||
    !Number.isSafeInteger(options.chainId) || options.chainId <= 0 ||
    options.scope.owner.toLowerCase() !== options.signer.address.toLowerCase()) {
    throw new ServiceClientError("SERVICE_SCOPE_INVALID");
  }
  const transport = options.fetch ?? fetch;
  let cookie: string | undefined;
  const scopeQuery = () => new URLSearchParams({ deploymentId: options.scope.deploymentId,
    owner: options.scope.owner }).toString();
  async function request<Route extends ApiRoute>(route: Route, method: string, path: string,
    body?: unknown): Promise<ApiSuccessResponseMap[Route]> {
    const url = new URL(path, base);
    const headers = new Headers();
    if (body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", options.origin); }
    if (cookie) headers.set("cookie", cookie);
    let response: Response;
    try {
      response = await transport(new Request(url, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    } catch { throw new ServiceClientError("SERVICE_UNAVAILABLE"); }
    let parsed: ReturnType<typeof parseApiResponse<Route>>;
    try {
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw new Error("response too large");
      parsed = parseApiResponse(route, response.status, JSON.parse(raw));
    } catch { throw new ServiceClientError("SERVICE_PROTOCOL_ERROR"); }
    if ("error" in parsed) throw new ServiceClientError(parsed.error.code);
    if (route === "POST /v1/auth/verify") {
      const setCookie = response.headers.get("set-cookie") ?? "";
      const match = /^ecu_session=(0x[0-9a-fA-F]{64})(?:;|$)/.exec(setCookie);
      if (!match) throw new ServiceClientError("SERVICE_PROTOCOL_ERROR");
      cookie = `ecu_session=${match[1]}`;
    }
    return parsed as ApiSuccessResponseMap[Route];
  }
  async function authenticate(): Promise<void> {
    const challenge = await request("POST /v1/auth/challenge", "POST", "/v1/auth/challenge",
      { scope: options.scope });
    const now = Date.now();
    if (challenge.issuedAt > now + 30_000 || challenge.expiresAt <= now ||
      challenge.expiresAt <= challenge.issuedAt) throw new ServiceClientError("CHALLENGE_EXPIRED");
    const siweMessage = createSiweMessage({ address: options.signer.address,
      domain: origin.host, uri: options.siweUri, version: "1", chainId: options.chainId,
      nonce: challenge.nonce, issuedAt: new Date(challenge.issuedAt),
      expirationTime: new Date(challenge.expiresAt) });
    let signature: Hex;
    try { signature = await options.signer.signMessage({ message: siweMessage }); }
    catch { throw new ServiceClientError("SIGNATURE_REJECTED"); }
    await request("POST /v1/auth/verify", "POST", "/v1/auth/verify",
      { scope: options.scope, challengeId: challenge.challengeId, siweMessage, signature });
  }
  const reservations: ReservationPort = {
    async reserve(record, expectedRevision, sealedRevision) {
      const response = await request("PUT /v1/operations/{id}", "PUT",
        `/v1/operations/${record.recordId}`, { scope: options.scope,
          expectedRevision, sealedRevision, record: wireRecord(record) });
      if (response.reservationState !== "active") throw new ServiceClientError("SERVICE_PROTOCOL_ERROR");
      return response as SavedReservation;
    },
    async update(record, expectedRevision, sealedRevision) {
      const response = await request("PUT /v1/operations/{id}", "PUT",
        `/v1/operations/${record.recordId}`, { scope: options.scope,
          expectedRevision, sealedRevision, record: wireRecord(record) });
      if (response.reservationState !== "active") throw new ServiceClientError("SERVICE_PROTOCOL_ERROR");
      return response as SavedReservation;
    },
    async get(scope, recordId) {
      if (scope.deploymentId !== options.scope.deploymentId ||
        scope.owner.toLowerCase() !== options.scope.owner.toLowerCase()) {
        throw new ServiceClientError("SERVICE_SCOPE_INVALID");
      }
      try { return confirmedReservation(await request("GET /v1/operations/{id}", "GET",
        `/v1/operations/${recordId}?${scopeQuery()}`), scope, recordId); }
      catch (error) { if (error instanceof ServiceClientError && error.code === "NOT_FOUND") return undefined; throw error; }
    },
    async list(scope) {
      if (scope.deploymentId !== options.scope.deploymentId ||
        scope.owner.toLowerCase() !== options.scope.owner.toLowerCase()) {
        throw new ServiceClientError("SERVICE_SCOPE_INVALID");
      }
      const records: SavedReservation[] = [];
      let cursor: Bytes32 | undefined;
      let availability: "healthy" | "rollback" = "healthy";
      do {
        const result = await request("GET /v1/operations", "GET",
          `/v1/operations?${scopeQuery()}${cursor ? `&cursor=${cursor}` : ""}`);
        availability = result.availability;
        for (const item of result.records) records.push(confirmedReservation(item, scope));
        cursor = result.nextCursor;
      } while (cursor && availability === "healthy");
      return { availability, records };
    },
    async release(record, evidence, expectedRevision, sealedRevision) {
      return request("POST /v1/operations/{id}/release", "POST",
        `/v1/operations/${record.recordId}/release`, { scope: options.scope,
          expectedRevision, sealedRevision, blockHash: evidence.blockHash, record: wireRecord(record) });
    },
  };
  return { authenticate,
    async createReward(reward) {
      if (reward.scope.deploymentId !== options.scope.deploymentId ||
        reward.scope.owner.toLowerCase() !== options.scope.owner.toLowerCase()) {
        throw new ServiceClientError("SERVICE_SCOPE_INVALID");
      }
      const result = await request("POST /v1/rewards", "POST", "/v1/rewards", {
        ...reward, amountWei: reward.amountWei.toString() });
      return result.reward;
    },
    async listRewards() {
      return (await request("GET /v1/rewards", "GET", `/v1/rewards?${scopeQuery()}`)).rewards;
    },
    async getReward(id) {
      return (await request("GET /v1/rewards/{id}", "GET", `/v1/rewards/${id}?${scopeQuery()}`)).reward;
    },
    async markReceived(id, outputId, blockHash) {
      return (await request("POST /v1/rewards/{id}/received", "POST",
        `/v1/rewards/${id}/received`, { scope: options.scope, outputId, blockHash })).reward;
    },
    reservations,
  };
}
