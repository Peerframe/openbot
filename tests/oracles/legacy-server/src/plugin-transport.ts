import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { isPublicSourceAddress } from "./agent-sources.js";
import {
  boundedJson,
  checkPluginSchema,
  PluginError,
  type PluginPrompt,
  type PluginResource,
  type PluginTool,
  pluginPromptResultSchema,
  pluginPromptSchema,
  pluginResourceResultSchema,
  pluginResourceSchema,
  pluginToolSchema,
} from "./plugin-types.js";

export function normalizePluginEndpoint(
  value: string,
  localEndpoints: readonly string[] = [],
): URL {
  if (value.length > 2048 || value.trim() !== value) throw new PluginError("invalid");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new PluginError("invalid");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const local = (host === "127.0.0.1" || host === "::1") && localEndpoints.includes(url.href);
  if (local && ["http:", "https:"].includes(url.protocol)) return url;
  if (
    url.protocol !== "https:" ||
    (isIP(host) && !isPublicSourceAddress(host)) ||
    (!isIP(host) &&
      (!host.includes(".") || /\.(?:local|localhost|internal|test|invalid|onion)$/iu.test(host)))
  )
    throw new PluginError(
      "invalid",
      "插件需要公开 HTTPS 地址；本机测试地址必须先由服务端明确允许。",
    );
  return url;
}

export async function abortPluginOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new PluginError("unavailable"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** SDK owns MCP; this adapter pins network identity and bounds every returned HTTP body. */
export function pluginFetch(
  endpoint: string,
  token: string | undefined,
  signal: AbortSignal,
  localEndpoints: readonly string[] = [],
): typeof fetch {
  const endpointUrl = normalizePluginEndpoint(endpoint, localEndpoints);
  return async (input, init) => {
    if (String(input) !== endpointUrl.href) throw new PluginError("forbidden");
    // Server push streams are unnecessary for this bounded request/response client.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const terminating = init?.method === "DELETE";
    const sourceHeaders = new Headers(init?.headers);
    const sessionId = sourceHeaders.get("mcp-session-id");
    if (terminating) {
      if (init.body != null || !sessionId || !/^[\x21-\x7e]{1,512}$/u.test(sessionId))
        throw new PluginError("invalid");
    } else if (
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 24 * 1024
    )
      throw new PluginError("invalid");
    const maximumBytes = terminating ? 8 * 1024 : 256 * 1024;
    const deadline = AbortSignal.any([
      signal,
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(terminating ? 5000 : 30_000),
    ]);
    const hostname = endpointUrl.hostname.replace(/^\[|\]$/gu, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortPluginOperation(lookup(hostname, { all: true, verbatim: true }), deadline);
    const local =
      localEndpoints.includes(endpointUrl.href) && ["127.0.0.1", "::1"].includes(hostname);
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some(
        (item) =>
          item.family !== isIP(item.address) || (!local && !isPublicSourceAddress(item.address)),
      )
    )
      throw new PluginError("forbidden");
    const address = addresses[0];
    if (!address) throw new PluginError("forbidden");
    deadline.throwIfAborted();
    const headers: Record<string, string> = {
      Host: endpointUrl.host,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    };
    for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
      const value = sourceHeaders.get(name);
      if (value && value.length <= 512) headers[name] = value;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    return await new Promise<Response>((resolve, reject) => {
      const request = endpointUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        endpointUrl,
        {
          method: terminating ? "DELETE" : "POST",
          hostname: address.address,
          family: address.family,
          servername: isIP(hostname) ? "" : hostname,
          checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
          rejectUnauthorized: true,
          agent: false,
          signal: deadline,
          headers,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const contentType = response.headers["content-type"] ?? "";
          const encoding = response.headers["content-encoding"];
          if (
            (status >= 300 && status < 400) ||
            (encoding && encoding !== "identity") ||
            Number(response.headers["content-length"] ?? 0) > maximumBytes
          ) {
            response.destroy();
            reject(new PluginError("unavailable"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > maximumBytes) response.destroy(new PluginError("unavailable"));
            else chunks.push(chunk);
          });
          response.on("error", () => reject(new PluginError("unavailable")));
          response.on("end", () => {
            const resultHeaders = new Headers();
            if (contentType) resultHeaders.set("content-type", contentType);
            const session = response.headers["mcp-session-id"];
            if (typeof session === "string" && session.length <= 512)
              resultHeaders.set("mcp-session-id", session);
            if (
              !terminating &&
              ![202, 204].includes(status) &&
              !/^(?:application\/json|text\/event-stream)(?:\s*;|$)/iu.test(contentType)
            ) {
              reject(new PluginError("unavailable"));
              return;
            }
            resolve(
              new Response(
                terminating || [202, 204].includes(status) ? null : Buffer.concat(chunks),
                {
                  status,
                  headers: resultHeaders,
                },
              ),
            );
          });
        },
      );
      req.on("error", () => reject(new PluginError("unavailable")));
      req.end(terminating ? undefined : init?.body);
    });
  };
}

export interface PluginConnection {
  tools(signal: AbortSignal): Promise<PluginTool[]>;
  resources?(signal: AbortSignal): Promise<PluginResource[]>;
  prompts?(signal: AbortSignal): Promise<PluginPrompt[]>;
  readResource?(uri: string, signal: AbortSignal): Promise<unknown>;
  getPrompt?(name: string, args: Record<string, string>, signal: AbortSignal): Promise<unknown>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export type PluginConnector = (
  endpoint: string,
  token: string | undefined,
  signal: AbortSignal,
) => Promise<PluginConnection>;

export function mcpPluginConnector(localEndpoints: readonly string[] = []): PluginConnector {
  return async (endpoint, token, signal) => {
    signal.throwIfAborted();
    const operation = new AbortController();
    const operationSignal = AbortSignal.any([signal, operation.signal]);
    const request = pluginFetch(endpoint, token, operationSignal, localEndpoints);
    let cleanup: { sessionId: string; signal: AbortSignal } | undefined;
    const client = new Client(
      { name: "openbot", version: "0.1.0" },
      {
        capabilities: {},
        jsonSchemaValidator: {
          getValidator(schema) {
            checkPluginSchema(schema as Record<string, unknown>);
            return new AjvJsonSchemaValidator().getValidator(schema);
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(
      normalizePluginEndpoint(endpoint, localEndpoints),
      {
        fetch: async (input, init) => {
          if (init?.method !== "DELETE") return request(input, init);
          if (!cleanup || new Headers(init.headers).get("mcp-session-id") !== cleanup.sessionId)
            throw new PluginError("forbidden");
          // Cleanup may outlive cancellation, but only for this session at the reviewed endpoint.
          return pluginFetch(
            endpoint,
            token,
            cleanup.signal,
            localEndpoints,
          )(input, {
            ...init,
            signal: cleanup.signal,
          });
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      },
    );
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      signal.removeEventListener("abort", abort);
      operation.abort();
      closing = (async () => {
        try {
          if (transport.sessionId) {
            cleanup = { sessionId: transport.sessionId, signal: AbortSignal.timeout(5000) };
            await abortPluginOperation(transport.terminateSession(), cleanup.signal).catch(
              () => {},
            );
          }
        } finally {
          cleanup = undefined;
          await client.close().catch(() => {});
        }
      })();
      return closing;
    };
    const abort = () => {
      void close();
    };
    signal.addEventListener("abort", abort, { once: true });
    // SDK 1.30's optional sessionId getter conflicts with exactOptionalPropertyTypes;
    // its own Client consumes this official transport unchanged at runtime.
    try {
      await abortPluginOperation(
        client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 30_000 }),
        signal,
      );
    } catch {
      await close();
      throw new PluginError("unavailable");
    }
    return {
      async tools(callSignal) {
        if (!client.getServerCapabilities()?.tools) return [];
        const result = await client.listTools({}, { signal: callSignal, timeout: 30_000 });
        if (result.nextCursor || result.tools.length > 32)
          throw new PluginError("invalid", "插件工具目录过大，当前最多支持完整的32项工具。");
        return result.tools.map((tool) => {
          const checked = pluginToolSchema.parse({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(tool._meta?.ui &&
            typeof tool._meta.ui === "object" &&
            "resourceUri" in tool._meta.ui
              ? { resourceUri: tool._meta.ui.resourceUri }
              : {}),
          });
          checkPluginSchema(checked.inputSchema);
          new AjvJsonSchemaValidator().getValidator(checked.inputSchema);
          return checked;
        });
      },
      async resources(callSignal) {
        if (!client.getServerCapabilities()?.resources) return [];
        const result = await client.listResources({}, { signal: callSignal, timeout: 30_000 });
        if (result.nextCursor || result.resources.length > 32) throw new PluginError("invalid");
        return result.resources.map((item) =>
          pluginResourceSchema.parse({
            uri: item.uri,
            name: item.name,
            description: item.description ?? "",
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          }),
        );
      },
      async prompts(callSignal) {
        if (!client.getServerCapabilities()?.prompts) return [];
        const result = await client.listPrompts({}, { signal: callSignal, timeout: 30_000 });
        if (result.nextCursor || result.prompts.length > 32) throw new PluginError("invalid");
        return result.prompts.map((item) =>
          pluginPromptSchema.parse({
            name: item.name,
            description: item.description ?? "",
            arguments: item.arguments ?? [],
          }),
        );
      },
      async readResource(uri, callSignal) {
        const result = await client.readResource({ uri }, { signal: callSignal, timeout: 30_000 });
        boundedJson(result, 160 * 1024);
        return pluginResourceResultSchema.parse(result);
      },
      async getPrompt(name, args, callSignal) {
        const result = await client.getPrompt(
          { name, arguments: args },
          { signal: callSignal, timeout: 30_000 },
        );
        boundedJson(result, 12 * 1024);
        return pluginPromptResultSchema.parse(result);
      },
      async call(name, args, callSignal) {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          signal: callSignal,
          timeout: 30_000,
        });
        if (result.isError) throw new PluginError("unavailable");
        const content = result.content;
        if (
          !Array.isArray(content) ||
          content.some((item) => item.type !== "text" || typeof item.text !== "string")
        )
          throw new PluginError("unavailable", "插件返回了当前不支持的非文本结果。");
        const output = {
          content: content.map((item) => ({ type: "text", text: item.text })),
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        };
        boundedJson(output, 12 * 1024);
        return output;
      },
      close,
    };
  };
}
