// Piped into the built container; uses only the installed production modules.
// Synthetic Server ports exercise the real SDK/child boundary without credentials or effects.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { NativeExecutionError } from "../apps/server/dist/agent-observations.js";
import { bootstrapAgentRuntime } from "../apps/server/dist/agent-runtime-bootstrap.js";

const execute = await bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" });
assert.equal(typeof execute, "function");
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const controller = new AbortController();
const input = {
  instructions: "Use read_evidence once, then return its verified text.",
  messages: [{ role: "user", content: "Verify the packaged runtime." }],
  signal: controller.signal,
  budget: { steps: 0, tools: 0, web: 0 },
};
let modelCalls = 0;
let toolCalls = 0;
let savedUsage = 0;
const ports = {
  model: {
    identity: { provider: "openai", model: "container-fixture" },
    languageModel: {
      specificationVersion: "v4",
      provider: "container-fixture",
      modelId: "container-fixture",
      supportedUrls: {},
      async doGenerate({ prompt }) {
        modelCalls++;
        if (modelCalls === 2) assert.match(JSON.stringify(prompt), /交付证据/u);
        return {
          content:
            modelCalls === 1
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "c1",
                    toolName: "read_evidence",
                    input: '{"name":"报告"}',
                  },
                ]
              : [{ type: "text", text: "交付证据" }],
          usage,
          finishReason: { unified: modelCalls === 1 ? "tool-calls" : "stop", raw: "fixture" },
          warnings: [],
        };
      },
    },
  },
  authority: { async assertActive() {} },
  tools: {
    definitions: {
      read_evidence: tool({
        description: "Read synthetic container evidence",
        inputSchema: z.object({ name: z.string().regex(/^[\p{L}]+$/u) }).strict(),
        async execute({ name }) {
          assert.equal(name, "报告");
          toolCalls++;
          return { text: "交付证据" };
        },
      }),
    },
    policies: { read_evidence: { web: false, maximumResultBytes: 16_384 } },
    classifyError: () => new NativeExecutionError("tool_unavailable"),
  },
  storage: {
    async corrections() {
      return [];
    },
    async saveUsage() {
      savedUsage++;
    },
  },
  audit: { async progress() {} },
};
const before = (await readdir("/tmp")).filter((name) => name.startsWith("openbot-runtime-"));
const result = await execute(ports, input);
assert.equal(result.text, "交付证据");
assert.equal(modelCalls, 2);
assert.equal(toolCalls, 1);
assert.equal(savedUsage, 2);
assert.equal(input.budget.steps, 2);
assert.equal(input.budget.tools, 1);

let entered;
const waiting = new Promise((resolve) => {
  entered = resolve;
});
const cancelling = new AbortController();
const cancellation = execute(
  {
    ...ports,
    model: {
      ...ports.model,
      languageModel: {
        ...ports.model.languageModel,
        async doGenerate() {
          entered();
          return new Promise(() => {});
        },
      },
    },
  },
  { ...input, signal: cancelling.signal, budget: { steps: 0, tools: 0, web: 0 } },
);
const rejected = assert.rejects(cancellation, { code: "server_interrupted" });
const deadline = setTimeout(() => cancelling.abort(new NativeExecutionError("task_limit")), 15_000);
try {
  await Promise.race([waiting, rejected]);
  cancelling.abort(new NativeExecutionError("server_interrupted"));
  await rejected;
} finally {
  clearTimeout(deadline);
}
assert.equal(toolCalls, 1);
assert.equal(savedUsage, 2);
assert.deepEqual(
  (await readdir("/tmp")).filter((name) => name.startsWith("openbot-runtime-")),
  before,
);
console.log("Packaged Python preflight, Unicode tool feedback, usage and cancellation passed.");
