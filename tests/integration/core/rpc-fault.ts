import { createServer } from "node:http";

export type RpcFault = { method: string; nth: number; action: "drop" | "duplicate" | "error" };

export async function startRpcFaultProxy(upstreamUrl: string): Promise<{
  rpcUrl: string;
  injectRpcFault(fault: RpcFault): void;
  clear(): void;
  close(): Promise<void>;
}> {
  let fault: RpcFault | undefined;
  let seen = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const parsed = JSON.parse(body.toString("utf8")) as { id?: unknown; method?: string };
      const upstream = await fetch(upstreamUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      const received = JSON.parse(await upstream.text()) as Record<string, unknown>;
      let output = received;
      if (fault && !Array.isArray(parsed) && parsed.method === fault.method && ++seen >= fault.nth) {
        if (fault.action === "error") output = { jsonrpc: "2.0", id: parsed.id,
          error: { code: -32000, message: "injected RPC failure" } };
        if (fault.action === "drop" && Array.isArray(received.result)) output = { ...received,
          result: received.result.slice(1) };
        if (fault.action === "duplicate" && Array.isArray(received.result) && received.result.length > 0)
          output = { ...received, result: [received.result[0], ...received.result] };
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    } catch {
      response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: null, error: { code: -32001, message: "RPC proxy failure" },
      }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing RPC proxy port");
  return {
    rpcUrl: `http://127.0.0.1:${address.port}`,
    injectRpcFault(next) {
      if (!next.method || !Number.isSafeInteger(next.nth) || next.nth < 1) throw new Error("invalid RPC fault");
      fault = next;
      seen = 0;
    },
    clear() { fault = undefined; seen = 0; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
