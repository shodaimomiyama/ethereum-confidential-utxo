import { expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { createServiceClient } from "../src/service-client.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const scope = { deploymentId: "local-v1" as never, owner: account.address as never };
const requestId = `0x${"22".repeat(32)}` as never;

it("signs the service SIWE challenge and keeps its cookie out of outputs", async () => {
  const requests: Request[] = [];
  const issuedAt = Date.now();
  const transport = async (request: Request): Promise<Response> => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/v1/auth/challenge") return Response.json({
      challengeId: `0x${"11".repeat(32)}`, nonce: `0x${"33".repeat(32)}`,
      issuedAt, expiresAt: issuedAt + 300_000 });
    if (url.pathname === "/v1/auth/verify") {
      const body = await request.json() as { siweMessage: string; signature: `0x${string}` };
      expect(await verifyMessage({ address: account.address, message: body.siweMessage,
        signature: body.signature })).toBe(true);
      expect(body.siweMessage).toContain("site.test");
      return Response.json({ sessionExpiresAt: issuedAt + 1_800_000 }, { headers: {
        "set-cookie": `ecu_session=0x${"44".repeat(32)}; Secure; HttpOnly; SameSite=Strict; Path=/` } });
    }
    expect(request.headers.get("cookie")).toBe(`ecu_session=0x${"44".repeat(32)}`);
    expect(request.headers.get("origin")).toBe("https://site.test");
    const body = await request.json() as Record<string, unknown>;
    const reward = { ...body, status: "accepted", attemptIds: [], txHashes: [] };
    return Response.json({ reward });
  };
  const client = createServiceClient({ baseUrl: "https://site.test", origin: "https://site.test",
    siweUri: "https://site.test/", chainId: 31337, scope, signer: account, fetch: transport });
  await client.authenticate();
  const reward = await client.createReward({ scope, requestId, amountWei: 1n,
    recipientInfo: { owner: account.address as never, publicKey: `0x${"55".repeat(32)}` as never,
      signature: `0x${"66".repeat(65)}` } });
  expect(reward.requestId).toBe(requestId);
  expect(requests).toHaveLength(3);
});
