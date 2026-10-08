import { timingSafeEqual } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import Anthropic from "@anthropic-ai/sdk";
import {
  modelIdSchema,
  testModelConnectionInputSchema,
  verifyModelConnectionInputSchema,
} from "@openbot/protocol";
import OpenAI from "openai";
import { type ModelConnections, modelInput, type ResolvedConnection } from "./model-connections.js";
import { scalarText } from "./owner-auth-crypto.js";
import { refuse } from "./owner-transaction.js";
import type { AuthorizedProductOperation, ProductRoute } from "./product-identity.js";

type ProviderRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maximum: number;
};
export type ModelTransport = (
  request: ProviderRequest,
) => Promise<{ status: number; headers: Headers; bytes: Buffer }>;
const unavailable = (): never => refuse(422, "model_provider_unavailable");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
};
function boundedHeaders(status: number, headers: Headers, maximum: number, discovery: boolean) {
  if (discovery && [401, 403].includes(status)) refuse(422, "model_credentials_invalid");
  if (
    status < 200 ||
    status >= 300 ||
    !headers.get("content-type")?.toLowerCase().includes("application/json") ||
    (headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity"
  )
    unavailable();
  const length = headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) unavailable();
}
export type ByteProviderTransport = (
  input: Omit<ProviderRequest, "body"> & { body?: string | Buffer; responseKind?: "transcription" },
) => ReturnType<ModelTransport>;
export const directByteProviderTransport: ByteProviderTransport = async (input) => {
  // A private agent plus explicit TLS verification avoids ambient proxy agents and TLS-disable env.
  const agent = new Agent({ keepAlive: false, maxSockets: 1, rejectUnauthorized: true });
  try {
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(
        input.url,
        {
          method: input.method,
          headers: input.headers,
          agent,
          rejectUnauthorized: true,
          signal: input.signal,
        },
        (response) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(",") : value);
          try {
            if (input.responseKind === "transcription") {
              if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300)
                refuse(503, "transcription_provider_unavailable");
              const length = headers.get("content-length");
              if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > input.maximum))
                refuse(413, "transcription_response_limit");
              if ((headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity")
                refuse(503, "transcription_provider_unavailable");
            } else {
              boundedHeaders(
                response.statusCode ?? 0,
                headers,
                input.maximum,
                input.method === "GET",
              );
            }
          } catch (error) {
            response.destroy();
            reject(error);
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > input.maximum) {
              response.destroy();
              if (input.responseKind === "transcription") {
                try {
                  refuse(413, "transcription_response_limit");
                } catch (error) {
                  reject(error);
                }
              } else reject(new Error("Provider response limit."));
            } else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("Provider response aborted.")));
          response.once("end", () =>
            resolve({ status: response.statusCode!, headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      request.once("error", reject);
      request.end(input.body);
    });
  } finally {
    agent.destroy();
  }
};
export const directModelTransport: ModelTransport = directByteProviderTransport;

function json(bytes: Buffer, maximum: number) {
  if (bytes.length > maximum) return unavailable();
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    return unavailable();
  }
}
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000_000)
    return unavailable();
  return value;
};
const text = (value: unknown, maximum = 524288): string => {
  if (typeof value !== "string" || !scalarText(value) || [...value].length > maximum)
    return unavailable();
  return value;
};
// This endpoint asks for one text-only probe. Tool calls have no admitted catalog or authority.
export function validateProbe(value: unknown, selected: ResolvedConnection): void {
  const plain = (value: unknown, depth = 0): void => {
    if (depth > 12 || (typeof value === "number" && !Number.isFinite(value))) unavailable();
    if (value && typeof value === "object")
      for (const child of Object.values(value)) plain(child, depth + 1);
  };
  plain(value);
  const body = object(value),
    usage = object(body.usage);
  if (body.error != null || !text(body.id, 256) || !text(body.model, 256)) unavailable();
  const usageFields = (value: Record<string, unknown>, depth = 0) => {
    if (depth > 32) unavailable();
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith("_tokens") && child != null) count(child);
      else if (child && typeof child === "object" && !Array.isArray(child))
        usageFields(object(child), depth + 1);
    }
  };
  usageFields(usage);
  if (selected.protocol === "anthropic-messages") {
    if (
      body.type !== "message" ||
      body.role !== "assistant" ||
      !["end_turn", "stop_sequence"].includes(String(body.stop_reason)) ||
      body.container ||
      body.stop_details ||
      usage.iterations ||
      usage.server_tool_use ||
      !Array.isArray(body.content)
    )
      unavailable();
    count(usage.input_tokens);
    count(usage.output_tokens);
    let visible = false;
    for (const item of body.content as unknown[]) {
      const part = object(item);
      if (part.type === "text") visible = Boolean(text(part.text)) || visible;
      else if (part.type === "thinking") {
        text(part.thinking);
        if (!text(part.signature)) unavailable();
      } else if (part.type === "redacted_thinking") {
        if (!text(part.data)) unavailable();
      } else unavailable();
    }
    if (!visible) unavailable();
  } else {
    if (
      count(usage.prompt_tokens) + count(usage.completion_tokens) !== count(usage.total_tokens) ||
      !Array.isArray(body.choices) ||
      body.choices.length !== 1
    )
      unavailable();
    const choice = object((body.choices as unknown[])[0]),
      message = object(choice.message);
    if (
      choice.finish_reason !== "stop" ||
      choice.error ||
      message.role !== "assistant" ||
      message.refusal ||
      !text(message.content)
    )
      unavailable();
    if (
      message.tool_calls != null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)
    )
      unavailable();
    if (selected.presetId === "minimax" && /<\/?think>/i.test(String(message.content)))
      unavailable();
    for (const field of ["reasoning", "reasoning_content"])
      if (message[field] != null) text(message[field]);
    if (message.reasoning_details != null) {
      if (
        !["openrouter", "minimax"].includes(selected.presetId) ||
        !Array.isArray(message.reasoning_details)
      )
        unavailable();
      for (const value of message.reasoning_details as unknown[]) {
        const detail = object(value),
          field = (
            {
              "reasoning.text": "text",
              "reasoning.summary": "summary",
              "reasoning.encrypted": "data",
            } as Record<string, string>
          )[String(detail.type)];
        if (!field) unavailable();
        text(detail[field!]);
      }
    }
  }
}
export class ModelNetwork {
  #active = 0;
  #shutdown = new AbortController();
  constructor(
    readonly models: ModelConnections,
    readonly transport: ModelTransport = directModelTransport,
  ) {}
  close() {
    this.#shutdown.abort();
  }
  private async bounded<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) {
    if (this.#active >= 2) refuse(422, "model_connection_checks_busy");
    this.#active++;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 90000);
    timer.unref();
    try {
      return await operation(AbortSignal.any([signal, controller.signal, this.#shutdown.signal]));
    } finally {
      clearTimeout(timer);
      this.#active--;
    }
  }
  private headers(selected: ResolvedConnection) {
    return {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      ...(selected.protocol === "anthropic-messages"
        ? { "x-api-key": selected.apiKey, "anthropic-version": "2023-06-01" }
        : { Authorization: "Bearer " + selected.apiKey }),
    } as Record<string, string>;
  }
  private async live(owner: AuthorizedProductOperation, selected: ResolvedConnection) {
    const current = await owner((db) =>
      this.models.resolve(
        db,
        { connectionId: selected.connectionId, modelId: selected.modelId },
        selected.revision,
      ),
    );
    const a = Buffer.from(current?.apiKey ?? ""),
      b = Buffer.from(selected.apiKey);
    if (
      !current ||
      current.baseUrl !== selected.baseUrl ||
      current.presetId !== selected.presetId ||
      current.protocol !== selected.protocol ||
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    )
      refuse(409, "model_connection_revision_conflict");
  }
  async discover(
    owner: AuthorizedProductOperation,
    id: string | null,
    body: unknown,
    signal: AbortSignal,
  ) {
    let selected: ResolvedConnection, live: () => Promise<unknown>;
    if (id === null) {
      selected = await owner(async () => {
        const value = modelInput(verifyModelConnectionInputSchema, body);
        const baseUrl = this.models.policy.endpoint(value.presetId, value.baseUrl);
        return {
          connectionId: "unsaved",
          revision: 0,
          presetId: value.presetId,
          protocol: this.models.policy.preset(value.presetId).protocol,
          baseUrl,
          modelId: "unused",
          apiKey: value.apiKey,
          source: "saved",
        };
      });
      live = () => owner(async () => undefined);
    } else {
      selected = (await owner((db) =>
        this.models.resolve(db, { connectionId: id, modelId: "unused" }),
      ))!;
      live = () => this.live(owner, selected);
    }
    return this.bounded(signal, async (signal) => {
      if (!this.models.policy.preset(selected.presetId).discovery)
        refuse(422, "model_discovery_not_supported");
      const query =
        selected.protocol === "anthropic-messages"
          ? "?limit=256"
          : selected.presetId === "openrouter"
            ? "?output_modalities=text"
            : selected.presetId === "siliconflow"
              ? "?type=text&sub_type=chat"
              : "";
      const url =
        selected.baseUrl +
        (selected.protocol === "anthropic-messages" ? "/v1/models" : "/models") +
        query;
      try {
        signal.throwIfAborted();
        await live();
        signal.throwIfAborted();
        const response = await this.transport({
          url,
          method: "GET",
          headers: this.headers(selected),
          signal,
          maximum: 2 * 1024 * 1024,
        });
        boundedHeaders(response.status, response.headers, 2 * 1024 * 1024, true);
        const value = object(json(response.bytes, 2 * 1024 * 1024));
        if (!Array.isArray(value.data)) return unavailable();
        const ids = new Set<string>();
        for (const item of value.data) {
          if (ids.size === 256) break;
          const parsed = modelIdSchema.safeParse(item && typeof item === "object" ? item.id : null);
          if (parsed.success && !parsed.data.includes(selected.apiKey)) ids.add(parsed.data);
        }
        await live();
        signal.throwIfAborted();
        return { models: [...ids] };
      } catch (error) {
        if (error && typeof error === "object" && "status" in error) throw error;
        return unavailable();
      }
    });
  }
  async test(owner: AuthorizedProductOperation, id: string, body: unknown, signal: AbortSignal) {
    const value = modelInput(testModelConnectionInputSchema, body);
    return this.bounded(signal, async (signal) => {
      const selected = (await owner((db) =>
        this.models.resolve(db, { connectionId: id, modelId: value.modelId }),
      ))!;
      try {
        for (const name of [
          "OPENAI_CUSTOM_HEADERS",
          "ANTHROPIC_CUSTOM_HEADERS",
          "OPENAI_LOG",
          "ANTHROPIC_LOG",
        ])
          if (process.env[name] !== undefined) unavailable();
        const suffix =
          selected.protocol === "anthropic-messages" ? "/v1/messages" : "/chat/completions";
        let sent = false;
        const fetcher: typeof fetch = async (raw, init) => {
          const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url;
          if (
            sent ||
            url !== selected.baseUrl + suffix ||
            init?.method?.toUpperCase() !== "POST" ||
            typeof init.body !== "string" ||
            Buffer.byteLength(init.body) > 512 * 1024
          )
            return unavailable();
          signal.throwIfAborted();
          await this.live(owner, selected);
          signal.throwIfAborted();
          sent = true;
          const response = await this.transport({
            url,
            method: "POST",
            headers: {
              ...this.headers(selected),
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(init.body)),
            },
            body: init.body,
            signal,
            maximum: 512 * 1024,
          });
          boundedHeaders(response.status, response.headers, 512 * 1024, false);
          validateProbe(json(response.bytes, 512 * 1024), selected);
          return new Response(new Uint8Array(response.bytes), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        };
        if (selected.protocol === "anthropic-messages") {
          const client = new Anthropic({
            apiKey: selected.apiKey,
            authToken: null,
            baseURL: selected.baseUrl,
            maxRetries: 0,
            timeout: 90000,
            fetch: fetcher,
            logLevel: "off",
            defaultHeaders: {},
            defaultQuery: {},
          });
          await client.messages.create(
            {
              model: selected.modelId,
              max_tokens: 4096,
              messages: [{ role: "user", content: "Reply with OK." }],
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
            timeout: 90000,
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
              messages: [{ role: "user", content: "Reply with OK." }],
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
        if (!sent) unavailable();
        await this.live(owner, selected);
        signal.throwIfAborted();
        return { ok: true };
      } catch {
        // Preserve an authority/revision failure wrapped by an SDK without transmitting again.
        await this.live(owner, selected);
        return unavailable();
      }
    });
  }
}
export function modelNetworkRoutes(network: ModelNetwork): ProductRoute[] {
  const routes: Array<Omit<ProductRoute, "execute" | "kind" | "error">> = [
    {
      method: "POST",
      path: "/api/v1/model-connections/verify",
      maxBytes: 8192,
      remote: (owner, _ids, body, signal) => network.discover(owner, null, body, signal),
    },
    {
      method: "POST",
      path: "/api/v1/model-connections/{connection_id}/models",
      maxBytes: 1024,
      remote: (owner, ids, body, signal) => network.discover(owner, ids[0]!, body, signal),
    },
    {
      method: "POST",
      path: "/api/v1/model-connections/{connection_id}/test",
      maxBytes: 1024,
      remote: (owner, ids, body, signal) => network.test(owner, ids[0]!, body, signal),
    },
  ];
  return routes.map((route) => ({
    ...route,
    kind: "product" as const,
    error: "model_connections_storage_unavailable",
    execute: async () => unavailable(),
  }));
}
