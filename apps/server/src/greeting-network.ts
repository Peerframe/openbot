/** Bounds greeting model requests and rejects unsafe network destinations. */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ResolvedConnection } from "./model-connections.js";
import { directModelTransport, type ModelTransport } from "./model-network.js";
import { GreetingFailure, instructions, plainGreeting } from "./greeting-text.js";
export async function generateGreeting(
  selected: ResolvedConnection,
  payload: unknown,
  fresh: () => Promise<void>,
  signal: AbortSignal,
  transport: ModelTransport = directModelTransport,
) {
  for (const key of [
    "OPENAI_CUSTOM_HEADERS",
    "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_LOG",
    "ANTHROPIC_LOG",
  ])
    if (process.env[key] !== undefined) throw new GreetingFailure("operation_failed");
  let sent = false,
    content: string | undefined;
  const fail = (): never => {
    throw new GreetingFailure("model_refusal");
  };
  const anthropic = selected.protocol === "anthropic-messages",
    endpoint = selected.baseUrl + (anthropic ? "/v1/messages" : "/chat/completions");
  const fetcher: typeof fetch = async (raw, init) => {
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
    if (
      sent ||
      url !== endpoint ||
      init?.method?.toUpperCase() !== "POST" ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 32768
    )
      throw new GreetingFailure("operation_failed");
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
      maximum: 32768,
    });
    const length = response.headers.get("content-length");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.bytes.length > 32768 ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768)) ||
      !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
      (response.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity"
    )
      throw new GreetingFailure("operation_failed");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
    if (!value || value.error) fail();
    if (anthropic) {
      if (
        value.role !== "assistant" ||
        value.type !== "message" ||
        !["end_turn", "stop_sequence"].includes(value.stop_reason) ||
        !Array.isArray(value.content)
      )
        fail();
      content = "";
      for (const part of value.content) {
        if (part?.type === "text" && typeof part.text === "string") content += part.text;
        else if (!["thinking", "redacted_thinking"].includes(part?.type)) fail();
      }
    } else {
      if (!Array.isArray(value.choices) || value.choices.length !== 1) fail();
      const choice = value.choices[0],
        message = choice.message;
      if (
        choice.finish_reason !== "stop" ||
        choice.error ||
        message?.role !== "assistant" ||
        message.refusal ||
        typeof message.content !== "string" ||
        message.function_call ||
        (message.tool_calls != null &&
          (!Array.isArray(message.tool_calls) || message.tool_calls.length))
      )
        fail();
      content = message.content;
    }
    return new Response(new Uint8Array(response.bytes), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Explicit client configuration plus the private transport prevent ambient headers, retries,
  // provider fallback, tools and history from crossing this single optional greeting boundary.
  if (anthropic) {
    const client = new Anthropic({
      apiKey: selected.apiKey,
      authToken: null,
      baseURL: selected.baseUrl,
      maxRetries: 0,
      timeout: 15000,
      fetch: fetcher,
      logLevel: "off",
      defaultHeaders: {},
      defaultQuery: {},
    });
    await client.messages.create(
      {
        model: selected.modelId,
        max_tokens: 256,
        system: instructions,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      },
      { signal },
    );
  } else {
    const client = new OpenAI({
      apiKey: selected.apiKey,
      organization: "",
      project: "",
      baseURL: selected.baseUrl,
      maxRetries: 0,
      timeout: 15000,
      fetch: fetcher,
      logLevel: "off",
      defaultHeaders: {},
      defaultQuery: {},
    });
    const completion =
      selected.presetId === "openai" ||
      (selected.presetId === "kimi" && selected.modelId === "kimi-k3");
    await client.chat.completions.create(
      {
        model: selected.modelId,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: JSON.stringify(payload) },
        ],
        ...(completion ? { max_completion_tokens: 256 } : { max_tokens: 256 }),
        ...(selected.presetId === "openai" ? { store: false } : {}),
        ...(selected.presetId === "kimi" && completion ? { reasoning_effort: "low" as const } : {}),
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
  if (!sent) throw new GreetingFailure("operation_failed");
  return plainGreeting(content);
}
