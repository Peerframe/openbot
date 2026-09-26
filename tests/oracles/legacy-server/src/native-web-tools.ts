import { modelProviderBaseUrl } from "@openbot/domain";
import { z } from "zod";
import { NativeExecutionError } from "./agent-observations.js";
import type { AgentModelSettings } from "./model-settings.js";

export const webSearchInputSchema = z
  .object({ query: z.string().trim().min(1).max(1000) })
  .strict();
export const webFetchInputSchema = z.object({ url: z.string().url().max(2048) }).strict();

export interface NativeWebSearch {
  search(input: { query: string }, signal: AbortSignal): Promise<string>;
}

const maximumResponseBytes = 256 * 1024;
const maximumPlaintextBytes = 16 * 1024;
const maximumFormulaBytes = 128 * 1024;
const formulaResponseSchema = z.object({
  status: z.literal("succeeded"),
  context: z.object({ output: z.string().optional(), encrypted_output: z.string().optional() }),
});
const tavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().url().max(2048),
        title: z.string(),
        content: z.string().min(1),
        published_date: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Search endpoints and credentials are selected by the Server, never by tool arguments. */
export function createNativeWebSearch(
  config: AgentModelSettings,
  options: { tavilyApiKey?: string | undefined; fetcher?: typeof fetch | undefined } = {},
): NativeWebSearch | undefined {
  const fetcher = options.fetcher ?? fetch;
  if (options.tavilyApiKey !== undefined) {
    const key = z.string().trim().min(1).max(2048).parse(options.tavilyApiKey);
    return {
      async search(input, signal) {
        const checked = webSearchInputSchema.parse(input);
        const body = await searchJson(
          "https://api.tavily.com/search",
          key,
          {
            query: checked.query,
            max_results: 5,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
          },
          signal,
          fetcher,
        );
        const parsed = tavilyResponseSchema.safeParse(body);
        if (!parsed.success) throw new NativeExecutionError("tool_unavailable");
        const results = parsed.data.results.slice(0, 5).map((result) => ({
          url: result.url,
          title: boundedText(result.title, 256),
          content: boundedText(result.content, 2000),
          ...(result.published_date
            ? { publishedAt: boundedText(result.published_date, 100) }
            : {}),
          truncated:
            Buffer.byteLength(result.content) > 2000 || Buffer.byteLength(result.title) > 256,
        }));
        const evidence = {
          provider: "tavily",
          retrievedAt: new Date().toISOString(),
          truncated: parsed.data.results.length > results.length,
          results,
        };
        let output = JSON.stringify(evidence);
        // Reduce readable excerpts only. Source identities and opaque Formula evidence stay intact.
        while (Buffer.byteLength(output) > maximumPlaintextBytes) {
          const longest = results.reduce((a, b) => (a.content.length > b.content.length ? a : b));
          if (longest.content.length < 2) throw new NativeExecutionError("task_limit");
          longest.content = boundedText(
            longest.content,
            Math.floor(Buffer.byteLength(longest.content) / 2),
          );
          longest.truncated = true;
          output = JSON.stringify(evidence);
        }
        signal.throwIfAborted();
        return output;
      },
    };
  }
  if (config.provider !== "moonshot") return undefined;
  let baseUrl: string;
  try {
    baseUrl = modelProviderBaseUrl(config.provider, config.baseUrl);
  } catch {
    return undefined;
  }
  if (!["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"].includes(baseUrl))
    return undefined;
  const endpoint = `${baseUrl}/formulas/moonshot/web-search:latest/fibers`;
  return {
    async search(input, signal) {
      const checked = webSearchInputSchema.parse(input);
      const body = await searchJson(
        endpoint,
        config.apiKey,
        {
          name: "web_search",
          arguments: JSON.stringify(checked),
        },
        signal,
        fetcher,
      );
      const parsed = formulaResponseSchema.safeParse(body);
      if (!parsed.success) throw new NativeExecutionError("tool_unavailable");
      const output = parsed.data.context.output || parsed.data.context.encrypted_output;
      if (!output?.trim()) throw new NativeExecutionError("tool_unavailable");
      if (output.length > 100000 || Buffer.byteLength(JSON.stringify(output)) > maximumFormulaBytes)
        throw new NativeExecutionError("task_limit");
      signal.throwIfAborted();
      return output;
    },
  };
}

function boundedText(value: string, byteLimit: number): string {
  let bytes = 0;
  let output = "";
  for (const point of value) {
    bytes += Buffer.byteLength(point);
    if (bytes > byteLimit) break;
    output += point;
  }
  return output;
}

async function searchJson(
  endpoint: string,
  apiKey: string,
  body: unknown,
  parent: AbortSignal,
  fetcher: typeof fetch,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = AbortSignal.any([parent, timeout]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => undefined);
  };
  try {
    signal.throwIfAborted();
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    signal.throwIfAborted();
    reader = response.body?.getReader();
    if (
      !reader ||
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      throw new NativeExecutionError("tool_unavailable");
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumResponseBytes) throw new NativeExecutionError("task_limit");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (parent.aborted) throw parent.reason;
    if (timeout.aborted) throw new NativeExecutionError("task_timeout");
    throw error instanceof NativeExecutionError
      ? error
      : new NativeExecutionError("tool_unavailable");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}
