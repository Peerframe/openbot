import { readFile } from "node:fs/promises";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NativeExecutionError } from "./agent-observations.js";
import {
  type AgentRuntimeInput,
  type AgentRuntimePorts,
  executeAgentRuntime,
} from "./agent-runtime.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = (text = "Delivered.") => ({
  content: [{ type: "text" as const, text }],
  usage,
  finishReason: { unified: "stop" as const, raw: "stop" },
  warnings: [],
});
const call = (toolName = "read_evidence", input = "{}") => ({
  content: [{ type: "tool-call" as const, toolCallId: "call-1", toolName, input }],
  usage,
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  warnings: [],
});

function fixture(model = new MockLanguageModelV4({ doGenerate: [call(), answer()] })) {
  const effect = vi.fn(async () => ({ evidence: "Server-bound evidence" }));
  const assertActive = vi.fn(async () => {});
  const corrections = vi.fn(async () => [{ id: "correction", instruction: "Keep source dates." }]);
  const saveUsage = vi.fn(async () => {});
  const progress = vi.fn(async (_stage: string, _message: string) => {});
  const controller = new AbortController();
  const input: AgentRuntimeInput = {
    instructions: "Complete the task with the Server-bound tool.",
    messages: [{ role: "user", content: "Summarize the supplied evidence." }],
    signal: controller.signal,
    budget: { steps: 0, tools: 0, web: 0 },
  };
  const ports: AgentRuntimePorts = {
    model: { languageModel: model, identity: { provider: "openai", model: "fixture" } },
    authority: { assertActive },
    tools: {
      definitions: { read_evidence: tool({ inputSchema: z.object({}).strict(), execute: effect }) },
      policies: { read_evidence: { web: false, maximumResultBytes: 16 * 1024 } },
      classifyError: (error) =>
        error instanceof NativeExecutionError
          ? error
          : new NativeExecutionError("tool_unavailable"),
    },
    storage: { corrections, saveUsage },
    audit: { progress },
  };
  return {
    ports,
    input,
    controller,
    model,
    effect,
    assertActive,
    corrections,
    saveUsage,
    progress,
  };
}

describe("isolated Agent execution ports", () => {
  it("runs real SDK tool feedback with only the explicit execution ports", async () => {
    const f = fixture();
    expect(await executeAgentRuntime(f.ports, f.input)).toEqual({
      text: "Delivered.",
      appliedCorrectionIds: ["correction"],
    });
    expect(f.effect).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.model.doGenerateCalls[1]?.prompt)).toContain("Server-bound evidence");
    expect(f.saveUsage).toHaveBeenLastCalledWith({
      provider: "openai",
      model: "fixture",
      inputTokens: 20,
      outputTokens: 20,
      steps: 2,
    });
    expect(f.progress).toHaveBeenCalledWith("observation", "Completed read_evidence.");
    for (const request of f.model.doGenerateCalls)
      expect(JSON.stringify(request.prompt)).toContain("Keep source dates.");
  });

  it("cannot load Server control-plane implementations through the execution module", async () => {
    // A dependency regression would make the isolated entry require private Server configuration again.
    for (const name of ["agent-runtime.ts", "agent-observations.ts", "agent-stream.ts"]) {
      const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /(?:from|import\()\s*["'](?:@openbot\/db|\.\/(?:native-agent|postgres-|model-settings|plugin-service|app\.|channel-realtime))/,
      );
    }
  });

  it.each(["missing-policy", "oversized-policy", "no-local-executor"])(
    "rejects %s before model or tool dispatch",
    async (scenario) => {
      const f = fixture();
      if (scenario === "missing-policy") f.ports.tools.policies = {};
      if (scenario === "oversized-policy")
        f.ports.tools.policies.read_evidence = { web: false, maximumResultBytes: 129 * 1024 };
      if (scenario === "no-local-executor")
        f.ports.tools.definitions.read_evidence = tool({ inputSchema: z.object({}) });
      await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
        code: "invalid_target",
      });
      expect(f.model.doGenerateCalls).toHaveLength(0);
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it("denies an unavailable authority before calling the model", async () => {
    const f = fixture();
    f.assertActive.mockRejectedValue(new NativeExecutionError("scope_revoked"));
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect(f.model.doGenerateCalls).toHaveLength(0);
  });

  it("rejects an implicit gateway model instead of reading ambient provider credentials", async () => {
    const f = fixture();
    f.ports.model.languageModel = "openai/gpt-4.1";
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("rechecks authority after awaited correction storage before a model call", async () => {
    const f = fixture();
    f.corrections.mockImplementation(async () => {
      f.assertActive.mockRejectedValue(new NativeExecutionError("scope_revoked"));
      return [];
    });
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect(f.model.doGenerateCalls).toHaveLength(0);
  });

  it.each(["before-tool", "after-tool"])("fails closed for %s revocation", async (timing) => {
    const f = fixture();
    if (timing === "before-tool")
      f.model.doGenerate = async () => {
        f.assertActive.mockRejectedValue(new NativeExecutionError("scope_revoked"));
        return call();
      };
    else
      f.effect.mockImplementation(async () => {
        f.assertActive.mockRejectedValue(new NativeExecutionError("scope_revoked"));
        return { evidence: "Revoked result" };
      });
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect(f.effect).toHaveBeenCalledTimes(timing === "before-tool" ? 0 : 1);
    expect(f.progress).not.toHaveBeenCalledWith("observation", "Completed read_evidence.");
  });

  it("commits the web start audit before effects and aborts when that audit fails", async () => {
    const f = fixture();
    f.ports.tools.policies.read_evidence = { web: true, maximumResultBytes: 16 * 1024 };
    f.progress.mockImplementation(async (_stage, message) => {
      if (message.startsWith("Started")) throw new Error("private audit fault");
    });
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "tool_unavailable",
    });
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.model.doGenerateCalls).toHaveLength(1);
  });

  it.each(["after-tool", "final-answer"])(
    "cannot return success after usage storage fails at %s",
    async (timing) => {
      const f = fixture(
        timing === "final-answer" ? new MockLanguageModelV4({ doGenerate: answer() }) : undefined,
      );
      f.saveUsage.mockRejectedValue(new Error("private database fault"));
      await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
        code: "execution_failed",
      });
      expect(f.model.doGenerateCalls).toHaveLength(1);
    },
  );

  it.each(["unknown", "invalid-input", "oversized-result"])(
    "rejects %s without another model roundtrip",
    async (scenario) => {
      const f = fixture(
        new MockLanguageModelV4({
          doGenerate: [
            call(
              scenario === "unknown" ? "unlisted" : "read_evidence",
              scenario === "invalid-input" ? '{"ungranted":true}' : "{}",
            ),
            answer(),
          ],
        }),
      );
      if (scenario === "oversized-result")
        f.effect.mockResolvedValue({ evidence: "x".repeat(17 * 1024) });
      await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
        code: "tool_unavailable",
      });
      expect(f.model.doGenerateCalls).toHaveLength(1);
      expect(f.effect).toHaveBeenCalledTimes(scenario === "oversized-result" ? 1 : 0);
    },
  );

  it("retains the step and usage budget across continuation calls", async () => {
    const f = fixture(new MockLanguageModelV4({ doGenerate: answer() }));
    f.input.budget.steps = 7;
    await executeAgentRuntime(f.ports, f.input);
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "task_limit",
    });
    expect(f.model.doGenerateCalls).toHaveLength(1);
    expect(f.input.budget.usage?.steps).toBe(1);
  });

  it("rejects a tool generator instead of reporting its unexecuted iterator as a result", async () => {
    const f = fixture();
    f.ports.tools.definitions.read_evidence = tool({
      inputSchema: z.object({}),
      async *execute() {
        await f.effect();
        yield { evidence: "preliminary" };
      },
    });
    await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
      code: "tool_unavailable",
    });
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.model.doGenerateCalls).toHaveLength(1);
    expect(f.progress).not.toHaveBeenCalledWith("observation", "Completed read_evidence.");
  });

  it.each(["tools", "web"] as const)(
    "retains the exhausted %s budget before dispatch",
    async (budget) => {
      const f = fixture();
      f.input.budget[budget] = budget === "tools" ? 16 : 4;
      f.ports.tools.policies.read_evidence = { web: true, maximumResultBytes: 16 * 1024 };
      await expect(executeAgentRuntime(f.ports, f.input)).rejects.toMatchObject({
        code: "task_limit",
      });
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it("does not deliver a provider answer received after cancellation", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof answer>>();
    const f = fixture(new MockLanguageModelV4({ doGenerate: () => pending.promise }));
    const execution = executeAgentRuntime(f.ports, f.input);
    const denial = expect(execution).rejects.toMatchObject({ code: "server_interrupted" });
    await vi.waitFor(() => expect(f.model.doGenerateCalls).toHaveLength(1));
    f.controller.abort(new NativeExecutionError("server_interrupted"));
    pending.resolve(answer("Late result"));
    await denial;
  });

  it("emits public stream deltas while keeping provider reasoning outside the output port", async () => {
    const f = fixture(
      new MockLanguageModelV4({
        doStream: {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "reasoning-start", id: "private" });
              controller.enqueue({
                type: "reasoning-delta",
                id: "private",
                delta: "PRIVATE REASONING",
              });
              controller.enqueue({ type: "reasoning-end", id: "private" });
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "First" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: " result" });
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              controller.close();
            },
          }),
        },
      }),
    );
    const output = vi.fn();
    f.ports.output = output;
    expect((await executeAgentRuntime(f.ports, f.input)).text).toBe("First result");
    expect(output.mock.calls).toContainEqual(["First", false]);
    expect(output.mock.calls).toContainEqual(["First result", false]);
    expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE REASONING");
    expect(f.saveUsage).toHaveBeenCalledOnce();
  });
});
