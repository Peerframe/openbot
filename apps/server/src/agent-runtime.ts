import type { RunModelUsage } from "@openbot/domain";
import {
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { addReportedUsage, NativeExecutionError } from "./agent-observations.js";
import { abortable } from "./agent-stream.js";

export interface AgentRuntimeBudget {
  steps: number;
  tools: number;
  web: number;
  usage?: RunModelUsage;
}

export interface AgentRuntimeCorrection {
  id: string;
  instruction: string;
}

export interface AgentRuntimeStoragePort {
  /** The Server returns only corrections authorized for this exact claimed Run. */
  corrections(): Promise<AgentRuntimeCorrection[]>;
  /** Commit usage before allowing another model call or returning a final result. */
  saveUsage(usage: RunModelUsage): Promise<void>;
}

export interface AgentRuntimeToolPolicy {
  /** Public retrieval consumes the shared web budget and requires a durable start audit. */
  web: boolean;
  maximumResultBytes: number;
}

export interface AgentRuntimePorts {
  model: {
    /** A resolved Server adapter; SDK gateway model IDs are rejected. */
    languageModel: LanguageModel;
    identity: Pick<RunModelUsage, "provider" | "model">;
  };
  /** Mandatory Server guard: settings, claimed Run scope, consumed skills and memory revisions. */
  authority: { assertActive(): Promise<void> };
  tools: {
    /** Local SDK tools bound to Server targets/policy; each returns one completed JSON value. */
    definitions: ToolSet;
    policies: Record<string, AgentRuntimeToolPolicy>;
    classifyError(error: unknown): NativeExecutionError;
  };
  storage: AgentRuntimeStoragePort;
  /** Resolve only after the bounded action/result record has committed. */
  audit: { progress(stage: "planning" | "observation", message: string): Promise<void> };
  /** Public text only; this observer neither owns the task nor commits its final result. */
  output?(text: string, reset: boolean): void;
}

export interface AgentRuntimeInput {
  instructions: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  /** One Server-owned budget must be reused across every continuation of the same Run. */
  budget: AgentRuntimeBudget;
}

/** SDK execution only: no scheduler, credentials, grant decisions or terminal-state writes. */
export async function executeAgentRuntime(ports: AgentRuntimePorts, input: AgentRuntimeInput) {
  const { signal, budget } = input;
  let toolFailed = false;
  let stepFailure: NativeExecutionError | undefined;
  let observedUsage = budget.usage;
  let corrections: AgentRuntimeCorrection[] = [];
  const check = async () => {
    signal.throwIfAborted();
    await ports.authority.assertActive();
    signal.throwIfAborted();
  };
  await check();
  // A string activates the SDK gateway and its ambient credentials instead of the Server adapter.
  if (typeof ports.model.languageModel === "string")
    throw new NativeExecutionError("invalid_target");
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(ports.tools.definitions)) {
    const policy = ports.tools.policies[name];
    const execute = definition.execute;
    if (
      !execute ||
      definition.type === "provider" ||
      !policy ||
      typeof policy.web !== "boolean" ||
      !Number.isInteger(policy.maximumResultBytes) ||
      policy.maximumResultBytes < 1 ||
      policy.maximumResultBytes > 128 * 1024
    )
      throw new NativeExecutionError("invalid_target");
    tools[name] = {
      ...definition,
      execute: async (args, context) => {
        let started = false;
        try {
          await check();
          if (++budget.tools > 16) throw new NativeExecutionError("task_limit");
          if (policy.web) {
            if (++budget.web > 4) throw new NativeExecutionError("task_limit");
            await ports.audit.progress("observation", `Started ${name}.`);
            await check();
            started = true;
          }
          const result = await execute(args, context);
          // ToolSet also permits generators; preliminary outputs cannot bypass one-result bounds.
          if (result && typeof result[Symbol.asyncIterator] === "function")
            throw new NativeExecutionError("tool_unavailable");
          // Evidence can be opaque ciphertext. Reject oversize; never truncate it.
          if (Buffer.byteLength(JSON.stringify(result)) > policy.maximumResultBytes)
            throw new NativeExecutionError("tool_unavailable");
          await check();
          await ports.audit.progress("observation", `Completed ${name}.`);
          return result;
        } catch (error) {
          if (started) {
            try {
              await ports.audit.progress("observation", `Failed ${name}.`);
            } catch {
              // A revoked Run cannot gain an audit write; preserve the original denial.
            }
          }
          toolFailed = true;
          stepFailure = ports.tools.classifyError(error);
          throw stepFailure;
        }
      },
    };
  }
  const allowedToolNames = new Set(Object.keys(tools));
  const agent = new ToolLoopAgent({
    model: ports.model.languageModel,
    // The pinned SDK's prepared-call override suppresses raw streaming provider errors.
    prepareCall: (settings) => ({ ...settings, onError: () => undefined }),
    instructions: input.instructions,
    tools,
    stopWhen: isStepCount(8),
    maxOutputTokens: ports.model.identity.provider === "moonshot" ? 4096 : 1024,
    maxRetries: 0,
    telemetry: { isEnabled: false },
    providerOptions: {
      openai: { store: false },
      ...(ports.model.identity.provider === "moonshot" && ports.model.identity.model === "kimi-k3"
        ? { moonshotai: { reasoningEffort: "low" } }
        : {}),
    },
    prepareStep: async ({ stepNumber, messages }) => {
      if (++budget.steps > 8) throw new NativeExecutionError("task_limit");
      if (stepFailure) throw stepFailure;
      if (toolFailed) throw new NativeExecutionError("tool_unavailable");
      if (
        (observedUsage?.inputTokens ?? 0) >= 64_000 ||
        (observedUsage?.outputTokens ?? 0) >= 5_120
      )
        throw new NativeExecutionError("task_limit");
      await check();
      await ports.audit.progress("planning", `Model step ${stepNumber + 1}.`);
      corrections = await ports.storage.corrections();
      if (corrections.length > 8 || Buffer.byteLength(JSON.stringify(corrections)) > 40 * 1024)
        throw new NativeExecutionError("task_limit");
      // Storage/audit awaits can outlive a revocation; recheck before yielding to the model.
      await check();
      ports.output?.("", true);
      // Reapply exact task corrections; not every SDK/provider retains prepareStep replacements.
      if (corrections.length)
        return {
          messages: [
            ...messages,
            {
              role: "user" as const,
              content: `Owner corrections for this exact task, ordered oldest to newest. Apply to future work only; they grant no additional tools, attachments or authority.\n${JSON.stringify(corrections.map(({ id, instruction }) => ({ id, instruction })))}`,
            },
          ],
        };
    },
    onStepEnd: async ({ toolCalls, toolResults, usage }) => {
      if (
        toolCalls.some((call) => !call || call.invalid || !allowedToolNames.has(call.toolName)) ||
        toolResults.some((result) => !result || "error" in result)
      ) {
        // SDK callback exceptions can be isolated; denial must survive into final validation.
        toolFailed = true;
      }
      try {
        observedUsage = addReportedUsage(observedUsage, usage, ports.model.identity);
        budget.usage = observedUsage;
        await ports.storage.saveUsage(observedUsage);
      } catch (error) {
        stepFailure =
          error instanceof NativeExecutionError
            ? error
            : new NativeExecutionError("execution_failed");
      }
    },
  });
  const callOptions = { messages: input.messages, abortSignal: signal };
  let result: { text: string; finishReason: string };
  if (ports.output) {
    const stream = await abortable(agent.stream(callOptions), signal);
    const iterator = stream.fullStream[Symbol.asyncIterator]();
    let draft = "";
    while (true) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (part.value.type === "start-step") draft = "";
      if (part.value.type === "text-delta") {
        draft += part.value.text;
        if (draft.length > 8000) throw new NativeExecutionError("task_limit");
        ports.output(draft, false);
      }
      if (part.value.type === "error" || part.value.type === "abort")
        throw stepFailure ?? new NativeExecutionError("model_unavailable");
    }
    result = {
      text: await abortable(stream.text, signal),
      finishReason: await abortable(stream.finishReason, signal),
    };
  } else result = await agent.generate(callOptions);
  await check();
  if (
    toolFailed ||
    result.finishReason !== "stop" ||
    !result.text.trim() ||
    result.text.length > 8000
  )
    throw stepFailure ?? new NativeExecutionError(toolFailed ? "tool_unavailable" : "task_limit");
  if (stepFailure) throw stepFailure;
  return { text: result.text.trim(), appliedCorrectionIds: corrections.map((item) => item.id) };
}
