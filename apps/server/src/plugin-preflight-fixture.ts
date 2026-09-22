import { createServer } from "node:http";

export type CompatibilityScenario =
  | "valid"
  | "input-schema"
  | "output-schema"
  | "required-task"
  | "auth"
  | "forbidden"
  | "transport"
  | "reset-content"
  | "protocol"
  | "timeout"
  | "pagination";

/** Synthetic protocol peer for negative author/Server checks; never used by production. */
export async function startCompatibilityFixture(scenario: CompatibilityScenario) {
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (scenario === "timeout") return;
    if (scenario === "auth" && request.headers.authorization !== "Bearer fixture-token") {
      response
        .writeHead(401, {
          "WWW-Authenticate": 'Bearer resource_metadata="https://untrusted.invalid/secret"',
        })
        .end("private-response-must-not-leak");
      return;
    }
    if (scenario === "reset-content") {
      response.writeHead(205, { "content-type": "application/json" }).end();
      return;
    }
    if (scenario === "forbidden") {
      response.writeHead(403).end("private-response-must-not-leak");
      return;
    }
    if (scenario === "transport") {
      response.writeHead(200, { "content-type": "text/html" }).end("login form");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(body.method);
    if (body.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    const schema = {
      type: "object",
      ...(scenario === "input-schema"
        ? { properties: { value: { type: "string", format: "email" } } }
        : {}),
    };
    const tool = {
      name: "echo",
      description: "Test fixture only.",
      inputSchema: schema,
      ...(scenario === "output-schema"
        ? {
            outputSchema: {
              type: "object",
              $schema: "https://json-schema.org/draft/2020-12/schema",
            },
          }
        : {}),
      ...(scenario === "required-task" ? { execution: { taskSupport: "required" } } : {}),
    };
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: scenario === "protocol" ? "unsupported-private-version" : "2025-11-25",
            serverInfo: { name: "compatibility-fixture", version: "1.0.0" },
            capabilities: { tools: {} },
          }
        : body.method === "tools/list"
          ? { tools: [tool], ...(scenario === "pagination" ? { nextCursor: "more" } : {}) }
          : { content: [{ type: "text", text: "fixture" }] };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    methods,
    setScenario(next: CompatibilityScenario) {
      scenario = next;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
