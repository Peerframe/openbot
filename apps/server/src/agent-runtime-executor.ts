import { NativeExecutionError } from "./agent-observations.js";
import type {
  AgentRuntimeExecutor,
  AgentRuntimeInput,
  AgentRuntimePorts,
  AgentRuntimeResult,
} from "./agent-runtime.js";
import { abortable } from "./agent-stream.js";

/** Validate adapter output before the Server prepares artifacts or commits completion. */
export async function runAgentRuntime(
  execute: AgentRuntimeExecutor,
  ports: AgentRuntimePorts,
  input: AgentRuntimeInput,
): Promise<AgentRuntimeResult> {
  let portFailed = false;
  let portFailure: unknown;
  const durable = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      // An SDK may catch callback failures; they must still prevent final Server delivery.
      if (!portFailed) portFailure = error;
      portFailed = true;
      throw error;
    }
  };
  const check = async () => {
    input.signal.throwIfAborted();
    await ports.authority.assertActive();
    input.signal.throwIfAborted();
  };
  await check();
  const observedCorrections = new Set<string>();
  const result: unknown = await abortable(
    execute(
      {
        ...ports,
        storage: {
          saveUsage: (usage) => durable(() => ports.storage.saveUsage(usage)),
          corrections: () =>
            durable(async () => {
              const corrections = await ports.storage.corrections();
              if (
                corrections.length > 8 ||
                Buffer.byteLength(JSON.stringify(corrections)) > 40 * 1024
              )
                throw new NativeExecutionError("task_limit");
              await check();
              for (const correction of corrections) observedCorrections.add(correction.id);
              if (observedCorrections.size > 8) throw new NativeExecutionError("task_limit");
              return corrections;
            }),
        },
        audit: {
          progress: (stage, message) => durable(() => ports.audit.progress(stage, message)),
        },
      },
      input,
    ),
    input.signal,
  );
  if (portFailed) throw portFailure;
  await check();
  if (!result || typeof result !== "object") throw new NativeExecutionError("task_limit");
  const { text, appliedCorrectionIds } = result as Partial<AgentRuntimeResult>;
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 8000 ||
    !Array.isArray(appliedCorrectionIds) ||
    appliedCorrectionIds.length > 8 ||
    new Set(appliedCorrectionIds).size !== appliedCorrectionIds.length ||
    appliedCorrectionIds.some((id) => typeof id !== "string" || !observedCorrections.has(id))
  )
    throw new NativeExecutionError("task_limit");
  return { text: text.trim(), appliedCorrectionIds: [...appliedCorrectionIds] };
}
