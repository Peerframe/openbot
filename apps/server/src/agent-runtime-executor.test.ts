import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { NativeExecutionError } from "./agent-observations.js";
import { runAgentRuntime } from "./agent-runtime-executor.js";
import type {
  AgentRuntimeExecutor,
  AgentRuntimeInput,
  AgentRuntimePorts,
} from "./agent-runtime.js";

function fixture() {
  const controller = new AbortController();
  const input: AgentRuntimeInput = {
    instructions: "Use the bound evidence.",
    messages: [{ role: "user", content: "Task" }],
    budget: { steps: 0, tools: 0, web: 0 },
    signal: controller.signal,
  };
  const ports: AgentRuntimePorts = {
    model: {
      languageModel: new MockLanguageModelV4(),
      identity: { provider: "openai", model: "test" },
    },
    authority: { assertActive: vi.fn(async () => {}) },
    storage: {
      corrections: vi.fn(async () => [{ id: "steer-1", instruction: "Use dates." }]),
      saveUsage: vi.fn(async () => {}),
    },
    tools: {
      definitions: {},
      policies: {},
      classifyError: () => new NativeExecutionError("tool_unavailable"),
    },
    audit: { progress: vi.fn(async () => {}) },
  };
  return { input, ports, controller };
}

describe("Server-selected runtime executor", () => {
  it("preserves the shared budget and accepts only observed correction IDs", async () => {
    const f = fixture();
    const execute: AgentRuntimeExecutor = async (ports, input) => {
      expect(input.budget).toBe(f.input.budget);
      expect(ports.tools).toBe(f.ports.tools);
      expect(ports.model).toBe(f.ports.model);
      const corrections = await ports.storage.corrections();
      await ports.storage.saveUsage({
        provider: "openai",
        model: "test",
        steps: 1,
        inputTokens: 2,
        outputTokens: 3,
      });
      return { text: "  Done.  ", appliedCorrectionIds: corrections.map((item) => item.id) };
    };
    expect(await runAgentRuntime(execute, f.ports, f.input)).toEqual({
      text: "Done.",
      appliedCorrectionIds: ["steer-1"],
    });
    expect(f.ports.storage.saveUsage).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { text: "", appliedCorrectionIds: [] },
    { text: "x".repeat(8001), appliedCorrectionIds: [] },
    { text: "ok", appliedCorrectionIds: ["invented"] },
    { text: "ok", appliedCorrectionIds: ["steer-1", "steer-1"] },
    { text: "ok", appliedCorrectionIds: [3] },
    { text: "ok" },
  ])("rejects malformed or unbound adapter results (%#)", async (result) => {
    const f = fixture();
    const execute = (async (ports) => {
      await ports.storage.corrections();
      return result;
    }) as AgentRuntimeExecutor;
    await expect(runAgentRuntime(execute, f.ports, f.input)).rejects.toMatchObject({
      code: "task_limit",
    });
  });

  it("does not invoke an adapter after authority is revoked", async () => {
    const f = fixture();
    vi.mocked(f.ports.authority.assertActive).mockRejectedValue(
      new NativeExecutionError("scope_revoked"),
    );
    const execute = vi.fn();
    await expect(runAgentRuntime(execute, f.ports, f.input)).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a valid-looking result when authority changes during execution", async () => {
    const f = fixture();
    await expect(
      runAgentRuntime(
        async () => {
          vi.mocked(f.ports.authority.assertActive).mockRejectedValue(
            new NativeExecutionError("settings_changed"),
          );
          return { text: "Stale result.", appliedCorrectionIds: [] };
        },
        f.ports,
        f.input,
      ),
    ).rejects.toMatchObject({ code: "settings_changed" });
  });

  it("withholds corrections revoked while their storage read was pending", async () => {
    const f = fixture();
    vi.mocked(f.ports.storage.corrections).mockImplementation(async () => {
      vi.mocked(f.ports.authority.assertActive).mockRejectedValue(
        new NativeExecutionError("scope_revoked"),
      );
      return [{ id: "steer-1", instruction: "stale" }];
    });
    const consumed = vi.fn();
    await expect(
      runAgentRuntime(
        async (ports) => {
          consumed(await ports.storage.corrections());
          return { text: "done", appliedCorrectionIds: [] };
        },
        f.ports,
        f.input,
      ),
    ).rejects.toMatchObject({ code: "scope_revoked" });
    expect(consumed).not.toHaveBeenCalled();
  });

  it("cancels an uncooperative adapter without accepting its late result", async () => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<{ text: string; appliedCorrectionIds: string[] }>();
    const done = runAgentRuntime(
      async () => {
        started.resolve();
        return late.promise;
      },
      f.ports,
      f.input,
    );
    await started.promise;
    const rejected = expect(done).rejects.toMatchObject({ code: "server_interrupted" });
    f.controller.abort(new NativeExecutionError("server_interrupted"));
    await rejected;
    late.resolve({ text: "Too late", appliedCorrectionIds: [] });
    await expect(done).rejects.toMatchObject({ code: "server_interrupted" });
  });

  it("preserves a persistence failure instead of falling back to a default executor", async () => {
    const f = fixture();
    vi.mocked(f.ports.storage.saveUsage).mockRejectedValue(new NativeExecutionError("conflict"));
    await expect(
      runAgentRuntime(
        async (ports) => {
          await ports.storage.saveUsage({ provider: "openai", model: "test", steps: 1 });
          return { text: "not durable", appliedCorrectionIds: [] };
        },
        f.ports,
        f.input,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
