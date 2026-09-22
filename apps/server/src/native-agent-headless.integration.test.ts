import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import type { Artifact, Bot, Channel, Run } from "@openbot/domain";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { FileArtifactStorage } from "./artifact-storage.js";
import { type ChannelAttachment, FileChannelAttachmentStorage } from "./channel-attachments.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import type { ModelSettingsService } from "./model-settings.js";
import { NativeAgentRunner } from "./native-agent.js";
import { OwnerAuthService } from "./owner-auth.js";
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

  async function fixture(model: MockLanguageModelV4) {
    if (!database) throw new Error("Missing disposable database.");
    const directory = await mkdtemp(join(tmpdir(), "openbot-headless-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    const artifacts = new FileArtifactStorage(directory);
    const attachments = new FileChannelAttachmentStorage(join(directory, "attachments"));
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
      attachments,
    });
    cleanups.push(() => runner.stop());
    const origin = "http://localhost:5173";
    const app = createApp({
      store,
      auth,
      requestThrottle,
      realtime,
      artifactStorage: artifacts,
      attachments,
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
    const upload = async (name: string, text: string) => {
      const response = await app.request(`/api/v1/channels/${channel.id}/attachments`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/octet-stream",
          "x-openbot-filename": encodeURIComponent(name),
        },
        body: text,
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { attachment: ChannelAttachment }).attachment;
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
      upload,
    };
  }

  it("submits through the Owner API and downloads the committed report without a client UI", async () => {
    const f = await fixture(
      new MockLanguageModelV4({
        doGenerate: [
          call("write_report", {
            name: "result.md",
            markdown: "# Fixture result\nVerified local task.",
          }),
          answer(),
        ],
      }),
    );
    const run = await f.submit();
    await f.terminal(run, "completed");
    const artifacts = await f.store.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    const download = await f.request(`/api/v1/artifacts/${artifacts[0]?.id}/content`);
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("Verified local task.");
    expect(
      (await f.store.listMessages(f.channel.id)).filter((message) => message.authorType === "bot"),
    ).toHaveLength(1);
  });

  it("retains uploaded input identity and cumulative reads in one appendix after a correction", async () => {
    const responses: Array<ReturnType<typeof call> | ReturnType<typeof answer>> = [];
    const model = new MockLanguageModelV4({ doGenerate: async () => responses.shift()! });
    const f = await fixture(model);
    const text = "销量😀=12\n成本=7";
    const read = await f.upload("sales.txt", text);
    const unread = await f.upload("unread.txt", "Never returned to the model");
    responses.push(
      call("read_attachment", { attachmentId: read.id, limit: 5 }),
      call("write_report", { name: "sales.md", markdown: "# Sales fixture\nSynthetic findings." }),
      answer("Initial summary"),
      call("read_attachment", { attachmentId: read.id, offset: 5 }),
      answer("Completed after correction"),
    );
    const complete = f.native.complete.bind(f.native);
    let corrected = false;
    vi.spyOn(f.native, "complete").mockImplementation(async (...args) => {
      if (!corrected) {
        corrected = true;
        await f.native.steer(args[0].id, "Read the remaining attachment text before finishing.");
      }
      return complete(...args);
    });
    const run = await f.submit(
      `Prepare a report. [OpenBot attachment: ${read.id}] [OpenBot attachment: ${unread.id}]`,
    );
    await f.terminal(run, "completed");
    const artifacts = await f.store.listArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    const response = await f.request(`/api/v1/artifacts/${artifacts[0]?.id}/content`);
    expect(response.status).toBe(200);
    const report = await response.text();
    expect(report.match(/Attachment inputs recorded by OpenBot/g)).toHaveLength(1);
    expect(report).toContain(read.sha256);
    expect(report).toContain(`UTF-16 ranges [0, ${text.length})`);
    expect(report).not.toContain(unread.id);
    expect(report).toContain("returned-text coverage complete");
    if (!database) throw new Error("Missing database.");
    const [row] = await database.client`select metadata from artifacts where run_id = ${run.id}`;
    expect(row?.metadata.attachments).toMatchObject([
      {
        attachmentId: read.id,
        sha256: read.sha256,
        delivery: "text_tool_result",
        totalCharacters: text.length,
        ranges: [{ start: 0, end: text.length }],
        returnedTextComplete: true,
      },
    ]);
    expect(row?.metadata.attachments).toHaveLength(1);
    expect((await f.native.current(run))?.modelUsage?.steps).toBe(5);
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
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
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
    await vi.waitFor(() => expect(model.doGenerateCalls).toHaveLength(1));
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
  });
});
