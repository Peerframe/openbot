import { pathToFileURL } from "node:url";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  checkPluginHttpResponse,
  createPluginMcpClient,
  listCompatiblePluginTools,
  PluginError,
  pluginFailure,
} from "./plugin-compatibility.js";

/** Developer-only loopback probe. Server endpoint/DNS policy remains in plugin-transport.ts. */
export async function preflightPlugin(
  endpoint: string,
  options: { token?: string; timeoutMs?: number } = {},
) {
  const url = new URL(endpoint);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    (options.token !== undefined && !/^[\x21-\x7e]{1,2048}$/u.test(options.token))
  )
    throw new PluginError(
      "invalid",
      "Author preflight requires an exact literal loopback endpoint and a bounded timeout.",
    );
  const signal = AbortSignal.timeout(timeoutMs);
  const client = createPluginMcpClient();
  let cleanup = false;
  const transport = new StreamableHTTPClientTransport(url, {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      if (String(input) !== url.href) throw new PluginError("forbidden");
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method !== "POST" && !(cleanup && init?.method === "DELETE"))
        throw new PluginError("forbidden");
      const headers = new Headers(init.headers);
      if (options.token) headers.set("authorization", `Bearer ${options.token}`);
      const requestSignal = cleanup ? AbortSignal.timeout(5000) : signal;
      const response = await fetch(url, {
        ...init,
        headers,
        signal: requestSignal,
        redirect: "manual",
        credentials: "omit",
      });
      try {
        if (!cleanup)
          checkPluginHttpResponse(response.status, response.headers.get("content-type") ?? "");
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > (cleanup ? 8 * 1024 : 256 * 1024)) throw new PluginError("invalid");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        return new Response(
          [202, 204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
          { status: response.status, headers: response.headers },
        );
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
    },
  });
  try {
    // SDK 1.30's optional session getter conflicts with exactOptionalPropertyTypes only.
    await client.connect(transport as Parameters<typeof client.connect>[0], {
      signal,
      timeout: timeoutMs,
    });
    const tools = await listCompatiblePluginTools(client, signal);
    return {
      ok: true as const,
      profile: "openbot-mcp-tools-v1" as const,
      protocolVersion: transport.protocolVersion,
      tools: tools.map((tool) => tool.name),
      toolCalls: 0,
      unchecked: [
        "tool-results-and-effects",
        "resources-and-prompts",
        "server-installation-and-grants",
      ],
    };
  } catch (error) {
    throw pluginFailure(error, signal);
  } finally {
    cleanup = true;
    if (transport.sessionId) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw new PluginError("invalid", "Usage: npm run preflight -- http://127.0.0.1:4318/mcp");
    console.log(
      JSON.stringify(
        await preflightPlugin(process.argv[2] ?? "", {
          ...(process.env.OPENBOT_PLUGIN_TEST_TOKEN
            ? { token: process.env.OPENBOT_PLUGIN_TEST_TOKEN }
            : {}),
        }),
      ),
    );
  } catch (error) {
    const failure = error instanceof PluginError ? error : pluginFailure(error);
    console.log(
      JSON.stringify({
        ok: false,
        code: failure.code,
        ...(failure.compatibility ? { compatibility: failure.compatibility } : {}),
        error: failure.message,
      }),
    );
    process.exitCode = 1;
  }
}
