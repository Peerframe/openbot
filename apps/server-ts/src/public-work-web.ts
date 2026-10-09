import { spawn } from "node:child_process";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkConflict } from "@openbot/work";
import { publicPluginAddress } from "./plugin-transport.js";
import { workText } from "./work-values.js";

export function normalizeWorkSource(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "\\") ||
    /[\ud800-\udfff]/u.test(value)
  )
    throw new WorkConflict("invalid_web_url");
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes("@") || authority.includes("%"))
    throw new WorkConflict("invalid_web_url");
  const rawHost = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]"))
    : authority.split(":")[0]!;
  // Reject legacy numeric IPv4 forms before WHATWG can turn them into another address.
  if (!isIP(rawHost) && (/^[0-9.]+$/.test(rawHost) || /(^|\.)(0x[0-9a-f]+|[0-9]+)$/i.test(rawHost)))
    throw new WorkConflict("invalid_web_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkConflict("invalid_web_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host ||
    host.endsWith(".") ||
    (isIP(host)
      ? !publicPluginAddress(host)
      : !host.includes(".") ||
        /(^|\.)(localhost|local|internal|test|invalid|onion)$/i.test(host) ||
        !/^[a-z0-9.-]+$/i.test(host) ||
        host.split(".").some((p) => !p || p.length > 63 || p.startsWith("-") || p.endsWith("-")))
  )
    throw new WorkConflict("web_target_denied");
  url.hash = "";
  return url.href;
}
export function workSourceUrls(objective: string) {
  const values: string[] = [];
  for (const found of objective.matchAll(/https:\/\/[^\s<>"'`，。；！？（）]+/gi)) {
    try {
      const value = normalizeWorkSource(found[0].replace(/[),.;!?，。；！？）]+$/, ""));
      if (!values.includes(value)) values.push(value);
    } catch {}
    if (values.length === 3) break;
  }
  return values;
}
export function clipWebText(value: string, maximum: number) {
  let bytes = 0,
    result = "";
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximum) break;
    result += character;
  }
  return result;
}
export async function htmlWorkText(body: Buffer, signal: AbortSignal) {
  if (body.length > 524288) throw new WorkConflict("web_page_limit");
  const worker = fileURLToPath(new URL("./work-html-worker.js", import.meta.url));
  let modules = dirname(createRequire(import.meta.url).resolve("htmlparser2"));
  while (basename(modules) !== "node_modules") {
    const parent = dirname(modules);
    if (parent === modules) throw new WorkConflict("web_parser_unavailable");
    modules = parent;
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
  bounded.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        "--allow-fs-read=" + dirname(worker),
        "--allow-fs-read=" + modules,
        "--max-old-space-size=64",
        "--max-semi-space-size=8",
        worker,
      ],
      { cwd: "/", env: { LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"] },
    );
    let size = 0,
      failed = false;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    bounded.addEventListener("abort", stop, { once: true });
    if (bounded.aborted) stop();
    child.once("error", stop);
    child.stdin.once("error", stop);
    child.stdout.once("error", stop);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      bounded.removeEventListener("abort", stop);
      if (failed || code !== 0) {
        reject(new WorkConflict("web_parser_unavailable"));
        return;
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        reject(new WorkConflict("web_text_invalid"));
      }
    });
    child.stdin.end(body);
  });
}
export type SearchConfiguration = {
  provider: "tavily" | "kimi";
  revision: string;
  key: string;
  model?: {
    connectionId: string;
    revision: number;
    modelId: string;
    protocol: string;
    presetId: string;
    baseUrl: string;
  };
};
const kimiBases = ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"];
export function searchSnapshot(configuration: SearchConfiguration) {
  if (
    !/^[\x21-\x7e]{1,2048}$/.test(configuration.key) ||
    !/^[\x21-\x7e]{1,128}$/.test(configuration.revision)
  )
    throw new WorkConflict("web_search_configuration_changed");
  if (configuration.provider === "tavily" && configuration.model === undefined)
    return { provider: "tavily", revision: configuration.revision };
  const model = configuration.model;
  if (
    configuration.provider !== "kimi" ||
    !model ||
    model.presetId !== "kimi" ||
    model.protocol !== "openai-chat" ||
    !kimiBases.includes(model.baseUrl)
  )
    throw new WorkConflict("web_search_configuration_changed");
  return { provider: "kimi", revision: configuration.revision, model };
}
export function webQuery(value: unknown) {
  const query = workText(value, 4000).trim();
  if (!query || query.length > 1000) throw new WorkConflict("invalid_web_query");
  return query;
}
/** Test-only constructor ports preserve public DNS checks; product composition uses Node HTTPS. */
export class PublicWorkWeb {
  constructor(
    readonly resolve: (host: string, options: { all: true }) => Promise<LookupAddress[]> = lookup,
    readonly request = httpsRequest,
    readonly convert = htmlWorkText,
  ) {}
  private async send(
    target: string,
    beforeSend: () => Promise<void>,
    signal: AbortSignal,
    body?: string,
    key?: string,
  ) {
    const normalized = normalizeWorkSource(target),
      url = new URL(normalized),
      host = url.hostname.replace(/^\[|\]$/g, "");
    const search = body !== undefined;
    if (
      search &&
      (key === undefined ||
        ![
          "https://api.tavily.com/search",
          ...kimiBases.map((b) => b + "/formulas/moonshot/web-search:latest/fibers"),
        ].includes(normalized))
    )
      throw new WorkConflict("web_target_denied");
    if (!search && key !== undefined) throw new WorkConflict("web_target_denied");
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new WorkConflict("web_request_cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([this.resolve(host, { all: true }), cancelled]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
    addresses = [...new Map(addresses.map((a) => [a.address, a])).values()];
    if (
      !addresses.length ||
      addresses.length > 32 ||
      addresses.some((a) => a.family !== isIP(a.address) || !publicPluginAddress(a.address))
    )
      throw new WorkConflict("web_dns_denied");
    await beforeSend();
    signal.throwIfAborted();
    const agent = new Agent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true });
    const maximum = search ? 262144 : 524288;
    try {
      return await new Promise<{ type: string; body: Buffer }>((resolve, reject) => {
        const headers: Record<string, string> = {
          Host: url.host,
          "Accept-Encoding": "identity",
          Accept: search ? "application/json" : "text/html, text/plain;q=0.9",
          "User-Agent": "OpenBot-SourceReader/1.0",
        };
        if (search) {
          headers.Authorization = "Bearer " + key;
          headers["Content-Type"] = "application/json";
          headers["Content-Length"] = String(Buffer.byteLength(body!));
        }
        const request = this.request(
          url,
          {
            method: search ? "POST" : "GET",
            headers,
            agent,
            signal,
            rejectUnauthorized: true,
            lookup: (_hostname, options, callback) =>
              options.all
                ? callback(null, [addresses[0]!])
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          },
          (response) => {
            const type = response.headers["content-type"] ?? "",
              length = response.headers["content-length"],
              status = response.statusCode ?? 0;
            if (
              (search ? status < 200 || status >= 300 : status !== 200) ||
              (response.headers["content-encoding"] ?? "identity").toLowerCase() !== "identity" ||
              !(search ? /^application\/json(\s*;|$)/i : /^text\/(html|plain)(\s*;|$)/i).test(
                type,
              ) ||
              (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum))
            ) {
              response.destroy();
              reject(new WorkConflict("web_response_refused"));
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > maximum) {
                response.destroy();
                reject(new WorkConflict("web_response_limit"));
              } else chunks.push(chunk);
            });
            response.once("aborted", () => reject(new WorkConflict("web_response_aborted")));
            response.once("error", () => reject(new WorkConflict("web_response_failed")));
            response.once("end", () => resolve({ type, body: Buffer.concat(chunks) }));
          },
        );
        request.once("error", () => reject(new WorkConflict("web_request_failed")));
        request.end(body);
      });
    } finally {
      agent.destroy();
    }
  }
  async read(url: string, beforeSend: () => Promise<void>, signal: AbortSignal) {
    const normalized = normalizeWorkSource(url),
      bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const response = await this.send(normalized, beforeSend, bounded);
    let raw = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    if (/^text\/html/i.test(response.type)) raw = await this.convert(response.body, bounded);
    raw = [...raw]
      .filter((c) => {
        const n = c.codePointAt(0)!;
        return n !== 127 && (n >= 32 || [9, 10, 13].includes(n));
      })
      .join("")
      .trim();
    if (!raw) throw new WorkConflict("web_empty_response");
    return {
      url: normalized,
      text: clipWebText(raw, 6000),
      truncated: Buffer.byteLength(raw) > 6000,
      fetchedAt: new Date().toISOString(),
    };
  }
  async search(
    query: string,
    configuration: SearchConfiguration,
    beforeSend: () => Promise<void>,
    signal: AbortSignal,
  ) {
    searchSnapshot(configuration);
    query = webQuery(query);
    const endpoint =
      configuration.provider === "tavily"
        ? "https://api.tavily.com/search"
        : configuration.model!.baseUrl + "/formulas/moonshot/web-search:latest/fibers";
    const body = JSON.stringify(
      configuration.provider === "tavily"
        ? {
            query,
            max_results: 5,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
          }
        : { name: "web_search", arguments: JSON.stringify({ query }) },
    );
    const response = await this.send(
      endpoint,
      beforeSend,
      AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      body,
      configuration.key,
    );
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    if (configuration.provider === "tavily") return tavilyResult(value);
    const context = value?.context;
    if (
      value?.status !== "succeeded" ||
      !context ||
      ["output", "encrypted_output"].some((k) => k in context && typeof context[k] !== "string")
    )
      throw new WorkConflict("web_search_response_invalid");
    const output = context.output || context.encrypted_output;
    if (
      typeof output !== "string" ||
      !output.trim() ||
      output.length > 100000 ||
      Buffer.byteLength(JSON.stringify(output)) > 131072
    )
      throw new WorkConflict("web_search_response_invalid");
    return output as string;
  }
}
function tavilyResult(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("results" in value) ||
    !Array.isArray(value.results) ||
    value.results.length < 1 ||
    value.results.length > 20
  )
    throw new WorkConflict("web_search_response_invalid");
  const rows = value.results as Record<string, unknown>[];
  for (const row of rows) {
    if (
      !row ||
      ["url", "title", "content"].some((k) => typeof row[k] !== "string") ||
      !(row.content as string).length ||
      (row.url as string).length > 2048 ||
      (row.published_date !== undefined && typeof row.published_date !== "string")
    )
      throw new WorkConflict("web_search_response_invalid");
    try {
      new URL(row.url as string);
    } catch {
      throw new WorkConflict("web_search_response_invalid");
    }
  }
  const results = rows
    .slice(0, 5)
    .map((row) => ({
      url: row.url as string,
      title: clipWebText(row.title as string, 256),
      content: clipWebText(row.content as string, 2000),
      truncated:
        Buffer.byteLength(row.title as string) > 256 ||
        Buffer.byteLength(row.content as string) > 2000,
      ...(row.published_date
        ? { publishedAt: clipWebText(row.published_date as string, 100) }
        : {}),
    }));
  const evidence = {
    provider: "tavily",
    retrievedAt: new Date().toISOString(),
    truncated: rows.length > 5,
    results,
  };
  while (Buffer.byteLength(JSON.stringify(evidence)) > 16384) {
    const item = results.reduce((a, b) =>
      Buffer.byteLength(a.content) >= Buffer.byteLength(b.content) ? a : b,
    );
    const size = Buffer.byteLength(item.content);
    if (size < 2) throw new WorkConflict("web_search_response_limit");
    item.content = clipWebText(item.content, Math.floor(size / 2));
    item.truncated = true;
  }
  return JSON.stringify(evidence);
}
