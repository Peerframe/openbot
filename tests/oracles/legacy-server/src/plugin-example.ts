import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { examplePluginView } from "./plugin-example-view.js";

/** Standalone third-party process: the note collection belongs to this example, not OpenBot. */
export async function startExamplePlugin(
  port = 4318,
): Promise<{ server: Server; endpoint: string; notes: string[]; close(): Promise<void> }> {
  const notes: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const address = server.address();
    const origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    if (request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 24 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // One protocol instance per HTTP request prevents cross-client message-id collisions.
      const mcp = new McpServer({ name: "openbot-example", version: "1.0.0" });
      mcp.registerTool(
        "sum_numbers",
        {
          description: "Add two finite numbers. This tool does not change any state.",
          inputSchema: {
            a: z.number().min(-1_000_000).max(1_000_000),
            b: z.number().min(-1_000_000).max(1_000_000),
          },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
      );
      mcp.registerTool(
        "append_note",
        {
          description:
            "Append one note to this demo server's in-memory notebook. Changes external state; require Owner approval for each call. Notes disappear on restart.",
          inputSchema: { text: z.string().min(1).max(1000) },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ text }) => {
          if (notes.length >= 100)
            return { isError: true, content: [{ type: "text", text: "Notebook full." }] };
          notes.push(text);
          return { content: [{ type: "text", text: `Saved note ${notes.length}.` }] };
        },
      );
      mcp.registerResource(
        "notebook",
        "notes://current",
        {
          description: "Read the example notebook as plain text.",
          mimeType: "text/plain",
        },
        async (uri) => ({
          contents: [
            { uri: uri.href, mimeType: "text/plain", text: notes.join("\n") || "No notes yet." },
          ],
        }),
      );
      mcp.registerPrompt(
        "review_note",
        {
          description: "Prepare a review prompt for a note selected by the user.",
          argsSchema: { note: z.string().min(1).max(1000) },
        },
        async ({ note }) => ({
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Review this note for clarity: ${note}` },
            },
          ],
        }),
      );
      mcp.registerResource(
        "notebook_view",
        "ui://notebook/view.html",
        {
          description: "An offline notebook viewer with no network or device permissions.",
          mimeType: "text/html;profile=mcp-app",
        },
        async (uri) => ({
          contents: [
            {
              uri: uri.href,
              mimeType: "text/html;profile=mcp-app",
              text: examplePluginView,
              _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
            },
          ],
        }),
      );
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Example did not bind.");
  return {
    server,
    notes,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startExamplePlugin();
  console.log(`Example MCP endpoint: ${demo.endpoint}`);
  console.log(
    "Allow this exact loopback endpoint in OPENBOT_PLUGIN_LOCAL_ENDPOINTS on the OpenBot Server; preview and install it through Plugins.",
  );
  const stop = () => {
    void demo.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
