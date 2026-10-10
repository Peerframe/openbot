/** Owns bounded MCP sessions and returns observations independently of cleanup success. */
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pluginPromptResultHttpSchema, pluginResourceResultHttpSchema } from "@openbot/protocol";
import { pluginError, pluginManifest, pluginParse, pluginValidator } from "./plugin-values.js";

function ranges(entries: readonly string[], family: "ipv4" | "ipv6") {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/");
    list.addSubnet(address!, Number(prefix), family);
  }
  return list;
}
// IANA special-use ranges, matching the retained CPython3.12.13 policy. Node handles parsing.
const private4 = ranges(
  [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "100.64.0.0/10",
  ],
  "ipv4",
);
const private6 = ranges(["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"], "ipv6");
const exceptions6 = ranges(
  [
    "2001:1::1/128",
    "2001:1::2/128",
    "2001:3::/32",
    "2001:4:112::/48",
    "2001:20::/28",
    "2001:30::/28",
  ],
  "ipv6",
);
const global6 = ranges(["2000::/3"], "ipv6");
export function publicPluginAddress(value: string): boolean {
  if (value.includes("%")) return false;
  const family = isIP(value);
  return family === 4
    ? ["192.0.0.9", "192.0.0.10"].includes(value) || !private4.check(value, "ipv4")
    : family === 6 &&
        global6.check(value, "ipv6") &&
        (!private6.check(value, "ipv6") || exceptions6.check(value, "ipv6"));
}
export function normalizePluginEndpoint(value: string, local: readonly string[] = []): string {
  try {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\\?#]/u.test(value) ||
      [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    )
      return pluginError("invalid");
    if (/^[^/]+:\/\/[^/]*@/.test(value)) return pluginError("invalid");
    const url = new URL(value),
      host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.username || url.password || !host || !["http:", "https:"].includes(url.protocol))
      return pluginError("invalid");
    const normalized = url.href;
    if (["127.0.0.1", "::1"].includes(host) && local.includes(normalized)) return normalized;
    if (
      url.protocol !== "https:" ||
      (isIP(host)
        ? !publicPluginAddress(host)
        : !host.includes(".") || /\.(local|localhost|internal|test|invalid|onion)$/i.test(host))
    )
      return pluginError("invalid");
    return normalized;
  } catch {
    return pluginError("invalid");
  }
}
// Constructor-injected resolver is only used by tests; production always resolves every address.
export class PluginTransport {
  readonly endpoint: string;
  #session?: string;
  cleanup = false;
  constructor(
    endpoint: string,
    readonly token: string | undefined,
    readonly local: readonly string[],
    readonly signal: AbortSignal,
    readonly resolve: (host: string, options: { all: true }) => Promise<LookupAddress[]> = lookup,
    readonly beforeRequest?: (message: unknown) => Promise<void>,
  ) {
    this.endpoint = normalizePluginEndpoint(endpoint, local);
  }
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const target = input instanceof Request ? input.url : String(input);
    if (target !== this.endpoint) return pluginError("forbidden");
    const method = init?.method ?? "GET",
      headers = new Headers(init?.headers);
    if (method === "GET") return new Response(null, { status: 405 });
    const ending = method === "DELETE",
      raw = init?.body;
    if (raw != null && typeof raw !== "string") return pluginError("invalid");
    const body = raw ?? "",
      maximum = ending ? 8192 : 262144;
    if (
      ending
        ? !this.cleanup ||
          !this.#session ||
          headers.get("mcp-session-id") !== this.#session ||
          body.length > 0
        : method !== "POST" || Buffer.byteLength(body) > 24576
    )
      return pluginError("forbidden");
    const url = new URL(this.endpoint),
      host = url.hostname.replace(/^\[|\]$/g, ""),
      family = isIP(host);
    const signal = ending
      ? AbortSignal.timeout(5000)
      : AbortSignal.any([
          this.signal,
          AbortSignal.timeout(30000),
          ...(init?.signal ? [init.signal] : []),
        ]);
    signal.throwIfAborted();
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    let resolved: { address: string; family: number }[];
    try {
      resolved = family
        ? [{ address: host, family }]
        : await Promise.race([this.resolve(host, { all: true }), cancelled]);
    } finally {
      if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    }
    const addresses = [...new Map(resolved.map((v) => [v.address, v])).values()];
    const local = ["127.0.0.1", "::1"].includes(host) && this.local.includes(this.endpoint);
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some(
        (a) => a.family !== isIP(a.address) || (!local && !publicPluginAddress(a.address)),
      )
    )
      return pluginError("forbidden");
    signal.throwIfAborted();
    // The Work one-use gate runs after DNS validation, immediately before the pinned send.
    if (!ending) await this.beforeRequest?.(JSON.parse(body));
    signal.throwIfAborted();
    const outgoing: Record<string, string> = {
      Host: url.host,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    };
    for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
      const value = headers.get(name);
      if (value) {
        if (!/^[\x21-\x7e]{1,512}$/.test(value)) return pluginError("invalid");
        outgoing[name] = value;
      }
    }
    if (this.token) outgoing.Authorization = "Bearer " + this.token;
    const secure = url.protocol === "https:",
      agent = secure
        ? new HttpsAgent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true })
        : new HttpAgent({ keepAlive: false, maxSockets: 1 });
    try {
      return await new Promise<Response>((resolve, reject) => {
        const request = (secure ? httpsRequest : httpRequest)(
          url,
          {
            method,
            headers: outgoing,
            agent,
            signal,
            rejectUnauthorized: true,
            lookup: (_host: string, options: any, callback: any) =>
              options.all
                ? callback(null, [addresses[0]!])
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          },
          (response) => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                responseHeaders.set(key, Array.isArray(value) ? value.join(",") : value);
            const status = response.statusCode ?? 500;
            try {
              if (
                (status >= 300 && status < 400) ||
                (responseHeaders.get("content-encoding") ?? "identity") !== "identity"
              )
                pluginError("unavailable");
              const length = responseHeaders.get("content-length");
              if (length && (!/^\d+$/.test(length) || Number(length) > maximum))
                pluginError("unavailable");
              if (
                !ending &&
                ![202, 204].includes(status) &&
                !/^(application\/json|text\/event-stream)(\s*;|$)/i.test(
                  responseHeaders.get("content-type") ?? "",
                )
              )
                pluginError("unavailable");
              const session = responseHeaders.get("mcp-session-id");
              if (session) {
                if (!/^[\x21-\x7e]{1,512}$/.test(session)) pluginError("unavailable");
                this.#session = session;
              }
            } catch (error) {
              response.destroy();
              reject(error);
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maximum) {
                response.destroy();
                reject(new Error("Plugin response limit."));
              } else chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("aborted", () => reject(new Error("Plugin response aborted.")));
            response.once("end", () => {
              try {
                const retained = new Headers();
                for (const key of ["content-type", "mcp-session-id"])
                  if (responseHeaders.has(key)) retained.set(key, responseHeaders.get(key)!);
                resolve(
                  new Response(
                    [204, 205, 304].includes(status) ? null : new Uint8Array(Buffer.concat(chunks)),
                    { status, headers: retained },
                  ),
                );
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once("error", reject);
        request.end(body);
      });
    } finally {
      agent.destroy();
    }
  }
  async finish() {
    if (!this.#session) return;
    this.cleanup = true;
    try {
      await this.fetch(this.endpoint, {
        method: "DELETE",
        headers: { "mcp-session-id": this.#session },
      });
    } catch {
    } finally {
      this.cleanup = false;
    }
  }
}
export async function withPlugin<T>(
  endpoint: string,
  token: string | undefined,
  local: readonly string[],
  signal: AbortSignal,
  use: (client: Client) => Promise<T>,
  beforeRequest?: (message: unknown) => Promise<void>,
): Promise<T> {
  const transport = new PluginTransport(endpoint, token, local, signal, lookup, beforeRequest);
  const sdk = new StreamableHTTPClientTransport(new URL(transport.endpoint), {
    fetch: transport.fetch.bind(transport),
    requestInit: { redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1,
      initialReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client(
    { name: "openbot", version: "0.1.0" },
    { jsonSchemaValidator: { getValidator: pluginValidator } },
  );
  client.onerror = () => undefined;
  const abort = () => {
    void client.close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted(); // SDK1.32.1 declares its optional session getter as string | undefined, unlike its Transport interface.
    await client.connect(sdk as Parameters<Client["connect"]>[0], { signal, timeout: 30000 });
    return await use(client);
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await client.close();
    } catch {
      // Cleanup cannot replace an observed result or the operation's original failure.
    } finally {
      await transport.finish();
    }
  }
}
export async function readPluginManifest(
  client: Client,
  name: string,
  endpoint: string,
  signal: AbortSignal,
) {
  const capabilities = client.getServerCapabilities(),
    options = { signal, timeout: 30000 };
  const toolList = capabilities?.tools ? await client.listTools({}, options) : { tools: [] };
  const resourceList = capabilities?.resources
    ? await client.listResources({}, options)
    : { resources: [] };
  const promptList = capabilities?.prompts
    ? await client.listPrompts({}, options)
    : { prompts: [] };
  for (const list of [toolList, resourceList, promptList])
    if ("nextCursor" in list && list.nextCursor) pluginError("invalid");
  const tools = toolList.tools.map((t) => {
    if (t.outputSchema) pluginValidator(t.outputSchema);
    return {
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      ...(t._meta?.ui && typeof t._meta.ui === "object" && "resourceUri" in t._meta.ui
        ? { resourceUri: t._meta.ui.resourceUri }
        : {}),
    };
  });
  const resources = resourceList.resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description ?? "",
    ...(r.mimeType ? { mimeType: r.mimeType } : {}),
  }));
  const prompts = promptList.prompts.map((p) => ({
    name: p.name,
    description: p.description ?? "",
    arguments: p.arguments ?? [],
  }));
  return pluginManifest(name, endpoint, tools, resources, prompts);
}
export async function readPluginContent(
  client: Client,
  kind: "resource" | "prompt",
  name: string,
  args: Record<string, string>,
  signal: AbortSignal,
) {
  const options = { signal, timeout: 30000 };
  return kind === "resource"
    ? pluginParse(
        pluginResourceResultHttpSchema,
        await client.readResource({ uri: name }, options),
        160 * 1024,
      )
    : pluginParse(
        pluginPromptResultHttpSchema,
        await client.getPrompt({ name, arguments: args }, options),
        12288,
      );
}
