import { once } from "node:events";
import { createServer } from "node:http";
/** Owned HTTP peer exercises the real MCP SDK and pinned transport; it is never a product fallback. */
export async function workPluginFixture() {
  let calls = 0,
    reads = 0,
    disconnect = false;
  const tool = {
    name: "echo",
    description: "Return synthetic acceptance evidence",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  };
  const resource = {
    uri: "fixture://evidence",
    name: "Evidence",
    description: "Synthetic bounded task evidence",
    mimeType: "text/plain",
  };
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 24576) throw new Error("fixture limit");
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "work-fixture", version: "1" },
          };
          break;
        case "tools/list":
          result = { tools: [tool] };
          break;
        case "resources/list":
          result = { resources: [resource] };
          break;
        case "tools/call":
          calls++;
          if (disconnect) {
            response.destroy();
            return;
          }
          result = {
            content: [{ type: "text", text: String(message.params.arguments.text) }],
            isError: false,
          };
          break;
        case "resources/read":
          reads++;
          if (disconnect) {
            response.destroy();
            return;
          }
          result = {
            contents: [
              { uri: resource.uri, mimeType: "text/plain", text: "Synthetic plugin resource" },
            ],
          };
          break;
        default:
          throw new Error("Unexpected fixture method");
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    counts: () => ({ calls, reads }),
    loseReply: () => {
      disconnect = true;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
