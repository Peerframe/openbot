/** Owns a loopback MCP SDK peer for contract checks; declarations and content are synthetic. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function contractPluginFixture() {
  const token = randomBytes(32).toString("hex"), controllerToken = randomBytes(32).toString("hex");
  const stats = { requests: 0, deletedSessions: 0, badAuth: 0, toolCalls: 0, resourceReads: 0, promptReads: 0 };
  const state = { revision: 1, large: false };
  const sessions = new Map<string, { peer: Server; transport: StreamableHTTPServerTransport }>();
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  };
  const readBody = async (request: IncomingMessage, limit: number) => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("Fixture body limit."); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const server = createServer(async (request, response) => {
    try {
      const controller = request.url === "/fixture-control";
      const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from("Bearer " + (controller ? controllerToken : token));
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { stats.badAuth++; respond(response, 401, { error: "unauthorized" }); return; }
      if (controller) {
        if (request.method !== "POST") { respond(response, 405, {}); return; }
        const value = await readBody(request, 1024);
        assert(value && typeof value === "object" && !Array.isArray(value));
        assert(Object.keys(value).every((key) => ["revision", "large"].includes(key)));
        if ("revision" in value) { assert([1, 2].includes(value.revision)); state.revision = value.revision; }
        if ("large" in value) { assert.equal(typeof value.large, "boolean"); state.large = value.large; }
        respond(response, 200, { ...stats, ...state }); return;
      }
      if (request.url !== "/mcp") { respond(response, 404, {}); return; }
      stats.requests++;
      const id = request.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (request.method === "DELETE") stats.deletedSessions++;
      const body = request.method === "POST" ? await readBody(request, 32768) : undefined;
      if (!session && !id && body?.method === "initialize") {
        assert(sessions.size < 16);
        const peer = new Server({ name: "contract-fixture", version: "1" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: (sessionId) => { sessions.set(sessionId, { peer, transport }); } });
        peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
          { name: "read_value", description: `Synthetic read declaration ${state.revision}.`, inputSchema: { type: "object", properties: {} } },
          { name: "write_note", description: "Synthetic effect; checks never execute this tool.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
        ] }));
        peer.setRequestHandler(CallToolRequestSchema, async ({ params }) => { stats.toolCalls++; return { content: [{ type: "text", text: params.name === "read_value" ? "42" : "saved" }] }; });
        peer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
          { name: "info", uri: "notes://public/info", description: "Synthetic untrusted resource.", mimeType: "text/plain" },
          { name: "card", uri: "ui://fixture/card", description: "Synthetic untrusted app.", mimeType: "text/html;profile=mcp-app" },
        ] }));
        peer.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
          assert(["notes://public/info", "ui://fixture/card"].includes(params.uri)); stats.resourceReads++;
          return { contents: [{ uri: params.uri, mimeType: params.uri.startsWith("ui:") ? "text/html;profile=mcp-app" : "text/plain", text: params.uri.startsWith("ui:") ? "<html><body>Untrusted app</body></html>" : state.large ? "x".repeat(13 * 1024) : "Untrusted 文档 🧪" }] };
        });
        peer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "compose", description: "Synthetic untrusted prompt.", arguments: [{ name: "topic", required: true }] }] }));
        peer.setRequestHandler(GetPromptRequestSchema, async ({ params }) => { assert.equal(params.name, "compose"); stats.promptReads++; return { messages: [{ role: "user", content: { type: "text", text: "Write about " + params.arguments?.topic } }] }; });
        // The SDK transport accessor includes undefined while its own Transport interface uses optional fields.
        await peer.connect(transport as Transport);
        const onclose = transport.onclose;
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); onclose?.(); };
        session = { peer, transport };
      }
      if (!session) { respond(response, 404, {}); return; }
      await session.transport.handleRequest(request, response, body);
    } catch { if (!response.headersSent) respond(response, 400, { error: "invalid" }); else response.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, token, controllerToken,
    async close() { await Promise.all([...sessions.values()].map(({ peer }) => peer.close())); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
