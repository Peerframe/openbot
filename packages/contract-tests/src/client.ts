import assert from "node:assert/strict";
import { contractTargetSchema, type ContractTarget } from "./target.ts";

export type RequestOptions = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string | false;
  origin?: string;
  userAgent?: string;
  bytes?: Uint8Array<ArrayBuffer>;
  filename?: string;
  contentType?: string;
  timeoutMs?: 10000 | 35000;
  ifMatch?: string;
  maxResponseBytes?: 4194304 | 8388608;
  signal?: AbortSignal;
};

/** A target is explicit and disposable. Redirects can never send credentials to another origin. */
export function contractClient(input: ContractTarget) {
  const target = contractTargetSchema.parse(input);
  const headers = (options: RequestOptions) => {
    if (options.ifMatch !== undefined)
      assert(
        options.ifMatch.length <= 1024 && !/[\r\n]/.test(options.ifMatch),
        "Invalid bounded review header.",
      );
    return {
      Origin: options.origin ?? target.origin,
      ...(options.cookie === false ? {} : { Cookie: options.cookie ?? target.cookie }),
      ...(options.userAgent === undefined ? {} : { "User-Agent": options.userAgent }),
      ...(options.ifMatch === undefined ? {} : { "If-Match": options.ifMatch }),
      ...(options.filename === undefined
        ? {}
        : { "X-OpenBot-Filename": encodeURIComponent(options.filename) }),
      ...(options.body === undefined &&
      options.rawBody === undefined &&
      options.bytes === undefined &&
      options.contentType === undefined
        ? {}
        : {
            "Content-Type":
              options.contentType ??
              (options.bytes ? "application/octet-stream" : "application/json"),
          }),
    };
  };
  function assertHeaders(response: Response, options: RequestOptions) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    if (options.origin === undefined) {
      assert.equal(response.headers.get("access-control-allow-origin"), target.origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    }
  }
  async function boundedBody(response: Response, maximum: number) {
    assert(response.body);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        assert(length <= maximum, "Contract response exceeds its byte bound.");
        chunks.push(item.value);
      }
      const value = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        value.set(chunk, offset);
        offset += chunk.length;
      }
      return value;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const fetchResponse = async (path: string, options: RequestOptions) => {
    const timeoutMs = options.timeoutMs ?? 10000;
    assert([10000, 35000].includes(timeoutMs), "Contract request deadline is not bounded.");
    const response = await fetch(`${target.baseUrl}${path}`, {
      method: options.method ?? "GET",
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: headers(options),
      ...(options.bytes
        ? { body: options.bytes }
        : options.rawBody !== undefined
          ? { body: options.rawBody }
          : options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
    });
    assertHeaders(response, options);
    return response;
  };
  return {
    async request(path: string, options: RequestOptions = {}) {
      const maximum = options.maxResponseBytes ?? 4194304;
      assert([4194304, 8388608].includes(maximum), "Contract JSON response limit is not bounded.");
      const response = await fetchResponse(path, options);
      const body: unknown =
        response.status === 204
          ? null
          : JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                await boundedBody(response, maximum),
              ),
            );
      return { response, body };
    },
    async download(path: string, maximum: number, options: RequestOptions = {}) {
      const response = await fetchResponse(path, options);
      return { response, bytes: await boundedBody(response, maximum) };
    },
    async stream(path: string, options: RequestOptions = {}) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`${target.baseUrl}${path}`, {
          redirect: "error",
          signal: abort.signal,
          headers: headers(options),
        });
        assertHeaders(response, options);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream(?:;|$)/);
        assert.equal(response.headers.get("x-accel-buffering"), "no");
        assert(response.body);
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let pending = "";
        return {
          async next(): Promise<string | null> {
            while (!pending.includes("\n\n")) {
              const value = await reader?.read();
              if (!value || value.done) {
                pending += decoder.decode();
                assert.equal(pending, "", "SSE ended with an incomplete frame.");
                return null;
              }
              pending += decoder.decode(value.value, { stream: true });
              assert(
                Buffer.byteLength(pending, "utf8") <= 4 * 1024 * 1024,
                "SSE frame is unbounded.",
              );
            }
            const end = pending.indexOf("\n\n") + 2;
            const frame = pending.slice(0, end);
            pending = pending.slice(end);
            return frame;
          },
          async close() {
            clearTimeout(timer);
            abort.abort();
            await reader?.cancel().catch(() => {});
          },
        };
      } catch (error) {
        clearTimeout(timer);
        abort.abort();
        await reader?.cancel().catch(() => {});
        throw error;
      }
    },
  };
}
