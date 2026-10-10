/** Invokes reviewed model SDKs with bounded requests and retained usage receipts. */
import { type WorkMediaItem, workMediaWire } from "./work-model-media.js";
import Anthropic from "@anthropic-ai/sdk";
import { WorkConflict } from "@openbot/work";
import OpenAI from "openai";
import { z } from "zod";
import type { ResolvedConnection } from "./model-connections.js";
import { directModelTransport, type ModelTransport } from "./model-network.js";
import { workCanonical, workText } from "./work-values.js";

const text = z.string().refine((v) => !v.includes("\0") && !/[\ud800-\udfff]/u.test(v));
const call = z
  .object({
    id: text.min(1).max(128),
    name: text.regex(/^[a-zA-Z0-9_]{1,64}$/),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
export const workModelObservation = z
  .object({
    version: z.literal(1),
    protocol: z.enum(["openai-chat", "anthropic-messages"]),
    content: text.refine((v) => Buffer.byteLength(v) <= 65536),
    calls: z.array(call).max(8),
    // Retain signed reasoning/tool correlation in the provider's original assistant message.
    // This is untrusted conversation data and is never interpreted as control authority.
    message: z.record(z.string(), z.json()),
    actualTokens: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();
export type WorkModelObservation = z.infer<typeof workModelObservation>;
export type WorkTurn = { response: WorkModelObservation; tools: { id: string; content: string }[] };
export type WorkTool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};
export type WorkModelInput = {
  system: string;
  prompt: string;
  turns: WorkTurn[];
  tools: boolean | WorkTool[];
};
export const reportTool: WorkTool = {
  name: "write_report",
  description:
    "Prepare a Markdown report. It is published only after independent final verification.",
  parameters: {
    type: "object" as const,
    properties: { name: { type: "string" }, markdown: { type: "string" } },
    required: ["name", "markdown"],
    additionalProperties: false,
  },
};
const maximum = 2 * 1024 * 1024;
function tokenCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 1_000_000_000
  )
    throw new WorkConflict("model_usage_invalid");
  return value;
}
export function parseWorkModel(
  protocol: ResolvedConnection["protocol"],
  value: unknown,
): WorkModelObservation {
  const object = z.record(z.string(), z.unknown()).parse(value);
  let content = "",
    calls: z.infer<typeof call>[] = [],
    message: Record<string, z.infer<ReturnType<typeof z.json>>>,
    actualTokens: number;
  const usage = z.record(z.string(), z.unknown()).parse(object.usage);
  if (protocol === "anthropic-messages") {
    if (
      object.role !== "assistant" ||
      object.type !== "message" ||
      !["end_turn", "stop_sequence", "tool_use"].includes(String(object.stop_reason))
    )
      throw new WorkConflict("model_response_invalid");
    const parts = z.array(z.record(z.string(), z.json())).max(32).parse(object.content);
    for (const part of parts) {
      if (part.type === "text") content += text.parse(part.text);
      else if (part.type === "tool_use")
        calls.push(call.parse({ id: part.id, name: part.name, arguments: part.input }));
      else if (!["thinking", "redacted_thinking"].includes(String(part.type)))
        throw new WorkConflict("model_response_invalid");
    }
    actualTokens =
      tokenCount(usage.input_tokens) +
      tokenCount(usage.output_tokens) +
      tokenCount(usage.cache_creation_input_tokens ?? 0) +
      tokenCount(usage.cache_read_input_tokens ?? 0);
    message = { role: "assistant", content: parts };
  } else {
    const choices = z.array(z.record(z.string(), z.unknown())).length(1).parse(object.choices);
    const choice = choices[0]!;
    message = z.record(z.string(), z.json()).parse(choice.message);
    if (
      !["stop", "tool_calls"].includes(String(choice.finish_reason)) ||
      choice.error ||
      message.role !== "assistant" ||
      message.refusal ||
      message.function_call
    )
      throw new WorkConflict("model_response_invalid");
    content = message.content === null ? "" : text.parse(message.content);
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      calls = z
        .array(
          z.object({
            id: text,
            type: z.literal("function"),
            function: z.object({ name: text, arguments: text }),
          }),
        )
        .max(8)
        .parse(message.tool_calls)
        .map((c) =>
          call.parse({
            id: c.id,
            name: c.function.name,
            arguments: JSON.parse(c.function.arguments),
          }),
        );
    }
    actualTokens = tokenCount(usage.prompt_tokens) + tokenCount(usage.completion_tokens);
    if (usage.total_tokens !== undefined && tokenCount(usage.total_tokens) !== actualTokens)
      throw new WorkConflict("model_usage_invalid");
    // Do not replay response-only fields such as audio/refusal as request configuration.
    message = Object.fromEntries(
      Object.entries(message).filter(([key]) =>
        ["role", "content", "tool_calls", "reasoning_content", "reasoning_details"].includes(key),
      ),
    );
  }
  if (new Set(calls.map((c) => c.id)).size !== calls.length || (!content && !calls.length))
    throw new WorkConflict("model_response_invalid");
  const result = workModelObservation.parse({
    version: 1,
    protocol,
    content,
    calls,
    message,
    actualTokens,
  });
  workCanonical(result, maximum);
  return result;
}
export async function invokeWorkModel(
  selected: ResolvedConnection,
  input: WorkModelInput,
  fresh: () => Promise<void>,
  signal: AbortSignal,
  transport: ModelTransport = directModelTransport,
  media: WorkMediaItem[] = [],
): Promise<WorkModelObservation> {
  const mediaWire = workMediaWire(selected, media);
  signal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const tools = input.tools === true ? [reportTool] : input.tools === false ? [] : input.tools;
  if (tools.length > 32 || new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new WorkConflict("model_tools_invalid");
  for (const key of [
    "OPENAI_CUSTOM_HEADERS",
    "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_LOG",
    "ANTHROPIC_LOG",
  ])
    if (process.env[key] !== undefined) throw new WorkConflict("model_environment_refused");
  workCanonical(input, 262144);
  if (input.turns.length > 20 || input.turns.some((t) => t.response.protocol !== selected.protocol))
    throw new WorkConflict("model_history_invalid");
  for (const turn of input.turns) {
    if (
      turn.tools.length !== turn.response.calls.length ||
      turn.tools.some((t, i) => t.id !== turn.response.calls[i]?.id)
    )
      throw new WorkConflict("model_tool_correlation_invalid");
  }
  const anthropic = selected.protocol === "anthropic-messages",
    endpoint = selected.baseUrl + (anthropic ? "/v1/messages" : "/chat/completions");
  let sent = false,
    observation: WorkModelObservation | undefined;
  const fetcher: typeof fetch = async (raw, init) => {
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    if (
      sent ||
      url !== endpoint ||
      init?.method?.toUpperCase() !== "POST" ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > mediaWire.maximum
    )
      throw new WorkConflict("model_dispatch_invalid");
    mediaWire.assert(init.body);
    signal.throwIfAborted();
    await fresh();
    signal.throwIfAborted();
    sent = true;
    const response = await transport({
      url,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(init.body)),
        ...(anthropic
          ? { "x-api-key": selected.apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: "Bearer " + selected.apiKey }),
      },
      body: init.body,
      signal,
      maximum,
    });
    const length = response.headers.get("content-length");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.bytes.length > maximum ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) ||
      !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
      (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity"
    )
      throw new WorkConflict("model_response_unavailable");
    const parsed = parseWorkModel(
      selected.protocol,
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)),
    );
    if (!tools.length && parsed.calls.length) throw new WorkConflict("review_tool_refused");
    observation = parsed;
    return new Response(new Uint8Array(response.bytes), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    if (anthropic) {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.prompt }];
      for (const turn of input.turns) {
        messages.push(turn.response.message as unknown as Anthropic.MessageParam);
        if (turn.tools.length)
          messages.push({
            role: "user",
            content: turn.tools.map((t) => ({
              type: "tool_result",
              tool_use_id: t.id,
              content: t.content,
            })),
          });
      }
      if (mediaWire.content.length)
        messages.push({
          role: "user",
          content: mediaWire.content as Anthropic.ContentBlockParam[],
        });
      const client = new Anthropic({
        apiKey: selected.apiKey,
        authToken: null,
        baseURL: selected.baseUrl,
        maxRetries: 0,
        timeout: 45000,
        fetch: fetcher,
        logLevel: "off",
        defaultHeaders: {},
        defaultQuery: {},
      });
      await client.messages.create(
        {
          model: selected.modelId,
          max_tokens: 4096,
          system: input.system,
          messages,
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters,
                })),
              }
            : {}),
        },
        { signal },
      );
    } else {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ];
      for (const turn of input.turns) {
        messages.push(
          turn.response
            .message as unknown as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam,
        );
        messages.push(
          ...turn.tools.map((t) => ({
            role: "tool" as const,
            tool_call_id: t.id,
            content: t.content,
          })),
        );
      }
      if (mediaWire.content.length)
        messages.push({
          role: "user",
          content: mediaWire.content as OpenAI.Chat.Completions.ChatCompletionContentPart[],
        });
      const completion =
        selected.presetId === "openai" ||
        (selected.presetId === "kimi" && selected.modelId === "kimi-k3");
      const client = new OpenAI({
        apiKey: selected.apiKey,
        organization: "",
        project: "",
        baseURL: selected.baseUrl,
        maxRetries: 0,
        timeout: 45000,
        fetch: fetcher,
        logLevel: "off",
        defaultHeaders: {},
        defaultQuery: {},
      });
      await client.chat.completions.create(
        {
          model: selected.modelId,
          messages,
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({ type: "function" as const, function: tool })),
                parallel_tool_calls: false,
              }
            : {}),
          ...(completion ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
          ...(selected.presetId === "openai" ? { store: false } : {}),
          ...(selected.presetId === "kimi" && completion
            ? { reasoning_effort: "low" as const }
            : {}),
          ...(selected.presetId === "openrouter"
            ? {
                provider: {
                  require_parameters: true,
                  allow_fallbacks: false,
                  data_collection: "deny",
                },
              }
            : {}),
          ...(selected.presetId === "minimax" ? { reasoning_split: true } : {}),
        },
        { signal },
      );
    }
  } catch (error) {
    // A fully parsed provider response is observed truth even if SDK-local teardown fails.
    if (!observation) throw error;
  }
  if (!sent || !observation) throw new WorkConflict("model_response_unavailable");
  return observation;
}
/** The review wire is a flat, closed object. Keep duplicate keys visible before parsing. */
export function parseWorkVerdict(raw: string): { accepted: boolean; reason: string } {
  workText(raw, 16384);
  const token = '"(?:[^"\\\\\\x00-\\x1f]|\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4})*"';
  const member = new RegExp(
    `^[ \\t\\r\\n]*(${token})[ \\t\\r\\n]*:[ \\t\\r\\n]*(${token}|true|false)[ \\t\\r\\n]*`,
  );
  let rest = raw.trim();
  if (!rest.startsWith("{") || !rest.endsWith("}")) throw new WorkConflict("result_review_invalid");
  rest = rest.slice(1, -1);
  const entries = new Map<string, unknown>();
  for (;;) {
    const matched = member.exec(rest);
    if (!matched) throw new WorkConflict("result_review_invalid");
    const key = JSON.parse(matched[1]!) as string;
    if (entries.has(key)) throw new WorkConflict("result_review_invalid");
    entries.set(key, JSON.parse(matched[2]!));
    rest = rest.slice(matched[0].length);
    if (!rest) break;
    if (!rest.startsWith(",")) throw new WorkConflict("result_review_invalid");
    rest = rest.slice(1);
  }
  if (entries.size !== 2 || typeof entries.get("accepted") !== "boolean")
    throw new WorkConflict("result_review_invalid");
  return {
    accepted: entries.get("accepted") as boolean,
    reason: workText(entries.get("reason"), 2048),
  };
}
