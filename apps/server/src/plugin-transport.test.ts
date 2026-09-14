import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mcpPluginConnector, pluginFetch } from "./plugin-transport.js";

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

async function statefulFixture(
  options: {
    termination?: "unsupported" | "redirect" | "hang";
    failInitialized?: boolean;
    holdCall?: boolean;
  } = {},
) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const methods: string[] = [];
  const releases: Array<() => void> = [];
  let calls = 0;
  let initialized = 0;
  const server = createServer(async (request, response) => {
    methods.push(`${request.method} ${request.url}`);
    try {
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (request.method === "DELETE") {
        if (options.termination === "unsupported") {
          response.writeHead(405).end();
          return;
        }
        if (options.termination === "redirect") {
          response.writeHead(302, { Location: "/other" }).end();
          return;
        }
        if (options.termination === "hang") return;
        if (!transport) {
          response.writeHead(404).end();
          return;
        }
        await transport.handleRequest(request, response);
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (options.failInitialized && body.method === "notifications/initialized") {
        response.writeHead(503, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      if (!transport) {
        if (body.method !== "initialize") {
          response.writeHead(400).end();
          return;
        }
        initialized++;
        const mcp = new McpServer({ name: "stateful-fixture", version: "1.0.0" });
        servers.push(mcp);
        mcp.registerTool(
          "format_export",
          {
            inputSchema: { format: z.enum(["csv", "json"]) },
          },
          async ({ format }) => {
            calls++;
            if (options.holdCall) await new Promise<void>((resolve) => releases.push(resolve));
            return { content: [{ type: "text", text: format }] };
          },
        );
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
          },
        });
        await mcp.connect(created as Parameters<McpServer["connect"]>[0]);
        transport = created;
      }
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  dispose.push(async () => {
    for (const release of releases) release();
    for (const mcp of servers) await mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint,
    sessions,
    methods,
    connect: mcpPluginConnector([endpoint]),
    get calls() {
      return calls;
    },
    get initialized() {
      return initialized;
    },
  };
}

describe("stateful MCP connection cleanup", () => {
  it("discovers a keyword-like argument, calls it once, and releases every session on idempotent close", async () => {
    const fixture = await statefulFixture();
    for (let i = 0; i < 3; i++) {
      const client = await fixture.connect(fixture.endpoint, undefined, AbortSignal.timeout(5000));
      const catalog = await client.tools(AbortSignal.timeout(5000));
      expect(catalog[0]?.inputSchema.properties).toHaveProperty("format");
      expect(
        await client.call("format_export", { format: "csv" }, AbortSignal.timeout(5000)),
      ).toMatchObject({ content: [{ text: "csv" }] });
      await Promise.all([client.close(), client.close()]);
      expect(fixture.sessions.size).toBe(0);
    }
    expect(fixture.calls).toBe(3);
    expect(fixture.initialized).toBe(3);
    expect(fixture.methods.filter((method) => method === "DELETE /mcp")).toHaveLength(3);
  });

  it("accepts servers that decline DELETE without retrying discovery or tools", async () => {
    const fixture = await statefulFixture({ termination: "unsupported" });
    const client = await fixture.connect(fixture.endpoint, undefined, AbortSignal.timeout(5000));
    await expect(client.close()).resolves.toBeUndefined();
    expect(fixture.initialized).toBe(1);
    expect(fixture.calls).toBe(0);
    expect(fixture.methods.filter((method) => method === "DELETE /mcp")).toHaveLength(1);
  });

  it("cleans up after cancelled calls without replaying their uncertain effect", async () => {
    const fixture = await statefulFixture({ holdCall: true });
    const abort = new AbortController();
    const client = await fixture.connect(fixture.endpoint, undefined, abort.signal);
    const call = client.call("format_export", { format: "csv" }, abort.signal);
    const failed = expect(call).rejects.toBeDefined();
    await vi.waitFor(() => expect(fixture.calls).toBe(1));
    abort.abort();
    await failed;
    await client.close();
    expect(fixture.sessions.size).toBe(0);
    expect(fixture.calls).toBe(1);
    expect(fixture.initialized).toBe(1);
  });

  it("cleans up a known session when the initialized notification fails", async () => {
    const fixture = await statefulFixture({ failInitialized: true });
    await expect(
      fixture.connect(fixture.endpoint, undefined, AbortSignal.timeout(5000)),
    ).rejects.toBeDefined();
    expect(fixture.sessions.size).toBe(0);
    expect(fixture.initialized).toBe(1);
    expect(fixture.calls).toBe(0);
  });

  it("does not follow session deletion redirects", async () => {
    const fixture = await statefulFixture({ termination: "redirect" });
    const client = await fixture.connect(fixture.endpoint, undefined, AbortSignal.timeout(5000));
    await client.close();
    expect(fixture.methods).not.toContain("DELETE /other");
    expect(fixture.methods.filter((method) => method === "DELETE /mcp")).toHaveLength(1);
  });

  it("bounds unresponsive session cleanup even after parent cancellation", async () => {
    const fixture = await statefulFixture({ termination: "hang" });
    const abort = new AbortController();
    const client = await fixture.connect(fixture.endpoint, undefined, abort.signal);
    const started = Date.now();
    abort.abort();
    await client.close();
    expect(Date.now() - started).toBeLessThan(6500);
    expect(fixture.initialized).toBe(1);
    expect(fixture.calls).toBe(0);
    expect(fixture.methods.filter((method) => method === "DELETE /mcp")).toHaveLength(1);
  }, 8000);

  it("rejects DELETE bodies, missing sessions and different endpoints before network access", async () => {
    const fixture = await statefulFixture();
    const request = pluginFetch(fixture.endpoint, undefined, AbortSignal.timeout(5000), [
      fixture.endpoint,
    ]);
    await expect(request(fixture.endpoint, { method: "DELETE" })).rejects.toBeDefined();
    await expect(
      request(fixture.endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": "known" },
        body: "{}",
      }),
    ).rejects.toBeDefined();
    await expect(
      request(`${fixture.endpoint}/other`, {
        method: "DELETE",
        headers: { "mcp-session-id": "known" },
      }),
    ).rejects.toBeDefined();
    expect(fixture.methods).toEqual([]);
  });
});
