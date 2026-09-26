import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { NativeExecutionError } from "./agent-observations.js";

export const RUNTIME_PROTOCOL = "openbot-agent-runtime/1";
export const RUNTIME_CONTROL_PROMPT = "Continue the Server-bound task.";
export const RUNTIME_FRAME_BYTES = 524_288;
export const RUNTIME_TOTAL_BYTES = 8 * 1024 * 1024;
export const RUNTIME_MAX_FRAMES = 1024;

const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const argumentsSchema = z.record(z.string(), z.json());
export const runtimeIntentSchema = z.strictObject({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(64),
  arguments: argumentsSchema,
});
const wireMessageSchema = z.union([
  z.strictObject({ role: z.literal("user"), content: z.string() }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z
      .array(
        z.union([
          textPart,
          z.strictObject({
            type: z.literal("tool-call"),
            toolCallId: z.string().min(1).max(256),
            toolName: z.string().min(1).max(64),
            input: argumentsSchema,
          }),
        ]),
      )
      .min(1),
  }),
  z.strictObject({
    role: z.literal("tool"),
    content: z
      .array(
        z.strictObject({
          type: z.literal("tool-result"),
          toolCallId: z.string().min(1).max(256),
          toolName: z.string().min(1).max(64),
          output: z.strictObject({ type: z.literal("json"), value: z.json() }),
        }),
      )
      .min(1),
  }),
]);
const workerRequestBase = { jsonrpc: z.literal("2.0"), id: z.string().regex(/^w[1-9][0-9]{0,2}$/) };
export const runtimeWorkerMessageSchema = z.union([
  z.strictObject({
    ...workerRequestBase,
    method: z.literal("authority.check"),
    params: z.strictObject({}),
  }),
  z.strictObject({
    ...workerRequestBase,
    method: z.literal("model.generate"),
    params: z.strictObject({ messages: z.array(wireMessageSchema).min(1).max(128) }),
  }),
  z.strictObject({
    ...workerRequestBase,
    method: z.literal("tool.execute"),
    params: runtimeIntentSchema,
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: z.literal("run"),
    result: z.strictObject({ text: z.string().min(1).max(8000) }),
  }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: z.literal("run"),
    error: z.strictObject({
      code: z.literal(-32000),
      message: z.literal("Runtime operation refused"),
      data: z.strictObject({ reason: z.string().regex(/^[a-z0-9_]{1,64}$/) }),
    }),
  }),
]);
export type RuntimeWorkerMessage = z.infer<typeof runtimeWorkerMessageSchema>;
export type RuntimeWorkerRequest = Extract<RuntimeWorkerMessage, { method: string }>;

export function runtimeProtocolFailure(): NativeExecutionError {
  return new NativeExecutionError("tool_unavailable");
}

/** Bound depth before recursive schema validation; parsed worker data cannot supply authority. */
export function assertRuntimeJson(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop();
    if (!item || item.depth > 64) throw runtimeProtocolFailure();
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean")
      continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (typeof item.value !== "object") throw runtimeProtocolFailure();
    for (const child of Object.values(item.value))
      pending.push({ value: child, depth: item.depth + 1 });
  }
}

/** Reuse the released MCP codec with tighter profile bounds and fatal UTF-8 validation. */
export class RuntimeFrameReader {
  readonly #reader = new ReadBuffer({ maxBufferSize: RUNTIME_FRAME_BYTES + 1 });
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
  #bytes = 0;
  #frames = 0;
  #partial = 0;

  push(chunk: Buffer): JSONRPCMessage[] {
    this.#bytes += chunk.length;
    if (this.#bytes > RUNTIME_TOTAL_BYTES) throw runtimeProtocolFailure();
    const messages: JSONRPCMessage[] = [];
    for (let offset = 0; offset < chunk.length; ) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      this.#partial += part.length - (newline < 0 ? 0 : 1);
      if (this.#partial > RUNTIME_FRAME_BYTES) throw runtimeProtocolFailure();
      this.#utf8.decode(part, { stream: true });
      this.#reader.append(part);
      if (newline >= 0) {
        if (++this.#frames > RUNTIME_MAX_FRAMES) throw runtimeProtocolFailure();
        const message = this.#reader.readMessage();
        if (!message) throw runtimeProtocolFailure();
        assertRuntimeJson(message);
        messages.push(message);
        this.#partial = 0;
      }
      offset = end;
    }
    return messages;
  }

  finish(): void {
    this.#utf8.decode();
    if (this.#partial) throw runtimeProtocolFailure();
  }
}

export class RuntimeFrameWriter {
  #bytes = 0;
  #frames = 0;

  encode(message: JSONRPCMessage): string {
    assertRuntimeJson(message);
    const frame = serializeMessage(message);
    const bytes = Buffer.byteLength(frame);
    this.#bytes += bytes;
    if (
      bytes - 1 > RUNTIME_FRAME_BYTES ||
      this.#bytes > RUNTIME_TOTAL_BYTES ||
      ++this.#frames > RUNTIME_MAX_FRAMES
    )
      throw runtimeProtocolFailure();
    return frame;
  }
}

export function restoreRuntimeMessages(raw: unknown, originals: ModelMessage[]): ModelMessage[] {
  assertRuntimeJson(raw);
  const messages = z.array(wireMessageSchema).min(1).max(128).parse(raw);
  if (Buffer.byteLength(JSON.stringify(messages)) > 256 * 1024) throw runtimeProtocolFailure();
  const first = messages[0];
  if (
    first?.role !== "user" ||
    first.content !== RUNTIME_CONTROL_PROMPT ||
    messages.slice(1).some((item) => item.role === "user")
  )
    throw runtimeProtocolFailure();
  // Original attachments and instructions never become worker-selected media URLs or provider options.
  return [...originals, ...messages.slice(1)];
}
