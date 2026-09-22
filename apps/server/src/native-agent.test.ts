import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { Run } from "@openbot/domain";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { NativeExecutionError } from "./agent-observations.js";
import { PendingSteeringError } from "./agent-steering.js";
import { FileChannelAttachmentStorage } from "./channel-attachments.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import type { ModelSettingsService } from "./model-settings.js";
import {
  type AgentRunStore,
  agentFetch,
  agentModel,
  executeAgentRun,
  NativeAgentRunner,
} from "./native-agent.js";

const run: Run = {
  id: "run",
  channelId: "channel",
  botId: "bot",
  executionProfile: "none",
  instruction: "Summarize the current channel",
  title: "Summary",
  status: "running",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = (text = "Completed.") => ({
  content: [{ type: "text" as const, text }],
  usage,
  finishReason: { unified: "stop" as const, raw: "stop" },
  warnings: [],
});
const calls = (name = "read_channel_context", input = "{}", count = 1) => ({
  content: Array.from({ length: count }, (_, i) => ({
    type: "tool-call" as const,
    toolCallId: `call-${i}`,
    toolName: name,
    input,
  })),
  usage,
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  warnings: [],
});
function fixture() {
  const store: AgentRunStore = {
    queued: vi.fn(async () => []),
    claim: vi.fn(async () => run),
    assertScope: vi.fn(async () => {}),
    profile: vi.fn(async () => ({
      name: "Research Bot",
      role: "Research",
      description: "Use verified sources.",
      revision: 3,
    })),
    usage: vi.fn(async (_run, modelUsage) => ({ ...run, modelUsage })),
    context: vi.fn(async () => [{ author: "human", content: "The launch is Tuesday." }]),
    tasks: vi.fn(async () => [{ title: "Launch", status: "completed" }]),
    progress: vi.fn(async (_run, stage, message) => ({
      id: "progress",
      runId: run.id,
      channelId: run.channelId,
      stage,
      message,
      createdAt: run.createdAt,
    })),
    complete: vi.fn(),
    fail: vi.fn(async () => ({ ...run, status: "failed" })),
  };
  const publish = vi.fn(),
    checkSettings = vi.fn(async () => {});
  return {
    store,
    publish,
    checkSettings,
    run,
    modelIdentity: { provider: "openai" as const, model: "fixture" },
    signal: new AbortController().signal,
  };
}
describe("Run-scoped continuation integrity", () => {
  it.each(["memory", "skill"] as const)(
    "retains consumed %s authority after a completion correction",
    async (kind) => {
      const f = fixture();
      vi.mocked(f.store.queued).mockResolvedValueOnce([run]).mockResolvedValue([]);
      let revoked = false;
      const descriptor = {
        id: randomUUID(),
        name: "report-workflow",
        description: "Reports",
        version: "1.0.0",
        revision: 2,
        sha256: "a".repeat(64),
      };
      const assertReferences = async (_run: Run, references: unknown[]) => {
        if (revoked && references.length)
          throw new NativeExecutionError(kind === "memory" ? "memory_changed" : "skills_changed");
      };
      if (kind === "memory") {
        f.store.knowledge = async () => ({
          memories: [
            {
              id: "memory",
              revision: 2,
              title: "Prior lesson",
              content: "Reviewed evidence.",
              kind: "semantic",
              truncated: false,
            },
          ],
          truncated: false,
        });
        f.store.assertKnowledge = assertReferences;
      } else {
        f.store.skills = async () => ({ skills: [descriptor], truncated: false });
        f.store.readSkill = async () => ({ ...descriptor, markdown: "Use reviewed evidence." });
        f.store.assertSkills = assertReferences;
      }
      vi.mocked(f.store.complete)
        .mockImplementationOnce(async () => {
          revoked = true;
          throw new PendingSteeringError();
        })
        .mockResolvedValue({
          run: { ...run, status: "completed" },
          message: {
            id: "reply",
            channelId: run.channelId,
            authorType: "bot",
            authorId: run.botId,
            content: "Invalid late answer",
            createdAt: run.createdAt,
          },
        });
      const model = new MockLanguageModelV4({
        doGenerate: [
          calls(
            kind === "memory" ? "read_employee_memory" : "read_skill",
            kind === "memory" ? "{}" : JSON.stringify({ skillId: descriptor.id }),
          ),
          answer("Initial draft"),
          answer("Invalid late answer"),
        ],
      });
      const settings = {
        agentSettings: async () => ({
          provider: "openai",
          model: "fixture",
          apiKey: "fixture",
          revision: "1",
          agentEnabled: true,
          agentEnabledAt: run.createdAt,
        }),
        onChange: () => () => {},
      } as unknown as ModelSettingsService;
      const runner = new NativeAgentRunner(
        f.store,
        settings,
        new ChannelRealtimeHub(),
        vi.fn(),
        () => model,
      );
      try {
        runner.start();
        await vi.waitFor(() =>
          expect(f.store.fail).toHaveBeenCalledWith(
            run,
            kind === "memory" ? "memory_changed" : "skills_changed",
          ),
        );
        expect(f.store.complete).toHaveBeenCalledTimes(1);
        expect(model.doGenerateCalls).toHaveLength(2);
      } finally {
        await runner.stop();
      }
    },
  );
});
describe("native Agent loop", () => {
  it.each([
    ["processed.pdf", Buffer.from("%PDF-1.7\n%%EOF"), "extract"],
    ["processed.docx", Buffer.from([80, 75, 3, 4]), "extract"],
    ["processed.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "ocr"],
    ["processed.mp3", Buffer.from("ID3fixture"), "transcribe"],
  ] as const)(
    "reads a lone %s through the actual registered and audited tool",
    async (name, bytes, operation) => {
      const root = await mkdtemp(join(tmpdir(), "openbot-agent-attachment-"));
      try {
        const f = fixture();
        f.run = { ...f.run, channelId: randomUUID() };
        const storage = new FileChannelAttachmentStorage(root);
        const attachment = await storage.persist(f.run.channelId, name, bytes);
        await storage.saveDerived(f.run.channelId, attachment.id, {
          sha256: attachment.sha256,
          text: `Derived evidence for ${name}`,
          operation,
          processedAt: new Date().toISOString(),
          truncated: false,
        });
        f.run = { ...f.run, instruction: `[OpenBot attachment: ${attachment.id}]` };
        const model = new MockLanguageModelV4({
          doGenerate: [
            calls("read_attachment", JSON.stringify({ attachmentId: attachment.id })),
            answer(),
          ],
        });
        await executeAgentRun({ ...f, model, attachments: storage });
        expect(model.doGenerateCalls).toHaveLength(2);
        expect(
          model.doGenerateCalls[0]?.tools?.some((tool) => tool.name === "read_attachment"),
        ).toBe(true);
        expect(
          model.doGenerateCalls[0]?.prompt.some(
            (message) =>
              message.role === "user" && message.content.some((part) => part.type === "file"),
          ),
        ).toBe(false);
        expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
          `Derived evidence for ${name}`,
        );
        expect(f.store.progress).toHaveBeenCalledWith(
          f.run,
          "observation",
          "Completed read_attachment.",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("includes start-time history and explicit reply content before the current task", async () => {
    const f = fixture();
    f.store.initialContext = vi.fn(async () => [
      { content: "Referenced source answer", referenced: true },
    ]);
    const model = new MockLanguageModelV4({ doGenerate: answer() });
    await executeAgentRun({ ...f, model });
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("Referenced source answer");
    expect(prompt.indexOf("Referenced source answer")).toBeLessThan(
      prompt.indexOf(run.instruction),
    );
    expect(f.store.initialContext).toHaveBeenCalledWith(run);
    expect(f.store.context).not.toHaveBeenCalled();
  });
  it("rejects oversized initial context before calling a model", async () => {
    const f = fixture();
    f.store.initialContext = vi.fn(async () => "x".repeat(17000));
    const model = new MockLanguageModelV4({ doGenerate: answer() });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(0);
  });
  it("searches without supplied URLs and supersedes prior no-internet replies", async () => {
    const f = fixture();
    const evidence = "Source: https://www.nvidia.com/ ; retrieved public evidence";
    const search = vi.fn(async () => evidence);
    const model = new MockLanguageModelV4({
      doGenerate: [calls("web_search", '{"query":"NVIDIA official RTX 5090"}'), answer(evidence)],
    });
    const result = await executeAgentRun({ ...f, model, webSearch: { search } });
    expect(result.text).toBe(evidence);
    expect(search).toHaveBeenCalledOnce();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
      "Prior replies claiming no internet",
    );
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain(
      "No other network targets are authorized",
    );
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(evidence);
    const progress = f.publish.mock.calls.map(([event]) => event.message);
    expect(progress).toContain("Started web_search.");
    expect(progress).toContain("Completed web_search.");
    expect(JSON.stringify(progress)).not.toContain("NVIDIA official");
    expect(JSON.stringify(progress)).not.toContain("retrieved public evidence");
    expect(vi.mocked(f.store.progress).mock.invocationCallOrder[2]).toBeLessThan(
      search.mock.invocationCallOrder[0]!,
    );
  });
  it("reads a newly selected public source and retains its report provenance", async () => {
    const f = fixture();
    const source = {
      url: "https://www.nvidia.com/",
      text: "Official source",
      fetchedAt: run.createdAt,
      truncated: false,
    };
    const readSource = vi.fn(async () => source);
    const model = new MockLanguageModelV4({
      doGenerate: [
        calls("fetch", JSON.stringify({ url: source.url })),
        calls("write_report", JSON.stringify({ name: "research.md", markdown: "Official source" })),
        answer("Read the official source."),
      ],
    });
    const result = await executeAgentRun({ ...f, model, readSource, allowReports: true });
    expect(readSource).toHaveBeenCalledWith(source.url, f.signal);
    expect(result.reports[0]?.metadata?.sources).toEqual([
      { url: source.url, fetchedAt: source.fetchedAt, truncated: false },
    ]);
    expect(result.reports[0]?.text).toContain(source.url);
  });
  it("stops public retrieval before effects when the start audit fails", async () => {
    const f = fixture();
    const original = f.store.progress;
    f.store.progress = vi.fn(async (...args) => {
      if (args[2] === "Started web_search.") throw new Error("audit unavailable");
      return original(...args);
    });
    const search = vi.fn(async () => "evidence");
    const model = new MockLanguageModelV4({
      doGenerate: [calls("web_search", '{"query":"public"}'), answer()],
    });
    await expect(executeAgentRun({ ...f, model, webSearch: { search } })).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it.each(["fetch", "read_public_page"])(
    "shares the four-call budget between public search and %s",
    async (reader) => {
      const search = vi.fn(async () => "evidence");
      const readSource = vi.fn();
      const model = new MockLanguageModelV4({
        doGenerate: [
          calls("web_search", '{"query":"public"}', 4),
          calls(
            reader,
            reader === "fetch" ? '{"url":"https://www.nvidia.com/"}' : '{"sourceIndex":0}',
          ),
          answer(),
        ],
      });
      await expect(
        executeAgentRun({
          ...fixture(),
          run: { ...run, instruction: "Search and read https://www.nvidia.com/" },
          model,
          readSource,
          webSearch: { search },
        }),
      ).rejects.toThrow(/limits/);
      expect(search).toHaveBeenCalledTimes(4);
      expect(readSource).not.toHaveBeenCalled();
    },
  );
  it.each(["search-failed", "scope-revoked", "oversized"])(
    "fails the Run after %s instead of returning an unsupported answer",
    async (kind) => {
      const f = fixture();
      const search = vi.fn(async () => {
        if (kind === "search-failed") throw new Error("private provider payload");
        if (kind === "scope-revoked")
          vi.mocked(f.store.assertScope).mockRejectedValue(
            new NativeExecutionError("scope_revoked"),
          );
        return kind === "oversized" ? "x".repeat(128 * 1024) : "evidence";
      });
      const model = new MockLanguageModelV4({
        doGenerate: [calls("web_search", '{"query":"public"}'), answer("Guess")],
      });
      await expect(executeAgentRun({ ...f, model, webSearch: { search } })).rejects.toThrow();
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(f.publish.mock.calls.map(([event]) => event.message)).toContain("Failed web_search.");
      expect(JSON.stringify(f.publish.mock.calls)).not.toContain("private provider payload");
    },
  );
  it("does not advertise search when no retrieval service exists", async () => {
    const model = new MockLanguageModelV4({ doGenerate: answer() });
    await executeAgentRun({ ...fixture(), model });
    expect(model.doGenerateCalls[0]?.tools?.some((entry) => entry.name === "web_search")).toBe(
      false,
    );
    expect(model.doGenerateCalls[0]?.tools?.some((entry) => entry.name === "fetch")).toBe(true);
  });
  it("runs the released K3 tool adapter with reasoning continuity and records only public output", async () => {
    const f = fixture();
    const bodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key-not-real");
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "fixture",
        model: "kimi-k3",
        created: 1,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            finish_reason: bodies.length === 1 ? "tool_calls" : "stop",
            message:
              bodies.length === 1
                ? {
                    role: "assistant",
                    content: null,
                    reasoning_content: "PRIVATE_K3_REASONING",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "read_channel_context", arguments: "{}" },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: "The launch is Tuesday.",
                    reasoning_content: "PRIVATE_K3_REASONING",
                  },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    };
    const model = agentModel(
      {
        provider: "moonshot",
        model: "kimi-k3",
        apiKey: "fixture-key-not-real",
        revision: "config",
        agentEnabled: true,
        agentEnabledAt: run.createdAt,
      },
      fetcher,
    );
    const result = await executeAgentRun({
      ...f,
      model,
      modelIdentity: { provider: "moonshot", model: "kimi-k3" },
    });
    expect(result.text).toBe("The launch is Tuesday.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: "kimi-k3",
      reasoning_effort: "low",
      max_completion_tokens: 4096,
    });
    expect(JSON.stringify(bodies[1]?.messages)).toContain("PRIVATE_K3_REASONING");
    expect(JSON.stringify(bodies[1]?.messages)).toContain("The launch is Tuesday.");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_K3_REASONING");
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("PRIVATE_K3_REASONING");
    expect(f.store.usage).toHaveBeenLastCalledWith(
      run,
      expect.objectContaining({ provider: "moonshot", model: "kimi-k3", steps: 2 }),
    );
    await expect(
      agentFetch("moonshot", fetcher)("https://api.moonshot.ai/v1/chat/completions", {
        method: "POST",
      }),
    ).rejects.toThrow(/endpoint/);
    expect(bodies).toHaveLength(2);
  });

  it("runs the released OpenRouter adapter with tool feedback, bounded routing and no raw reasoning persistence", async () => {
    const f = fixture();
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      const first = requests.length === 1;
      return Response.json({
        id: `completion-${requests.length}`,
        object: "chat.completion",
        created: 1,
        model: "fixture/model",
        choices: [
          {
            index: 0,
            finish_reason: first ? "tool_calls" : "stop",
            message: first
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "read",
                      type: "function",
                      function: { name: "read_channel_context", arguments: "{}" },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content: "The launch is Tuesday.",
                  reasoning: "PRIVATE_REASONING_FIXTURE",
                },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    };
    const model = agentModel(
      {
        provider: "openrouter",
        model: "fixture/model",
        apiKey: "fixture-key-not-real",
        revision: "config",
        agentEnabled: true,
        agentEnabledAt: new Date().toISOString(),
      },
      fetcher,
    );
    const result = await executeAgentRun({
      ...f,
      model,
      modelIdentity: { provider: "openrouter", model: "fixture/model" },
    });
    expect(result.text).toBe("The launch is Tuesday.");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-key-not-real");
      expect(request.body.provider).toEqual({
        require_parameters: true,
        allow_fallbacks: false,
        data_collection: "deny",
      });
      expect(request.body).not.toHaveProperty("plugins");
      expect(request.body).not.toHaveProperty("models");
    }
    expect(JSON.stringify(requests[1]?.body.messages)).toContain("The launch is Tuesday.");
    expect(f.store.usage).toHaveBeenLastCalledWith(run, {
      provider: "openrouter",
      model: "fixture/model",
      steps: 2,
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain("PRIVATE_REASONING_FIXTURE");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REASONING_FIXTURE");
    await expect(
      agentFetch("openrouter", fetcher)("https://openrouter.ai/api/v1/completions", {
        method: "POST",
      }),
    ).rejects.toThrow(/endpoint/);
    expect(requests).toHaveLength(2);
  });

  it("reads a frozen Owner-enabled snapshot and prepares one proposal without modifying active memory", async () => {
    const f = fixture();
    f.store.knowledge = vi.fn(async () => ({
      memories: [
        {
          id: "memory-1",
          revision: 2,
          kind: "procedural",
          title: "Evidence",
          content: "Separate facts from inference",
          truncated: false,
        },
      ],
      truncated: false,
    }));
    f.store.assertKnowledge = vi.fn(async () => {});
    const proposal = {
      kind: "procedural",
      title: "Cite sources",
      content: "Retain the source URL.",
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        calls("read_employee_memory"),
        calls("read_employee_memory"),
        calls("propose_memory", JSON.stringify(proposal)),
        answer(),
      ],
    });
    const result = await executeAgentRun({ ...f, model });
    expect(f.store.knowledge).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Separate facts from inference",
    );
    expect(result).toMatchObject({
      proposal,
      knowledgeReferences: [{ id: "memory-1", revision: 2 }],
    });
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.store.assertKnowledge).toHaveBeenCalledWith(run, [{ id: "memory-1", revision: 2 }]);
  });
  it("stops before another model step when retrieved knowledge is revoked", async () => {
    const f = fixture();
    f.store.knowledge = async () => ({
      memories: [
        {
          id: "m",
          revision: 1,
          kind: "semantic",
          title: "Fact",
          content: "Fact",
          truncated: false,
        },
      ],
      truncated: false,
    });
    f.store.assertKnowledge = async (_run, refs) => {
      if (refs.length) throw new Error("Revoked");
    };
    const model = new MockLanguageModelV4({
      doGenerate: [calls("read_employee_memory"), answer()],
    });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it("does not allow a model to self-approve, target another Bot or submit a second proposal", async () => {
    for (const input of [
      { kind: "semantic", title: "Fact", content: "A lesson", ownerReviewed: true },
      { kind: "semantic", title: "Fact", content: "A lesson", botId: "other" },
    ]) {
      const f = fixture();
      f.store.knowledge = async () => ({ memories: [], truncated: false });
      f.store.assertKnowledge = async () => {};
      await expect(
        executeAgentRun({
          ...f,
          model: new MockLanguageModelV4({
            doGenerate: [calls("propose_memory", JSON.stringify(input)), answer()],
          }),
        }),
      ).rejects.toThrow();
    }
    const f = fixture();
    f.store.knowledge = async () => ({ memories: [], truncated: false });
    f.store.assertKnowledge = async () => {};
    const call = calls(
      "propose_memory",
      JSON.stringify({ kind: "semantic", title: "Fact", content: "A lesson" }),
    );
    await expect(
      executeAgentRun({
        ...f,
        model: new MockLanguageModelV4({ doGenerate: [call, call, answer()] }),
      }),
    ).rejects.toThrow();
  });

  it("uses the assigned Bot profile and persists per-step provider counts", async () => {
    const f = fixture();
    const model = new MockLanguageModelV4({ doGenerate: [calls(), answer()] });
    await executeAgentRun({ ...f, model });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("Use verified sources.");
    expect(f.store.profile).toHaveBeenCalledExactlyOnceWith(run);
    expect(f.store.usage).toHaveBeenLastCalledWith(run, {
      provider: "openai",
      model: "fixture",
      steps: 2,
      inputTokens: 20,
      outputTokens: 20,
    });
  });
  it("stops before another model call when observed token usage reaches the threshold", async () => {
    const f = fixture();
    const model = new MockLanguageModelV4({
      doGenerate: [
        { ...calls(), usage: { ...usage, inputTokens: { ...usage.inputTokens, total: 64000 } } },
        answer(),
      ],
    });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow(/limits/);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(f.store.usage).toHaveBeenCalledTimes(1);
  });
  it("does not publish a final answer if usage persistence failed inside an isolated SDK callback", async () => {
    const f = fixture();
    vi.mocked(f.store.usage).mockRejectedValue(new Error("database unavailable"));
    const model = new MockLanguageModelV4({ doGenerate: answer() });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("reads an explicit source, prepares a report, and returns verifiable source metadata", async () => {
    const f = fixture();
    const readSource = vi.fn(async () => ({
      url: "https://example.com/research",
      text: "Launch is Tuesday.",
      truncated: false,
      fetchedAt: "2026-09-08T00:00:00.000Z",
    }));
    const model = new MockLanguageModelV4({
      doGenerate: [
        calls("read_public_page", '{"sourceIndex":0}'),
        calls(
          "write_report",
          JSON.stringify({ name: "研究报告.md", markdown: "# Findings\n\nLaunch is Tuesday." }),
        ),
        answer("The report is attached."),
      ],
    });
    const result = await executeAgentRun({
      ...f,
      run: { ...run, instruction: "Read https://example.com/research and write a report" },
      model,
      allowReports: true,
      readSource,
    });
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Launch is Tuesday.");
    expect(result.text).toBe("The report is attached.");
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      name: "研究报告.md",
      mediaType: "text/markdown",
      metadata: {
        executor: "native-agent",
        sources: [{ url: "https://example.com/research", truncated: false }],
      },
    });
    expect(result.reports[0]?.text).toContain("## Sources read by OpenBot");
    expect(f.store.complete).not.toHaveBeenCalled();
  });

  it("rejects unlisted sources, extra network arguments, unsafe filenames and duplicate reports", async () => {
    for (const [name, input] of [
      ["read_public_page", '{"sourceIndex":1}'],
      ["read_public_page", '{"sourceIndex":0,"url":"https://attacker.example"}'],
      ["write_report", '{"name":"../report.md","markdown":"content"}'],
      ["write_report", '{"name":"report.html","markdown":"content"}'],
    ]) {
      const f = fixture();
      const readSource = vi.fn();
      const model = new MockLanguageModelV4({ doGenerate: [calls(name, input), answer()] });
      await expect(
        executeAgentRun({
          ...f,
          run: { ...run, instruction: "Read https://example.com" },
          model,
          readSource,
          allowReports: true,
        }),
      ).rejects.toThrow();
      expect(readSource).not.toHaveBeenCalled();
    }
    const duplicate = calls("write_report", '{"name":"report.md","markdown":"content"}', 2);
    await expect(
      executeAgentRun({
        ...fixture(),
        model: new MockLanguageModelV4({ doGenerate: [duplicate, answer()] }),
        allowReports: true,
      }),
    ).rejects.toThrow();
  });

  it("does not retain a prepared report when a later model step fails", async () => {
    const f = fixture();
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++step === 1) return calls("write_report", '{"name":"report.md","markdown":"draft"}');
        throw new Error("upstream failure");
      },
    });
    await expect(executeAgentRun({ ...f, model, allowReports: true })).rejects.toThrow();
    expect(f.store.complete).not.toHaveBeenCalled();
  });

  it.each(["commit-failure", "settings-revoked", "notification-failure"])(
    "keeps report bytes consistent with terminal authority: %s",
    async (mode) => {
      const f = fixture();
      vi.mocked(f.store.queued).mockResolvedValueOnce([run]).mockResolvedValue([]);
      const config = {
        provider: "openai",
        model: "fixture",
        apiKey: "fixture-key",
        revision: "first",
        agentEnabled: true,
        agentEnabledAt: "2026-09-07T00:00:00Z",
      };
      const settings = {
        agentSettings: vi.fn(async () => ({ ...config })),
        onChange: () => () => {},
      } as unknown as ModelSettingsService;
      const artifact = {
        id: "report",
        runId: run.id,
        name: "report.md",
        mediaType: "text/markdown",
        sha256: "a".repeat(64),
        sizeBytes: 10,
        createdAt: run.createdAt,
      };
      const record = { artifact, storageKey: "runs/run/report.md", metadata: {} };
      const storage = {
        persist: vi.fn(async () => {
          if (mode === "settings-revoked") config.revision = "second";
          return [record];
        }),
        read: vi.fn(),
        remove: vi.fn(async () => {}),
      };
      vi.mocked(f.store.complete).mockImplementation(async () => {
        if (mode === "commit-failure") throw new Error("transaction failed");
        return {
          run: { ...run, status: "completed" },
          artifacts: [artifact],
          message: {
            id: "reply",
            channelId: run.channelId,
            authorType: "bot",
            authorId: run.botId,
            content: "Attached.",
            createdAt: run.createdAt,
          },
        };
      });
      const realtime = new ChannelRealtimeHub();
      if (mode === "notification-failure")
        realtime.subscribe(run.channelId, (event) => {
          if (event.type === "message.created") throw new Error("listener failed after commit");
        });
      const error = vi.fn();
      const model = new MockLanguageModelV4({
        doGenerate: [calls("write_report", '{"name":"report.md","markdown":"a report"}'), answer()],
      });
      const runner = new NativeAgentRunner(f.store, settings, realtime, error, () => model, {
        artifacts: storage,
      });
      try {
        runner.start();
        await vi.waitFor(() => {
          if (mode === "notification-failure") expect(error).toHaveBeenCalledTimes(1);
          else expect(f.store.fail).toHaveBeenCalledTimes(1);
        });
        if (mode === "notification-failure") {
          expect(storage.remove).not.toHaveBeenCalled();
          expect(f.store.fail).not.toHaveBeenCalled();
        } else {
          expect(storage.remove).toHaveBeenCalledWith([record.storageKey]);
          if (mode === "settings-revoked") expect(f.store.complete).not.toHaveBeenCalled();
        }
      } finally {
        await runner.stop();
      }
    },
  );
  it("returns a scoped observation to the model and completes on the next step", async () => {
    const f = fixture();
    const model = new MockLanguageModelV4({
      doGenerate: [calls(), answer("The launch is Tuesday.")],
    });
    expect(await executeAgentRun({ ...f, model })).toEqual({
      text: "The launch is Tuesday.",
      reports: [],
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("The launch is Tuesday.");
    expect(f.store.context).toHaveBeenCalledWith(run);
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(1024);
    expect(f.publish.mock.calls.map(([event]) => event.stage)).toEqual([
      "context",
      "planning",
      "observation",
      "planning",
    ]);
  });
  it.each([
    ["delete_file", "{}"],
    ["read_channel_context", '{"channelId":"other"}'],
    ["read_task_status", "not-json"],
  ])("rejects unavailable tools and invalid inputs: %s", async (name, input) => {
    const f = fixture();
    const model = new MockLanguageModelV4({ doGenerate: [calls(name, input), answer()] });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    expect(f.store.context).not.toHaveBeenCalled();
    expect(f.store.tasks).not.toHaveBeenCalled();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it("fails when eight tool steps do not reach a final answer", async () => {
    const f = fixture();
    const model = new MockLanguageModelV4({ doGenerate: calls() });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow(/limits/);
    expect(model.doGenerateCalls).toHaveLength(8);
  });
  it("bounds parallel tools to sixteen actual reads", async () => {
    const f = fixture();
    const model = new MockLanguageModelV4({
      doGenerate: [calls("read_channel_context", "{}", 17), answer()],
    });
    await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    expect(f.store.context).toHaveBeenCalledTimes(16);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it("does not retry a provider error", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("private provider error");
      },
    });
    await expect(executeAgentRun({ ...fixture(), model })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it("stops on changed settings, revoked scope, cancellation, or excessive output", async () => {
    for (const kind of ["settings", "scope", "abort", "tool-size", "final-size"]) {
      const f = fixture();
      if (kind === "settings") f.checkSettings.mockRejectedValue(new Error("changed"));
      if (kind === "scope") vi.mocked(f.store.assertScope).mockRejectedValue(new Error("revoked"));
      if (kind === "abort") f.signal = AbortSignal.abort();
      if (kind === "tool-size") vi.mocked(f.store.context).mockResolvedValue("x".repeat(17000));
      const model = new MockLanguageModelV4({
        doGenerate:
          kind === "tool-size"
            ? [calls(), answer()]
            : answer(kind === "final-size" ? "x".repeat(8001) : "ok"),
      });
      await expect(executeAgentRun({ ...f, model })).rejects.toThrow();
    }
  });
  it("does not poll or instantiate a model without Owner opt-in", async () => {
    const f = fixture();
    const settings = {
      agentSettings: vi.fn(async () => undefined),
      onChange: () => () => {},
    } as unknown as ModelSettingsService;
    const makeModel = vi.fn();
    const runner = new NativeAgentRunner(
      f.store,
      settings,
      new ChannelRealtimeHub(),
      vi.fn(),
      makeModel,
    );
    runner.start();
    await runner.stop();
    expect(f.store.queued).not.toHaveBeenCalled();
    expect(makeModel).not.toHaveBeenCalled();
  });
  it("aborts only the requested active task and ignores late output", async () => {
    const f = fixture();
    const other = { ...run, id: "other-run", channelId: "other-channel" };
    vi.mocked(f.store.queued).mockResolvedValueOnce([run, other]).mockResolvedValue([]);
    vi.mocked(f.store.claim).mockImplementation(async (value) => value);
    const config = {
      provider: "openai",
      model: "fixture",
      apiKey: "not-a-real-key",
      revision: "initial",
      agentEnabled: true,
      agentEnabledAt: "2026-09-07T00:00:00Z",
    };
    const settings = {
      agentSettings: async () => config,
      onChange: () => () => {},
    } as unknown as ModelSettingsService;
    const models: MockLanguageModelV4[] = [];
    const runner = new NativeAgentRunner(
      f.store,
      settings,
      new ChannelRealtimeHub(),
      vi.fn(),
      () => {
        const model = new MockLanguageModelV4({
          doGenerate: async (options) =>
            new Promise((_resolve, reject) =>
              options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              }),
            ),
        });
        models.push(model);
        return model;
      },
    );
    try {
      runner.start();
      await vi.waitFor(() => expect(models[1]?.doGenerateCalls).toHaveLength(1));
      runner.cancel(run.id);
      await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledTimes(1));
      expect(models[0]?.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
      expect(models[1]?.doGenerateCalls[0]?.abortSignal?.aborted).toBe(false);
      expect(f.store.complete).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });
  it("bounds concurrency, serializes channel Bot identities, and aborts active inference when settings change", async () => {
    const f = fixture();
    const queued = [
      run,
      { ...run, id: "same-channel" },
      { ...run, id: "other-channel", channelId: "other" },
      { ...run, id: "third-channel", channelId: "third" },
    ];
    vi.mocked(f.store.queued).mockResolvedValue(queued);
    vi.mocked(f.store.claim).mockImplementation(async (candidate) => candidate);
    vi.mocked(f.store.fail).mockImplementation(async (candidate) => ({
      ...candidate,
      status: "failed",
    }));
    const config = {
      provider: "openai" as const,
      model: "test-model",
      apiKey: "fixture-key",
      revision: "initial",
      agentEnabled: true,
      agentEnabledAt: "2026-09-07T00:00:00Z",
    };
    let changed: (() => void) | undefined;
    const current = vi.fn(async () => config);
    const settings = {
      agentSettings: current,
      onChange: (listener: () => void) => {
        changed = listener;
        return () => {};
      },
    } as unknown as ModelSettingsService;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) =>
        new Promise((_resolve, reject) => {
          if (options.abortSignal?.aborted) reject(new Error("aborted"));
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const realtime = new ChannelRealtimeHub();
    const events: unknown[] = [];
    realtime.subscribe(run.channelId, (event) => events.push(event));
    const runner = new NativeAgentRunner(f.store, settings, realtime, vi.fn(), () => model);
    runner.start();
    try {
      await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(3));
      expect(vi.mocked(f.store.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([
        "run",
        "other-channel",
        "third-channel",
      ]);
      expect(f.store.queued).toHaveBeenCalledWith(config.agentEnabledAt);
      config.revision = "replaced";
      changed?.();
      await vi.waitFor(() => expect(f.store.fail).toHaveBeenCalledTimes(3));
      expect(f.store.complete).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain("fixture-key");
    } finally {
      await runner.stop();
    }
  });
});

describe("asynchronous native output and corrections", () => {
  it("reads only an exact enabled resource and hides Owner prompts and app HTML", async () => {
    const f = fixture();
    const pluginId = "11111111-1111-4111-8111-111111111111",
      revision = "22222222-2222-4222-8222-222222222222";
    const input = { pluginId, revision, name: "resource://facts" };
    const plugins = {
      catalog: vi.fn(async () => ({ tools: [], truncated: false })),
      call: vi.fn(),
      contentCatalog: vi.fn(async () => ({
        items: [
          {
            ...input,
            kind: "resource" as const,
            pluginName: "Facts",
            description: "Scoped facts",
            mimeType: "text/plain",
          },
          {
            ...input,
            kind: "prompt" as const,
            name: "PRIVATE_OWNER_PROMPT",
            pluginName: "Facts",
            description: "Owner choice",
          },
          {
            ...input,
            kind: "resource" as const,
            name: "ui://PRIVATE_APP",
            pluginName: "Facts",
            description: "App",
            mimeType: "text/html;profile=mcp-app",
          },
        ],
        truncated: false,
      })),
      readContent: vi.fn(async () => ({
        contents: [{ uri: input.name, text: "Verified plugin facts" }],
      })),
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        calls("read_plugin_resource", JSON.stringify(input)),
        answer("Facts summarized"),
      ],
    });
    await executeAgentRun({ ...f, plugins, model });
    expect(plugins.readContent).toHaveBeenCalledWith(run, { ...input, kind: "resource" }, f.signal);
    const first = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(first).not.toContain("PRIVATE_OWNER_PROMPT");
    expect(first).not.toContain("PRIVATE_APP");
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Verified plugin facts");
  });
  it("fails closed when a resource grant is revoked before its read", async () => {
    const f = fixture();
    const input = {
      pluginId: "11111111-1111-4111-8111-111111111111",
      revision: "22222222-2222-4222-8222-222222222222",
      name: "resource://facts",
    };
    const { PluginError } = await import("./plugin-types.js");
    const plugins = {
      catalog: vi.fn(async () => ({ tools: [], truncated: false })),
      call: vi.fn(),
      contentCatalog: vi.fn(async () => ({
        items: [
          { ...input, kind: "resource" as const, pluginName: "Facts", description: "Scoped facts" },
        ],
        truncated: false,
      })),
      readContent: vi.fn(async () => {
        throw new PluginError("forbidden");
      }),
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        calls("read_plugin_resource", JSON.stringify(input)),
        answer("Must not complete"),
      ],
    });
    await expect(executeAgentRun({ ...f, plugins, model })).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
  it("publishes actual text deltas before completion and never reasoning", async () => {
    const f = fixture();
    const output = vi.fn();
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "reasoning-start", id: "private" });
            c.enqueue({ type: "reasoning-delta", id: "private", delta: "PRIVATE REASONING" });
            c.enqueue({ type: "reasoning-end", id: "private" });
            c.enqueue({ type: "text-start", id: "answer" });
            c.enqueue({ type: "text-delta", id: "answer", delta: "Hello" });
            c.enqueue({ type: "text-delta", id: "answer", delta: " world" });
            c.enqueue({ type: "text-end", id: "answer" });
            c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            c.close();
          },
        }),
      },
    });
    expect((await executeAgentRun({ ...f, model, publishOutput: output })).text).toBe(
      "Hello world",
    );
    expect(output.mock.calls).toContainEqual(["Hello", false]);
    expect(output.mock.calls).toContainEqual(["Hello world", false]);
    expect(JSON.stringify(output.mock.calls)).not.toContain("PRIVATE REASONING");
  });
  it("does not log private provider errors through the SDK default streaming observer", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const model = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start", warnings: [] });
            c.enqueue({ type: "error", error: new Error("PRIVATE PROVIDER BODY") });
            c.close();
          },
        }),
      },
    });
    try {
      await expect(executeAgentRun({ ...f, model, publishOutput: vi.fn() })).rejects.toThrow();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
  it("injects exact task corrections at the next step and retains them on later steps", async () => {
    const f = fixture();
    let correction = false;
    f.store.steering = vi.fn(async () =>
      correction
        ? [
            {
              id: "steer",
              runId: run.id,
              channelId: run.channelId,
              botId: run.botId,
              instruction: "Use Chinese",
              createdAt: run.createdAt,
            },
          ]
        : [],
    );
    f.store.context = vi.fn(async () => {
      correction = true;
      return [];
    });
    const model = new MockLanguageModelV4({
      doGenerate: [calls(), calls("read_task_status"), answer("中文答复")],
    });
    const result = await executeAgentRun({ ...f, model });
    expect(result.appliedSteeringIds).toEqual(["steer"]);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain("Use Chinese");
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Use Chinese");
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain("Use Chinese");
  });
  it("recomputes before committing when an Owner correction wins the final transaction race", async () => {
    const f = fixture();
    vi.mocked(f.store.queued).mockResolvedValueOnce([run]).mockResolvedValue([]);
    const { PendingSteeringError } = await import("./agent-steering.js");
    vi.mocked(f.store.complete)
      .mockRejectedValueOnce(new PendingSteeringError())
      .mockResolvedValue({
        run: { ...run, status: "completed" },
        message: {
          id: "reply",
          channelId: run.channelId,
          authorType: "bot",
          authorId: run.botId,
          content: "Corrected",
          createdAt: run.createdAt,
        },
      });
    const settings = {
      agentSettings: async () => ({
        provider: "openai",
        model: "fixture",
        apiKey: "fixture",
        revision: "1",
        agentEnabled: true,
        agentEnabledAt: run.createdAt,
      }),
      onChange: () => () => {},
    } as unknown as ModelSettingsService;
    const model = new MockLanguageModelV4({ doGenerate: [answer("Draft"), answer("Corrected")] });
    const runner = new NativeAgentRunner(
      f.store,
      settings,
      new ChannelRealtimeHub(),
      vi.fn(),
      () => model,
    );
    try {
      runner.start();
      await vi.waitFor(() => expect(f.store.complete).toHaveBeenCalledTimes(2));
      expect(f.store.fail).not.toHaveBeenCalled();
      expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Draft");
    } finally {
      await runner.stop();
    }
  });
});

describe("official provider HTTP contracts", () => {
  it.each([
    [new DOMException("fixture deadline", "TimeoutError"), "task_timeout"],
    [new NativeExecutionError("settings_changed"), "settings_changed"],
  ])("retains categorized cancellation during response consumption", async (reason, code) => {
    const controller = new AbortController();
    let released: Response | undefined;
    const bounded = agentFetch("openai", async (_input, init) => {
      released = new Response(
        new ReadableStream<Uint8Array>(
          {
            start(stream) {
              init?.signal?.addEventListener(
                "abort",
                () => stream.error(new Error("PRIVATE STREAM ERROR")),
                { once: true },
              );
            },
            pull() {
              controller.abort(reason);
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );
      return released;
    });
    await expect(
      bounded("https://api.openai.com/v1/responses", { method: "POST", signal: controller.signal }),
    ).rejects.toMatchObject({ code });
    expect(released?.body?.locked).toBe(false);
  });

  it("sanitizes a mid-body provider failure and releases the reader", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            stream.error(new Error("PRIVATE STREAM ERROR"));
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
    await expect(
      agentFetch("openai", async () => response)("https://api.openai.com/v1/responses", {
        method: "POST",
      }),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      message: expect.not.stringContaining("PRIVATE"),
    });
    expect(response.body?.locked).toBe(false);
  });

  it.each([
    [401, "model_credentials"],
    [403, "model_credentials"],
    [429, "model_rate_limit"],
    [503, "model_unavailable"],
  ])("categorizes provider HTTP %s without retaining its body", async (status, code) => {
    const bounded = agentFetch(
      "openai",
      async () =>
        new Response("PRIVATE PROVIDER BODY", {
          status: Number(status),
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      bounded("https://api.openai.com/v1/responses", { method: "POST" }),
    ).rejects.toMatchObject({ code });
  });

  it.each(["openai", "anthropic"] as const)(
    "executes %s tool response followed by final answer through the real SDK",
    async (provider) => {
      const requests: { url: string; body: unknown; headers: Headers }[] = [];
      const fetcher: typeof fetch = async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        const first = requests.length === 1;
        return Response.json(
          provider === "openai"
            ? {
                id: "resp_test",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "test-model",
                error: null,
                incomplete_details: null,
                output: first
                  ? [
                      {
                        type: "function_call",
                        id: "fc_test",
                        call_id: "call_test",
                        name: "read_channel_context",
                        arguments: "{}",
                        status: "completed",
                      },
                    ]
                  : [
                      {
                        type: "message",
                        id: "msg_test",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "Tuesday.", annotations: [] }],
                      },
                    ],
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              }
            : {
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: "test-model",
                stop_reason: first ? "tool_use" : "end_turn",
                stop_sequence: null,
                content: first
                  ? [{ type: "tool_use", id: "call_test", name: "read_channel_context", input: {} }]
                  : [{ type: "text", text: "Tuesday." }],
                usage: { input_tokens: 10, output_tokens: 10 },
              },
        );
      };
      const fetch = agentFetch(provider, fetcher);
      const model =
        provider === "openai"
          ? createOpenAI({ apiKey: "fixture-key", fetch }).responses("test-model")
          : createAnthropic({ apiKey: "fixture-key", fetch })("test-model");
      expect(await executeAgentRun({ ...fixture(), model })).toEqual({
        text: "Tuesday.",
        reports: [],
      });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.body)).toContain("The launch is Tuesday.");
      expect(requests[0]?.url).toBe(
        provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages",
      );
      expect(
        requests[0]?.headers.get(provider === "openai" ? "authorization" : "x-api-key"),
      ).toContain("fixture-key");
    },
  );
  it("rejects redirects, large replies, and endpoint substitution", async () => {
    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://other.invalid" } }),
    );
    await expect(
      agentFetch("openai", redirect)("https://api.openai.com/v1/responses", { method: "POST" }),
    ).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "manual" }),
    );
    await expect(
      agentFetch("openai", redirect)("https://other.invalid", { method: "POST" }),
    ).rejects.toThrow(/endpoint/);
    expect(redirect).toHaveBeenCalledTimes(1);
    await expect(
      agentFetch("openai", async () => Response.json({ text: "x".repeat(524289) }))(
        "https://api.openai.com/v1/responses",
        { method: "POST" },
      ),
    ).rejects.toMatchObject({ code: "task_limit" });
  });
});

describe("reviewed skill tool integration", () => {
  const descriptor = {
    id: "669f3734-dd10-47f1-94a8-7e83bc1aa609",
    name: "evidence-report",
    description: "Use for reports",
    version: "1.0.0",
    revision: 2,
    sha256: "a".repeat(64),
  };
  function skillFixture() {
    const f = fixture();
    f.store.skills = vi.fn(async () => ({ skills: [descriptor], truncated: false }));
    f.store.readSkill = vi.fn(async () => ({
      ...descriptor,
      markdown: "Reviewed workflow: read evidence, then write the report.",
    }));
    f.store.assertSkills = vi.fn(async () => {});
    return f;
  }
  it("discovers metadata first, reads full content through the scoped tool and returns publication references", async () => {
    const f = skillFixture();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(calls("read_skill", JSON.stringify({ skillId: descriptor.id })))
      .mockResolvedValueOnce(answer("Used the reviewed report workflow."));
    const result = await executeAgentRun({
      ...f,
      model: new MockLanguageModelV4({ doGenerate: generate }),
    });
    expect(JSON.stringify(generate.mock.calls[0])).toContain("evidence-report");
    expect(JSON.stringify(generate.mock.calls[0])).not.toContain("Reviewed workflow:");
    expect(JSON.stringify(generate.mock.calls[1])).toContain("Reviewed workflow:");
    expect(result.skillReferences).toEqual([
      { id: descriptor.id, revision: 2, sha256: descriptor.sha256 },
    ]);
    expect(f.store.assertSkills).toHaveBeenLastCalledWith(run, result.skillReferences);
  });
  it("denies an unlisted skill before accessing the store", async () => {
    const f = skillFixture();
    const generate = vi
      .fn()
      .mockResolvedValue(
        calls("read_skill", JSON.stringify({ skillId: "6b8c8307-530f-4f1e-9ae6-ef9a00b64d53" })),
      );
    await expect(
      executeAgentRun({ ...f, model: new MockLanguageModelV4({ doGenerate: generate }) }),
    ).rejects.toThrow();
    expect(f.store.readSkill).not.toHaveBeenCalled();
  });
  it("rejects skill assignment changes after a model response without returning staged output", async () => {
    const f = skillFixture();
    let changed = false;
    f.store.assertSkills = async (_run, refs) => {
      if (changed && refs.length) throw new NativeExecutionError("skills_changed");
    };
    const generate = vi
      .fn()
      .mockResolvedValueOnce(calls("read_skill", JSON.stringify({ skillId: descriptor.id })))
      .mockImplementationOnce(async () => {
        changed = true;
        return answer();
      });
    await expect(
      executeAgentRun({ ...f, model: new MockLanguageModelV4({ doGenerate: generate }) }),
    ).rejects.toMatchObject({ code: "skills_changed" });
  });
  it("classifies an unlisted skill as invalid_target, not channel scope revocation", async () => {
    const f = skillFixture();
    const generate = vi
      .fn()
      .mockResolvedValue(
        calls("read_skill", JSON.stringify({ skillId: "6b8c8307-530f-4f1e-9ae6-ef9a00b64d53" })),
      );
    await expect(
      executeAgentRun({ ...f, model: new MockLanguageModelV4({ doGenerate: generate }) }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(f.store.readSkill).not.toHaveBeenCalled();
  });
  it("classifies usage persistence conflicts separately from scope_revoked", async () => {
    const f = skillFixture();
    vi.mocked(f.store.usage).mockRejectedValue(new NativeExecutionError("conflict"));
    const generate = vi.fn().mockResolvedValue(answer());
    await expect(
      executeAgentRun({ ...f, model: new MockLanguageModelV4({ doGenerate: generate }) }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("wait_for_task target classification", () => {
  it("fails unknown child run IDs as invalid_target instead of scope_revoked", async () => {
    const f = fixture();
    const unknownId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    vi.mocked(f.store.queued).mockResolvedValueOnce([run]).mockResolvedValue([]);
    f.store.colleagues = vi.fn(async () => ({ bots: [], truncated: false }));
    f.store.delegate = vi.fn(async () => {
      throw new Error("No delegation should be created for an unknown wait target.");
    });
    const settings = {
      agentSettings: async () => ({
        provider: "openai",
        model: "fixture",
        apiKey: "fixture",
        revision: "1",
        agentEnabled: true,
        agentEnabledAt: run.createdAt,
      }),
      onChange: () => () => {},
    } as unknown as ModelSettingsService;
    const model = new MockLanguageModelV4({
      doGenerate: calls("wait_for_task", JSON.stringify({ runId: unknownId })),
    });
    const runner = new NativeAgentRunner(
      f.store,
      settings,
      new ChannelRealtimeHub(),
      vi.fn(),
      () => model,
    );
    try {
      runner.start();
      await vi.waitFor(() =>
        expect(f.store.fail).toHaveBeenCalledWith(
          expect.objectContaining({ id: run.id }),
          "invalid_target",
        ),
      );
      expect(f.store.delegate).not.toHaveBeenCalled();
      expect(f.store.complete).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
    }
  });
  it("keeps true channel membership loss as scope_revoked", async () => {
    const f = fixture();
    vi.mocked(f.store.assertScope).mockRejectedValue(new NativeExecutionError("scope_revoked"));
    const generate = vi.fn().mockResolvedValue(answer());
    await expect(
      executeAgentRun({ ...f, model: new MockLanguageModelV4({ doGenerate: generate }) }),
    ).rejects.toMatchObject({ code: "scope_revoked" });
  });
});
