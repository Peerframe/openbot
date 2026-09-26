import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import type { Artifact, Bot, Channel, Run } from "@openbot/domain";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeExecutionError } from "./agent-observations.js";
import type { AgentRuntimeExecutor } from "./agent-runtime.js";
import { bootstrapAgentRuntime } from "./agent-runtime-bootstrap.js";
import { AgentRuntimeHost } from "./agent-runtime-host.js";
import { createApp } from "./app.js";
import { FileArtifactStorage } from "./artifact-storage.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import type { ModelSettingsService } from "./model-settings.js";
import { NativeAgentRunner } from "./native-agent.js";
import { OwnerAuthService } from "./owner-auth.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";
import type { PluginConnector } from "./plugin-transport.js";
import { PostgresAgentStore } from "./postgres-agent-store.js";
import { PostgresRequestThrottleStore } from "./postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "./postgres-session-store.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";
import { RequestThrottle } from "./request-throttle.js";

// Reuse the existing disposable collaboration database contract and never load .env.
const url = process.env.OPENBOT_COLLAB_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/openbot_collab_test_[a-z0-9_]+$/.test(target.pathname) ||
    target.search ||
    target.hash
  )
    throw new Error(
      "Headless acceptance requires a disposable loopback openbot_collab_test_* database.",
    );
}
const pythonExecutor =
  process.env.OPENBOT_RUNTIME_TEST_PYTHON === "1"
    ? await bootstrapAgentRuntime({ OPENBOT_AGENT_RUNTIME: "python" })
    : undefined;
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = (text = "Completed fixture task.") => ({
  content: [{ type: "text" as const, text }],
  usage,
  finishReason: { unified: "stop" as const, raw: "stop" },
  warnings: [],
});
const call = (toolName: string, input: unknown) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: randomUUID(),
      toolName,
      input: JSON.stringify(input),
    },
  ],
  usage,
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  warnings: [],
});
const proposal = {
  kind: "procedural",
  title: "Report workflow",
  content: "Check source dates before writing a report.",
};

describe.skipIf(!url)("headless Server runtime acceptance", () => {
  const database = url ? createDatabase(url) : undefined;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => database?.migrate());
  beforeEach(async () => {
    if (!database) return;
    await database.client`set client_min_messages = warning`;
    await database.client`truncate bots, channels, auth_sessions, request_throttle_buckets cascade`;
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  afterAll(async () => database?.close());

  async function fixture(
    model: MockLanguageModelV4,
    executeRuntime: AgentRuntimeExecutor | undefined = pythonExecutor,
    connector?: PluginConnector,
  ) {
    if (!database) throw new Error("Missing disposable database.");
    const directory = await mkdtemp(join(tmpdir(), "openbot-headless-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    const artifacts = new FileArtifactStorage(directory);
    const plugins = connector
      ? new PluginService({
          store: new FilePluginStore(join(directory, "plugins", "state.json")),
          connector,
          assertScope: (run) => native.assertScope(run),
          botExists: async (id) => (await store.listBots()).some((bot) => bot.id === id),
        })
      : undefined;
    if (plugins) cleanups.push(async () => plugins.close());
    const realtime = new ChannelRealtimeHub();
    const requestThrottle = new RequestThrottle(new PostgresRequestThrottleStore(database.db));
    const auth = new OwnerAuthService(
      new PostgresOwnerSessionStore(database.db),
      {
        ownerName: "Fixture Owner",
        ownerPassword: "fixture-only-password",
        sessionTtlMs: 60_000,
      },
      requestThrottle,
    );
    const settings = {
      agentSettings: async () => ({
        provider: "openai",
        model: "deterministic-fixture",
        apiKey: "never-sent",
        revision: "fixture",
        agentEnabled: true,
        agentEnabledAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      onChange: () => () => {},
    } as unknown as ModelSettingsService;
    const errors = vi.fn();
    const runner = new NativeAgentRunner(native, settings, realtime, errors, () => model, {
      artifacts,
      executeRuntime,
      plugins,
    });
    cleanups.push(() => runner.stop());
    const origin = "http://localhost:5173";
    const app = createApp({
      store,
      auth,
      requestThrottle,
      realtime,
      artifactStorage: artifacts,
      plugins,
      steerNativeRun: (id, instruction) => native.steer(id, instruction),
      nativeRunOutput: async (id) => {
        const run = await native.lookup(id);
        if (!run || !["queued", "running"].includes(run.status)) return undefined;
        await native.assertScope(run);
        return runner.output(id);
      },
      allowedOrigins: [origin],
      secureCookies: false,
      getRemoteAddress: () => "127.0.0.1",
      listNodes: () => [],
      dispatchRun: () => runner.enqueue(),
      cancelNativeRun: async (id) => {
        const cancelled = await native.cancel(id);
        runner.cancel(id);
        return cancelled;
      },
    });
    expect((await app.request("/api/v1/channels")).status).toBe(401);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "fixture-only-password" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const botResponse = await request("/api/v1/bots", {
      name: "Fixture Bot",
      role: "Research",
      computerProfile: "none",
    });
    expect(botResponse.status).toBe(201);
    const { bot } = (await botResponse.json()) as { bot: Bot };
    const channelResponse = await request("/api/v1/channels", {
      name: "Headless acceptance",
      description: "Synthetic fixture",
      botIds: [bot.id],
    });
    expect(channelResponse.status).toBe(201);
    const { channel } = (await channelResponse.json()) as { channel: Channel };
    const submit = async (content = "Prepare a report from this task.") => {
      const response = await request(`/api/v1/channels/${channel.id}/messages`, {
        content,
        botId: bot.id,
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { run: Run }).run;
    };
    const terminal = async (run: Run, status: Run["status"]) => {
      await vi.waitFor(async () => expect((await native.current(run))?.status).toBe(status), {
        timeout: 4000,
        interval: 20,
      });
      expect(errors).not.toHaveBeenCalled();
    };
    runner.start();
    return {
      store,
      native,
      runner,
      request,
      bot,
      channel,
      submit,
      terminal,
      artifacts,
      realtime,
      plugins,
    };
  }

  it("submits through the Owner API and downloads the committed report without a client UI", async () => {
    // Default lane uses a two-step host fixture; --python selects the actual Python SDK process.
    const hostExecutor: AgentRuntimeExecutor = async (ports, input) => {
      const host = new AgentRuntimeHost(ports, input);
      await host.catalog();
      const first = await host.generate(input.messages);
      const intent = first.tools[0];
      if (!intent || first.tools.length !== 1) throw new Error("Expected one report intent.");
      const observation = await host.executeTool(intent);
      const second = await host.generate([
        ...input.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: intent.id,
              toolName: intent.name,
              input: intent.arguments,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: intent.id,
              toolName: intent.name,
              output: { type: "json", value: observation },
            },
          ],
        },
      ]);
      return host.finish(second.text);
    };
    const selectedExecutor = vi.fn<AgentRuntimeExecutor>(pythonExecutor ?? hostExecutor);
    const f = await fixture(
      new MockLanguageModelV4({
        doGenerate: [
          call("write_report", {
            name: "报告.md",
            markdown: "# Fixture result\nVerified local task.",
          }),
          answer(),
        ],
      }),
      selectedExecutor,
    );
    const run = await f.submit();
    await f.terminal(run, "completed");
    expect(selectedExecutor).toHaveBeenCalledOnce();
    const artifacts = await f.store.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    const download = await f.request(`/api/v1/artifacts/${artifacts[0]?.id}/content`);
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("Verified local task.");
    expect(
      (await f.store.listMessages(f.channel.id)).filter((message) => message.authorType === "bot"),
    ).toHaveLength(1);
  });

  it("records a tool failure and never publishes its staged report or a success reply", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("write_report", { name: "prepared.md", markdown: "Staged only." }),
        call("read_task_status", {}),
        answer("Must not publish"),
      ],
    });
    const f = await fixture(model);
    vi.spyOn(f.native, "tasks").mockRejectedValue(new Error("private fixture failure"));
    const run = await f.submit();
    await f.terminal(run, "failed");
    expect((await f.native.current(run))?.errorCode).toBe("tool_unavailable");
    expect(await f.store.listArtifacts(run.id)).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(
      (await f.store.listMessages(f.channel.id)).some((message) => message.authorType === "bot"),
    ).toBe(false);
  });

  it("commits cancellation through the Owner API before ignoring a late model result", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof answer>>();
    const model = new MockLanguageModelV4({ doGenerate: () => pending.promise });
    const f = await fixture(model);
    const run = await f.submit();
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1), { timeout: 4000 });
    const cancelled = await f.request(`/api/v1/runs/${run.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect((await f.native.current(run))?.status).toBe("cancelled");
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
    pending.resolve(answer("Late answer must never commit."));
    await f.runner.stop();
    expect((await f.native.current(run))?.status).toBe("cancelled");
    expect(await f.store.listArtifacts(run.id)).toEqual([]);
    expect(
      (await f.store.listMessages(f.channel.id)).some((message) => message.authorType === "bot"),
    ).toBe(false);
  });

  it("continues the task after the authenticated realtime response is disconnected", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof answer>>();
    const model = new MockLanguageModelV4({ doGenerate: () => pending.promise });
    const f = await fixture(model);
    const response = await f.request(`/api/v1/channels/${f.channel.id}/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("channel.ready");
    const run = await f.submit();
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1), { timeout: 4000 });
    await reader?.cancel();
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(false);
    pending.resolve(answer("Completed after disconnect."));
    await f.terminal(run, "completed");
    expect(
      (await f.store.listMessages(f.channel.id)).some(
        (message) => message.content === "Completed after disconnect.",
      ),
    ).toBe(true);
  });

  it("retains the report and source provenance when an Owner correction wins completion", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("fetch", { url: "https://example.com/" }),
        call("write_report", { name: "retained.md", markdown: "Prepared before correction." }),
        call("propose_memory", proposal),
        answer("Initial draft"),
        answer("Corrected final answer"),
      ],
    });
    const f = await fixture(model);
    f.runner.options.readSource = async () => ({
      url: "https://example.com/",
      text: "Fixture source",
      fetchedAt: "2026-09-22T00:00:00.000Z",
      truncated: false,
    });
    const complete = f.native.complete.bind(f.native);
    let corrected = false;
    vi.spyOn(f.native, "complete").mockImplementation(async (...args) => {
      if (!corrected) {
        corrected = true;
        await f.native.steer(args[0].id, "Keep the report and shorten the final reply.");
      }
      return complete(...args);
    });
    const run = await f.submit();
    await f.terminal(run, "completed");
    const artifacts: Artifact[] = await f.store.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    const download = await f.request(`/api/v1/artifacts/${artifacts[0]?.id}/content`);
    const text = await download.text();
    expect(text).toContain("Prepared before correction.");
    expect(text.match(/Sources read by OpenBot/g)).toHaveLength(1);
    expect(text).toContain("https://example.com/");
    expect((await f.native.current(run))?.modelUsage?.steps).toBe(5);
    if (!database) throw new Error("Missing database.");
    const proposals =
      await database.client`select title from knowledge_proposals where source_run_id = ${run.id}`;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.title).toBe(proposal.title);
  });

  it("delivers the reply and report when optional learning reaches its pending queue limit", async () => {
    const f = await fixture(
      new MockLanguageModelV4({
        doGenerate: [
          call("write_report", {
            name: "delivered.md",
            markdown: "Deliver even when optional learning is full.",
          }),
          call("propose_memory", proposal),
          answer(),
        ],
      }),
    );
    // Fill the real bounded queue with independent completed fixture Runs.
    await f.runner.stop();
    for (let index = 0; index < 50; index++) {
      const { run } = await f.store.submitTask(f.channel.id, {
        content: `Fixture history ${index}`,
        botId: f.bot.id,
      });
      const claimed = await f.native.claim(run, "2026-01-01T00:00:00.000Z");
      if (!claimed) throw new Error("Unable to claim fixture history.");
      await f.native.complete(claimed, "Previous task completed.", [], {
        ...proposal,
        kind: "procedural",
      });
    }
    f.runner.start();
    const run = await f.submit();
    await f.terminal(run, "completed");
    expect(await f.store.listArtifacts(run.id)).toHaveLength(1);
    if (!database) throw new Error("Missing database.");
    const [count] =
      await database.client`select count(*)::int as count from knowledge_proposals where bot_id = ${f.bot.id} and status = 'pending'`;
    expect(count?.count).toBe(50);
    const events =
      await database.client`select type, payload from run_events where run_id = ${run.id} and type = 'KNOWLEDGE_PROPOSAL_SKIPPED'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ executor: "native-agent", reason: "pending_limit" });
  }, 30_000);
  it.each(["usage", "audit"])(
    "fails closed when durable %s rejects the next action",
    async (kind) => {
      const model = new MockLanguageModelV4({
        doGenerate: [
          call("write_report", { name: "blocked.md", markdown: "Must not publish" }),
          answer(),
        ],
      });
      const f = await fixture(model);
      if (kind === "usage")
        vi.spyOn(f.native, "usage").mockRejectedValue(new NativeExecutionError("conflict"));
      else {
        const progress = f.native.progress.bind(f.native);
        vi.spyOn(f.native, "progress").mockImplementation(async (...args) => {
          if (args[1] === "planning") throw new NativeExecutionError("conflict");
          return progress(...args);
        });
      }
      const run = await f.submit();
      await f.terminal(run, "failed");
      expect((await f.native.current(run))?.errorCode).toBe("conflict");
      expect(model.doGenerateCalls).toHaveLength(kind === "usage" ? 1 : 0);
      expect(await f.store.listArtifacts(run.id)).toEqual([]);
      expect(
        (await f.store.listMessages(f.channel.id)).filter(
          (message) => message.authorType === "bot",
        ),
      ).toEqual([]);
    },
  );

  it("rechecks persisted membership after a model response before executing its proposed effect", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof call>>();
    const model = new MockLanguageModelV4({ doGenerate: () => pending.promise });
    const f = await fixture(model);
    const run = await f.submit();
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1), { timeout: 4000 });
    if (!database) throw new Error("Missing database");
    // Revoke only this disposable fixture's membership while the provider request is in flight.
    await database.client`delete from channel_bots where channel_id = ${f.channel.id} and bot_id = ${f.bot.id}`;
    pending.resolve(call("write_report", { name: "revoked.md", markdown: "Must not publish" }));
    await f.terminal(run, "failed");
    expect((await f.native.current(run))?.errorCode).toBe("scope_revoked");
    expect(await f.store.listArtifacts(run.id)).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("enforces the Server's eight-step budget through the complete tool feedback loop", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => call("read_task_status", {}) });
    const f = await fixture(model);
    const run = await f.submit();
    await f.terminal(run, "failed");
    expect(model.doGenerateCalls).toHaveLength(8);
    expect((await f.native.current(run))?.errorCode).toBe("task_limit");
    expect((await f.native.current(run))?.modelUsage?.steps).toBe(8);
    expect(
      (await f.store.listMessages(f.channel.id)).filter((message) => message.authorType === "bot"),
    ).toEqual([]);
  });

  it("applies an Owner instruction arriving between model steps without losing the task context", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof call>>();
    let steps = 0;
    const model = new MockLanguageModelV4({
      doGenerate: () =>
        ++steps === 1 ? pending.promise : Promise.resolve(answer("Dates checked.")),
    });
    const f = await fixture(model);
    const run = await f.submit("Report the current task facts.");
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1), { timeout: 4000 });
    expect(
      (
        await f.request(`/api/v1/runs/${run.id}/steer`, {
          instruction: "Check source dates before answering.",
        })
      ).status,
    ).toBe(202);
    pending.resolve(call("read_task_status", {}));
    await f.terminal(run, "completed");
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Check source dates before answering.",
    );
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
      "Report the current task facts.",
    );
    expect((await f.native.current(run))?.modelUsage?.steps).toBe(2);
  });

  it.each(["approve", "reject", "cancel"])(
    "keeps a plugin effect pending until the Owner chooses %s",
    async (decision) => {
      const effect = vi.fn(async () => ({
        content: [{ type: "text", text: "Fixture effect completed" }],
      }));
      let pluginInput:
        | { pluginId: string; revision: number; toolName: string; arguments: { text: string } }
        | undefined;
      let steps = 0;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          if (!pluginInput) throw new Error("Fixture plugin was not configured");
          return ++steps === 1
            ? call("call_plugin", pluginInput)
            : answer("Approved action completed.");
        },
      });
      const f = await fixture(model, pythonExecutor, async () => ({
        tools: async () => [
          {
            name: "record_note",
            description: "Record a fixture note",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", maxLength: 100 } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
        call: effect,
        close: async () => {},
      }));
      if (!f.plugins) throw new Error("Missing fixture plugin service");
      const descriptor = { name: "Fixture notes", endpoint: "https://plugins.example.com/mcp" };
      const preview = await f.plugins.preview(descriptor, AbortSignal.timeout(2000));
      let plugin = await f.plugins.install(
        { ...descriptor, reviewedDigest: preview.digest },
        AbortSignal.timeout(2000),
      );
      plugin = await f.plugins.grant(plugin.id, f.bot.id, {
        revision: plugin.revision,
        tools: [{ name: "record_note", mode: "confirm" }],
      });
      plugin = await f.plugins.setEnabled(plugin.id, { revision: plugin.revision, enabled: true });
      pluginInput = {
        pluginId: plugin.id,
        revision: plugin.revision,
        toolName: "record_note",
        arguments: { text: "Only with Owner approval." },
      };
      const run = await f.submit("Record the approved fixture note.");
      let callId = "";
      await vi.waitFor(
        async () => {
          const response = await f.request("/api/v1/plugins");
          expect(response.status).toBe(200);
          const snapshot = (await response.json()) as {
            pendingCalls: { id: string; arguments: unknown }[];
          };
          expect(snapshot.pendingCalls).toHaveLength(1);
          expect(snapshot.pendingCalls[0]?.arguments).toEqual(pluginInput?.arguments);
          callId = snapshot.pendingCalls[0]?.id ?? "";
        },
        { timeout: 4000 },
      );
      expect((await f.native.current(run))?.status).toBe("running");
      expect(effect).not.toHaveBeenCalled();
      expect(model.doGenerateCalls).toHaveLength(1);
      if (decision === "cancel") {
        expect((await f.request(`/api/v1/runs/${run.id}/cancel`, {})).status).toBe(200);
        await f.runner.stop();
        expect((await f.native.current(run))?.status).toBe("cancelled");
      } else {
        expect(
          (await f.request(`/api/v1/plugin-calls/${callId}/decision`, { decision })).status,
        ).toBe(200);
        await f.terminal(run, decision === "approve" ? "completed" : "failed");
      }
      expect(effect).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
      expect(model.doGenerateCalls).toHaveLength(decision === "approve" ? 2 : 1);
      expect((await f.plugins.snapshot()).pendingCalls).toEqual([]);
      if (decision !== "approve")
        expect(
          (await f.store.listMessages(f.channel.id)).filter(
            (message) => message.authorType === "bot",
          ),
        ).toEqual([]);
    },
  );
  it("serves incremental public output before completion without exposing provider reasoning", async () => {
    const finish = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
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
            controller.enqueue({ type: "text-delta", id: "answer", delta: "Draft" });
            void finish.promise.then(() => {
              controller.enqueue({ type: "text-delta", id: "answer", delta: " complete." });
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              controller.close();
            });
          },
        }),
      },
    });
    const f = await fixture(model);
    f.runner.options.streamOutput = true;
    const run = await f.submit();
    await vi.waitFor(
      async () => {
        const response = await f.request(`/api/v1/runs/${run.id}/output`);
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('"text":"Draft"');
        expect(body).not.toContain("PRIVATE REASONING");
      },
      { timeout: 4000 },
    );
    expect((await f.native.current(run))?.status).toBe("running");
    expect(
      (await f.store.listMessages(f.channel.id)).filter((message) => message.authorType === "bot"),
    ).toEqual([]);
    finish.resolve();
    await f.terminal(run, "completed");
    const replies = (await f.store.listMessages(f.channel.id)).filter(
      (message) => message.authorType === "bot",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toBe("Draft complete.");
    expect((await f.native.current(run))?.modelUsage?.steps).toBe(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
