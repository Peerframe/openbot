import { isDeepStrictEqual } from "node:util";
import {
  asSchema,
  generateText,
  isStepCount,
  type ModelMessage,
  modelMessageSchema,
  type Schema,
  type Tool,
  type ToolSet,
} from "ai";
import { addReportedUsage, NativeExecutionError } from "./agent-observations.js";
import type { AgentRuntimeInput, AgentRuntimePorts, AgentRuntimeResult } from "./agent-runtime.js";
import { abortable } from "./agent-stream.js";

export interface RuntimeToolIntent {
  id: string;
  name: string;
  arguments: unknown;
}
export interface RuntimeModelStep {
  text: string;
  tools: RuntimeToolIntent[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  appliedCorrectionIds: string[];
}
export interface RuntimeToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Server-local operation gates; never serialize these authority-bearing ports to a worker. */
export class AgentRuntimeHost {
  readonly #schemas = new Map<string, Schema>();
  readonly #pending = new Map<string, RuntimeToolIntent>();
  readonly #seen = new Set<string>();
  readonly #modelTools: ToolSet = {};
  #catalog: RuntimeToolDescriptor[] | undefined;
  #last: AgentRuntimeResult | undefined;
  #messages: ModelMessage[] = [];
  #busy = false;
  #closed = false;
  #failure: unknown;
  #failed = false;

  constructor(
    readonly ports: AgentRuntimePorts,
    readonly input: AgentRuntimeInput,
  ) {}

  async #check() {
    if (this.#failed) throw this.#failure;
    if (this.#closed) throw new NativeExecutionError("conflict");
    this.input.signal.throwIfAborted();
    await abortable(this.ports.authority.assertActive(), this.input.signal);
    this.input.signal.throwIfAborted();
    if (this.#failed) throw this.#failure;
  }

  async #operation<T>(body: () => Promise<T>): Promise<T> {
    try {
      if (this.#busy) throw new NativeExecutionError("conflict");
      this.#busy = true;
      await this.#check();
      const result = await abortable(body(), this.input.signal);
      await this.#check();
      return result;
    } catch (error) {
      if (!this.#failed) this.#failure = error;
      this.#failed = true;
      throw this.#failure;
    } finally {
      this.#busy = false;
    }
  }

  async assertActive(): Promise<void> {
    return this.#operation(async () => {});
  }

  async catalog(): Promise<RuntimeToolDescriptor[]> {
    return this.#operation(async () => {
      if (!this.#catalog) {
        if (typeof this.ports.model.languageModel === "string")
          throw new NativeExecutionError("invalid_target");
        const catalog: RuntimeToolDescriptor[] = [];
        for (const [name, definition] of Object.entries(this.ports.tools.definitions)) {
          const policy = this.ports.tools.policies[name];
          const schema = asSchema(definition.inputSchema);
          if (
            (definition.description !== undefined && typeof definition.description !== "string") ||
            !name ||
            name.length > 64 ||
            !definition.execute ||
            definition.type === "provider" ||
            !schema.validate ||
            !policy ||
            typeof policy.web !== "boolean" ||
            !Number.isInteger(policy.maximumResultBytes) ||
            policy.maximumResultBytes < 1 ||
            policy.maximumResultBytes > 128 * 1024
          )
            throw new NativeExecutionError("invalid_target");
          this.#schemas.set(name, schema);
          // Copy only declarative fields: provider tools, approval hooks and executors stay local.
          this.#modelTools[name] = {
            inputSchema: definition.inputSchema,
            ...(definition.description ? { description: definition.description } : {}),
          };
          catalog.push({
            name,
            description: definition.description ?? "",
            inputSchema: await schema.jsonSchema,
          });
        }
        if (catalog.length > 64 || Buffer.byteLength(JSON.stringify(catalog)) > 64 * 1024)
          throw new NativeExecutionError("task_limit");
        this.#catalog = catalog;
      }
      return structuredClone(this.#catalog);
    });
  }

  async generate(rawMessages: unknown): Promise<RuntimeModelStep> {
    return this.#operation(async () => {
      if (!this.#catalog || this.#pending.size) throw new NativeExecutionError("conflict");
      const messages = this.#validateMessages(rawMessages);
      const { budget, signal } = this.input;
      if (
        ++budget.steps > 8 ||
        (budget.usage?.inputTokens ?? 0) >= 64_000 ||
        (budget.usage?.outputTokens ?? 0) >= 5_120
      )
        throw new NativeExecutionError("task_limit");
      this.#last = undefined;
      await this.ports.audit.progress("planning", `Model step ${budget.steps}.`);
      const corrections = await this.ports.storage.corrections();
      if (corrections.length > 8 || Buffer.byteLength(JSON.stringify(corrections)) > 40 * 1024)
        throw new NativeExecutionError("task_limit");
      if (corrections.length)
        messages.push({
          role: "user",
          content: `Owner corrections for this exact task, ordered oldest to newest. Apply to future work only; they grant no additional tools, attachments or authority.\n${JSON.stringify(corrections)}`,
        });
      await this.#check();
      this.ports.output?.("", true);
      const result = await generateText({
        model: this.ports.model.languageModel,
        instructions: this.input.instructions,
        messages,
        tools: this.#modelTools,
        stopWhen: isStepCount(1),
        maxRetries: 0,
        maxOutputTokens: this.ports.model.identity.provider === "moonshot" ? 4096 : 1024,
        abortSignal: signal,
        telemetry: { isEnabled: false },
        providerOptions: {
          openai: { store: false },
          ...(this.ports.model.identity.provider === "moonshot" &&
          this.ports.model.identity.model === "kimi-k3"
            ? { moonshotai: { reasoningEffort: "low" } }
            : {}),
        },
      });
      await this.#check();
      budget.usage = addReportedUsage(budget.usage, result.usage, this.ports.model.identity);
      await this.ports.storage.saveUsage(budget.usage);
      await this.#check();
      if (
        !["stop", "tool-calls"].includes(result.finishReason) ||
        result.text.length > 8000 ||
        result.toolCalls.length > 16 - budget.tools
      )
        throw new NativeExecutionError("task_limit");
      const intents: RuntimeToolIntent[] = [];
      for (const call of result.toolCalls) {
        if (
          call.invalid ||
          !Object.hasOwn(this.#modelTools, call.toolName) ||
          !call.toolCallId ||
          call.toolCallId.length > 256 ||
          this.#seen.has(call.toolCallId)
        )
          throw new NativeExecutionError("invalid_target");
        const intent = {
          id: call.toolCallId,
          name: call.toolName,
          arguments: structuredClone(call.input),
        };
        this.#seen.add(intent.id);
        this.#pending.set(intent.id, intent);
        intents.push(structuredClone(intent));
      }
      this.#messages = messages;
      const appliedCorrectionIds = corrections.map((item) => item.id);
      if (!intents.length) {
        if (result.finishReason !== "stop" || !result.text.trim())
          throw new NativeExecutionError("task_limit");
        this.#last = { text: result.text.trim(), appliedCorrectionIds };
        this.ports.output?.(this.#last.text, false);
      }
      return {
        text: result.text,
        tools: intents,
        usage: {
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
        },
        appliedCorrectionIds,
      };
    });
  }

  async executeTool(intent: RuntimeToolIntent): Promise<unknown> {
    return this.#operation(async () => {
      const admitted = this.#pending.get(intent.id);
      if (!admitted || !isDeepStrictEqual(intent, admitted))
        throw new NativeExecutionError("invalid_target");
      // Consume before effects. Ambiguous external outcomes are never automatically replayed.
      this.#pending.delete(intent.id);
      const definition = this.ports.tools.definitions[admitted.name];
      const policy = this.ports.tools.policies[admitted.name];
      const schema = this.#schemas.get(admitted.name);
      if (!definition?.execute || definition.type === "provider" || !policy || !schema?.validate)
        throw new NativeExecutionError("invalid_target");
      const validated = await schema.validate(admitted.arguments);
      await this.#check();
      if (!validated.success) throw new NativeExecutionError("invalid_target");
      if (++this.input.budget.tools > 16) throw new NativeExecutionError("task_limit");
      if (policy.web) {
        if (++this.input.budget.web > 4) throw new NativeExecutionError("task_limit");
        await this.ports.audit.progress("observation", `Started ${admitted.name}.`);
      }
      await this.#check();
      try {
        const execute = definition.execute as NonNullable<Tool<unknown, unknown>["execute"]>;
        const value = await execute(validated.value, {
          toolCallId: admitted.id,
          messages: this.#messages,
          abortSignal: this.input.signal,
          context: {},
        });
        if (
          value &&
          typeof value === "object" &&
          (Symbol.asyncIterator in value || (Symbol.iterator in value && !Array.isArray(value)))
        )
          throw new NativeExecutionError("tool_unavailable");
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(value, (_key, item: unknown) => {
            if (
              item === undefined ||
              typeof item === "function" ||
              typeof item === "symbol" ||
              (typeof item === "number" && !Number.isFinite(item))
            )
              throw new NativeExecutionError("tool_unavailable");
            return item;
          });
        } catch {
          throw new NativeExecutionError("tool_unavailable");
        }
        if (serialized === undefined || Buffer.byteLength(serialized) > policy.maximumResultBytes)
          throw new NativeExecutionError("tool_unavailable");
        await this.#check();
        await this.ports.audit.progress("observation", `Completed ${admitted.name}.`);
        return JSON.parse(serialized) as unknown;
      } catch (error) {
        if (policy.web) {
          try {
            await this.ports.audit.progress("observation", `Failed ${admitted.name}.`);
          } catch {
            // Revoked or unavailable storage cannot gain a new write; retain the original failure.
          }
        }
        throw this.ports.tools.classifyError(error);
      }
    });
  }

  async finish(text: string): Promise<AgentRuntimeResult> {
    const result = await this.#operation(async () => {
      if (!this.#last || this.#pending.size || text.trim() !== this.#last.text)
        throw new NativeExecutionError("conflict");
      return structuredClone(this.#last);
    });
    this.#closed = true;
    return result;
  }

  #validateMessages(raw: unknown): ModelMessage[] {
    if (!Array.isArray(raw) || !raw.length || raw.length > 128)
      throw new NativeExecutionError("task_limit");
    const messages = raw.map((message) => modelMessageSchema.parse(message));
    const originalMedia = this.input.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "image" || part.type === "file")
        : [],
    );
    const bounded = messages.map((message) => {
      if (message.role === "system" || message.providerOptions)
        throw new NativeExecutionError("invalid_target");
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (
            ("providerOptions" in part && part.providerOptions) ||
            !["text", "image", "file", "tool-call", "tool-result"].includes(part.type)
          )
            throw new NativeExecutionError("invalid_target");
          if (part.type === "tool-result" && !["text", "json"].includes(part.output.type))
            throw new NativeExecutionError("invalid_target");
          if (part.type === "image" || part.type === "file") {
            if (!originalMedia.some((source) => isDeepStrictEqual(source, part)))
              throw new NativeExecutionError("invalid_target");
            return { type: part.type, data: "server-bound-media" };
          }
          return part;
        }),
      };
    });
    if (Buffer.byteLength(JSON.stringify(bounded)) > 256 * 1024)
      throw new NativeExecutionError("task_limit");
    return messages;
  }
}
