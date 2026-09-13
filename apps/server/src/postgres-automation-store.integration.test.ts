import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStorage } from "./artifact-storage.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import { ModelSettingsService } from "./model-settings.js";
import { NativeAgentRunner } from "./native-agent.js";
import { PostgresAgentStore } from "./postgres-agent-store.js";
import { PostgresAutomationStore } from "./postgres-automation-store.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";

const databaseUrl = process.env.OPENBOT_AUTOMATION_TEST_DATABASE_URL;
// Destructive fixture cleanup is allowed only in an explicitly named disposable loopback database.
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/openbot_automation_test_[a-z0-9_]+$/.test(target.pathname)
  ) {
    throw new Error(
      "Automation integration tests require a dedicated loopback openbot_automation_test_* database.",
    );
  }
}

describe.skipIf(!databaseUrl)("PostgreSQL automation transaction", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
  const peer = databaseUrl ? createDatabase(databaseUrl) : undefined;
  const store = database ? new PostgresAutomationStore(database.db) : undefined;
  const peerStore = peer ? new PostgresAutomationStore(peer.db) : undefined;
  beforeAll(async () => {
    await database?.migrate();
  });
  beforeEach(async () => {
    if (!database) return;
    await database.client`truncate bots, channels cascade`;
    await database.client`insert into bots (id,name,role,computer_profile) values ('test-bot','Test Bot','Assistant','none')`;
    await database.client`insert into channels (id,name) values ('test-channel','automation-test')`;
    await database.client`insert into channel_bots (channel_id,bot_id) values ('test-channel','test-bot')`;
  });
  afterAll(async () => {
    await Promise.all([database?.close(), peer?.close()]);
  });
  async function skillTask() {
    const context = await knowledgeTask("Use the reviewed skill");
    const candidate = await context.control.createEmployeeSkill("test-bot", {
      slug: "reviewed-report",
      name: "Reviewed report",
      description: "Prepare an evidence report",
      version: "1.0.0",
      source: "manual",
      requiredCapabilities: [],
      dependencySkillIds: [],
      evidence: [],
      reason: "Import",
      skillMarkdown:
        "---\nname: reviewed-report\ndescription: Prepare an evidence report\n---\nRead supplied sources before reporting.\n",
    });
    return { ...context, candidate };
  }
  const verifySkill = (sha256?: string) => ({
    state: "verified" as const,
    confidence: 90,
    reason: "Reviewed entire file",
    evidence: [],
    ownerReviewed: true as const,
    ...(sha256 ? { reviewedContentSha256: sha256 } : {}),
  });
  it("keeps skill contents pending until exact digest review and isolates other Bots", async () => {
    if (!database) return;
    const { native, active, control, candidate } = await skillTask();
    expect((await native.skills(active)).skills).toEqual([]);
    await expect(
      control.updateEmployeeSkillState("test-bot", candidate.skill.id, verifySkill()),
    ).rejects.toThrow(/complete current/);
    await expect(
      control.updateEmployeeSkillState("test-bot", candidate.skill.id, verifySkill("f".repeat(64))),
    ).rejects.toThrow();
    await control.updateEmployeeSkillState(
      "test-bot",
      candidate.skill.id,
      verifySkill(candidate.skill.contentSha256),
    );
    const [reference] = (await native.skills(active)).skills;
    if (!reference) throw Error("Missing verified skill");
    expect((await native.readSkill(active, reference)).markdown).toBe(
      candidate.skill.skillMarkdown,
    );
    await expect(native.readSkill({ ...active, botId: "other-bot" }, reference)).rejects.toThrow();
    const events =
      await database.client`select payload from run_events where run_id=${active.id} and type='SKILL_READ'`;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Read supplied sources");
    await native.complete(active, "Completed using reviewed skill", [], undefined, [], [reference]);
    expect((await control.listRuns("test-channel"))[0]?.status).toBe("completed");
  });
  it("invalidates a loaded skill through pause/resume and atomically refuses publication", async () => {
    if (!database) return;
    const { native, active, control, candidate } = await skillTask();
    await control.updateEmployeeSkillState(
      "test-bot",
      candidate.skill.id,
      verifySkill(candidate.skill.contentSha256),
    );
    const [reference] = (await native.skills(active)).skills;
    if (!reference) throw Error("Missing skill");
    await native.readSkill(active, reference);
    await control.updateEmployeeSkillState("test-bot", candidate.skill.id, {
      state: "suspended",
      reason: "Withdraw",
      evidence: [],
      ownerReviewed: true,
    });
    expect((await native.skills(active)).skills).toEqual([]);
    await control.updateEmployeeSkillState(
      "test-bot",
      candidate.skill.id,
      verifySkill(candidate.skill.contentSha256),
    );
    await expect(native.assertSkills(active, [reference])).rejects.toThrow();
    await expect(
      native.complete(active, "Must not publish", [], undefined, [], [reference]),
    ).rejects.toThrow();
    expect((await control.listRuns("test-channel"))[0]?.status).toBe("running");
    const replies =
      await database.client`select id from messages where run_id=${active.id} and author_type='bot'`;
    expect(replies).toHaveLength(0);
  });
  it("makes skill versions immutable and never loads revoked contents", async () => {
    if (!database) return;
    const { native, active, control, candidate } = await skillTask();
    await control.updateEmployeeSkillState(
      "test-bot",
      candidate.skill.id,
      verifySkill(candidate.skill.contentSha256),
    );
    await control.updateEmployeeSkillState("test-bot", candidate.skill.id, {
      state: "revoked",
      reason: "Revoke",
      evidence: [],
      ownerReviewed: true,
    });
    expect((await native.skills(active)).skills).toEqual([]);
    await expect(
      control.updateEmployeeSkillState(
        "test-bot",
        candidate.skill.id,
        verifySkill(candidate.skill.contentSha256),
      ),
    ).rejects.toThrow();
    await database.client`insert into bots(id,name,role) values ('other-bot','Other','Assistant')`;
    await expect(
      control.createEmployeeSkill("other-bot", {
        slug: "reviewed-report",
        name: "Reviewed report",
        description: "Prepare an evidence report",
        version: "1.0.0",
        source: "manual",
        requiredCapabilities: [],
        dependencySkillIds: [],
        evidence: [],
        reason: "Changed",
        skillMarkdown: candidate.skill.skillMarkdown + "Changed",
      }),
    ).rejects.toThrow(/different definition/);
  });

  const command = () => ({
    name: "Scheduled check",
    channelId: "test-channel",
    botId: "test-bot",
    prompt: "Review the channel",
    intervalMinutes: 60,
    firstRunAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  async function makeDue(id: string) {
    if (!database) return;
    await database.client`update automations set next_run_at=now()-interval '2 days' where id=${id}`;
  }

  it("binds the Bot profile and retains sequential model observations in Run projections", async () => {
    if (!database) return;
    const control = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    await database.client`update bots set description='Use sources carefully',profile_revision=4 where id='test-bot'`;
    const task = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Summarize",
    });
    const claimed = await native.claim(task.run, "2020-01-01T00:00:00Z");
    if (!claimed) throw Error("No claim");
    expect(await native.profile(claimed)).toEqual({
      name: "Test Bot",
      role: "Assistant",
      description: "Use sources carefully",
      revision: 4,
    });
    await native.usage(claimed, {
      provider: "openai",
      model: "fixture",
      steps: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
    await native.usage(claimed, {
      provider: "openai",
      model: "fixture",
      steps: 2,
      inputTokens: null,
      outputTokens: 30,
    });
    const rows = await control.listRuns("test-channel");
    expect(rows[0]?.modelUsage).toEqual({
      provider: "openai",
      model: "fixture",
      steps: 2,
      inputTokens: null,
      outputTokens: 30,
    });
    await expect(
      native.usage(claimed, {
        provider: "openai",
        model: "fixture",
        steps: 2,
        inputTokens: 999,
        outputTokens: 999,
      }),
    ).rejects.toThrow();
    await native.complete(claimed, "Done");
    await expect(
      native.usage(claimed, {
        provider: "openai",
        model: "fixture",
        steps: 3,
        inputTokens: 999,
        outputTokens: 999,
      }),
    ).rejects.toThrow();
    const [counts] =
      await database.client`select count(*)::integer as count from run_events where type='MODEL_USAGE_RECORDED'`;
    expect(counts?.count).toBe(2);
  });
  it("cancels queued native tasks once and prevents future claims", async () => {
    if (!database) return;
    const control = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    const task = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Cancel before start",
    });
    expect((await native.cancel(task.run.id)).status).toBe("cancelled");
    expect((await native.cancel(task.run.id)).status).toBe("cancelled");
    expect(await native.claim(task.run, "2020-01-01T00:00:00Z")).toBeUndefined();
    const [counts] =
      await database.client`select count(*)::integer as count from run_events where type='RUN_CANCELLED'`;
    expect(counts?.count).toBe(1);
  });
  it("prevents late completion and failure from replacing a durable cancellation", async () => {
    if (!database) return;
    const control = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    const task = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Cancel active task",
    });
    const claimed = await native.claim(task.run, "2020-01-01T00:00:00Z");
    if (!claimed) throw Error("No claim");
    await native.cancel(claimed.id);
    await expect(native.complete(claimed, "Late answer")).rejects.toThrow();
    expect(await native.fail(claimed)).toBeUndefined();
    const [counts] =
      await database.client`select (select status from runs where id=${claimed.id}) as status,(select count(*) from messages where author_type='bot')::integer as replies,(select count(*) from run_events where type in ('RUN_COMPLETED','RUN_FAILED'))::integer as terminals`;
    expect(counts).toEqual({ status: "cancelled", replies: 0, terminals: 0 });
  });
  it("serializes cancellation against completion and rejects Worker or ended tasks", async () => {
    if (!database || !peer) return;
    const control = new PostgresControlPlaneStore(database.db);
    const native = new PostgresAgentStore(database.db);
    const other = new PostgresAgentStore(peer.db);
    const task = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Race terminal state",
    });
    const claimed = await native.claim(task.run, "2020-01-01T00:00:00Z");
    if (!claimed) throw Error("No claim");
    const outcomes = await Promise.allSettled([
      native.complete(claimed, "Done"),
      other.cancel(claimed.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const [counts] =
      await database.client`select count(*)::integer as count from run_events where type in ('RUN_COMPLETED','RUN_CANCELLED')`;
    expect(counts?.count).toBe(1);
    await expect(native.cancel("unknown")).rejects.toThrow("not found");
    const worker = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Worker cannot be stopped here",
    });
    await database.client`update runs set execution_profile='docker-linux' where id=${worker.run.id}`;
    await expect(native.cancel(worker.run.id)).rejects.toThrow("Only native");
    const failed = await control.submitTask("test-channel", {
      botId: "test-bot",
      content: "Ended task",
    });
    await database.client`update runs set status='failed' where id=${failed.run.id}`;
    await expect(native.cancel(failed.run.id)).rejects.toThrow("already ended");
  });
  it("competing processes create one normal queued Run and advance directly beyond downtime", async () => {
    if (!store || !peerStore || !database) return;
    const schedule = await store.create(command());
    await makeDue(schedule.id);
    const results = await Promise.all([
      store.submitDue(),
      peerStore.submitDue(),
      store.submitDue(),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]?.message.authorType).toBe("system");
    const [next] = await peerStore.list();
    expect(next?.lastOutcome).toBe("submitted");
    expect(new Date(next?.nextRunAt ?? "").getTime()).toBeGreaterThan(Date.now());
    expect(results.flat()[0]?.run).toMatchObject({
      botId: "test-bot",
      channelId: "test-channel",
      executionProfile: "none",
      status: "queued",
      instruction: "Review the channel",
    });
    const [counts] =
      await database.client`select (select count(*) from messages)::integer as messages, (select count(*) from runs)::integer as runs, (select count(*) from run_events where type='AUTOMATION_OCCURRENCE')::integer as occurrences`;
    expect(counts).toEqual({ messages: 1, runs: 1, occurrences: 1 });
    const [event] =
      await database.client`select run_id, payload from run_events where type='AUTOMATION_OCCURRENCE'`;
    expect(event?.payload.automationId).toBe(schedule.id);
    expect(event?.run_id).toBe(next?.lastRunId);
  });

  it("rolls back source Message, Run, audit and timestamp together, then retries exactly once", async () => {
    if (!store || !database) return;
    const schedule = await store.create(command());
    await makeDue(schedule.id);
    await database.client`alter table automations add constraint test_force_rollback check (last_outcome is distinct from 'submitted')`;
    try {
      await expect(store.submitDue()).rejects.toThrow();
      expect((await store.list())[0]?.lastRunId).toBeNull();
      const [counts] =
        await database.client`select (select count(*) from messages)::integer as messages, (select count(*) from runs)::integer as runs`;
      expect(counts).toEqual({ messages: 0, runs: 0 });
    } finally {
      await database.client`alter table automations drop constraint test_force_rollback`;
    }
    expect(await store.submitDue()).toHaveLength(1);
    expect(await store.submitDue()).toHaveLength(0);
  });

  it("skips an unfinished previous Run, preserves it on pause/delete, and resumes in the future", async () => {
    if (!store || !database) return;
    const schedule = await store.create(command());
    await makeDue(schedule.id);
    const [submitted] = await store.submitDue();
    await makeDue(schedule.id);
    expect(await store.submitDue()).toHaveLength(0);
    expect((await store.list())[0]?.lastOutcome).toBe("skipped_active");
    await store.setEnabled(schedule.id, false);
    await makeDue(schedule.id);
    expect(await store.submitDue()).toHaveLength(0);
    const resumed = await store.setEnabled(schedule.id, true);
    expect(new Date(resumed.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    await store.delete(schedule.id);
    const [run] =
      await database.client`select status from runs where id=${submitted?.run.id ?? ""}`;
    expect(run?.status).toBe("queued");
    expect(await store.list()).toHaveLength(0);
  });

  it("pauses missing membership without switching Bot and revalidates membership on resume", async () => {
    if (!store || !database) return;
    await expect(store.create({ ...command(), botId: "other" })).rejects.toThrow("belong");
    const schedule = await store.create(command());
    await makeDue(schedule.id);
    await database.client`delete from channel_bots where bot_id='test-bot'`;
    expect(await store.submitDue()).toHaveLength(0);
    expect((await store.list())[0]).toMatchObject({
      enabled: false,
      lastOutcome: "target_unavailable",
      lastRunId: null,
    });
    await expect(store.setEnabled(schedule.id, true)).rejects.toThrow("belong");
  });

  it("reuses interactive task membership and source-Run semantics", async () => {
    if (!database) return;
    const interactive = new PostgresControlPlaneStore(database.db);
    await expect(
      interactive.submitTask("test-channel", { content: "Test", botId: "missing" }),
    ).rejects.toThrow("member");
    const task = await interactive.submitTask("test-channel", {
      content: "Test",
      botId: "test-bot",
    });
    expect(task.message.authorType).toBe("human");
    expect(task.message.runId).toBe(task.run.id);
    expect(task.run.sourceMessageId).toBe(task.message.id);
  });

  it("bounds start dates and serializes the 50-record limit", async () => {
    if (!store || !peerStore || !database) return;
    await expect(
      store.create({ ...command(), firstRunAt: "2020-01-01T00:00:00Z" }),
    ).rejects.toThrow("366 days");
    await expect(
      store.create({ ...command(), firstRunAt: "2200-01-01T00:00:00Z" }),
    ).rejects.toThrow("366 days");
    const rows = Array.from({ length: 49 }, () => ({
      id: randomUUID(),
      name: "Test",
      channel_id: "test-channel",
      bot_id: "test-bot",
      prompt: "Check",
      interval_minutes: 60,
      next_run_at: new Date(Date.now() + 3600_000).toISOString(),
    }));
    await database.client`insert into automations ${database.client(rows)}`;
    const attempts = await Promise.allSettled([
      store.create(command()),
      peerStore.create(command()),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.list()).toHaveLength(50);
  });
  it("native claims exclude pre-opt-in and Worker tasks and serialize each channel", async () => {
    if (!database || !peer) return;
    const native = new PostgresAgentStore(database.db),
      competing = new PostgresAgentStore(peer.db);
    const control = new PostgresControlPlaneStore(database.db);
    const first = (
      await control.submitTask("test-channel", { content: "First", botId: "test-bot" })
    ).run;
    const second = (
      await control.submitTask("test-channel", { content: "Second", botId: "test-bot" })
    ).run;
    expect(await native.queued("2200-01-01T00:00:00Z")).toHaveLength(0);
    expect(await native.claim(first, "2200-01-01T00:00:00Z")).toBeUndefined();
    const attempts = await Promise.all([
      native.claim(first, "2000-01-01T00:00:00Z"),
      competing.claim(first, "2000-01-01T00:00:00Z"),
      competing.claim(second, "2000-01-01T00:00:00Z"),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const active = attempts.find((value) => value !== undefined);
    if (!active) throw new Error("Fixture did not claim.");
    expect(active.nodeId).toBeUndefined();
    expect(await control.failRunningRuns()).toHaveLength(1);
    expect(await native.claim(active, "2000-01-01T00:00:00Z")).toBeUndefined();
    await database.client`update runs set execution_profile='docker-linux' where status='queued'`;
    expect(await native.queued("2000-01-01T00:00:00Z")).toHaveLength(0);
    expect(await native.claim(second, "2000-01-01T00:00:00Z")).toBeUndefined();
  });

  it("native observations stay in the claimed channel and completion/audit commit once", async () => {
    if (!database) return;
    const native = new PostgresAgentStore(database.db),
      control = new PostgresControlPlaneStore(database.db);
    await database.client`insert into channels (id,name) values ('private-channel','Private')`;
    await database.client`insert into messages (id,channel_id,author_type,content,created_at) values ('private-message','private-channel','human','OTHER_CHANNEL_SECRET',now()-interval '1 minute'), ('earlier-message','test-channel','human','Launch Tuesday',now()-interval '1 minute')`;
    const task = await control.submitTask("test-channel", {
      content: "Summarize",
      botId: "test-bot",
    });
    const active = await native.claim(task.run, "2000-01-01T00:00:00Z");
    expect(active).toBeDefined();
    if (!active) return;
    await database.client`insert into messages (id,channel_id,author_type,content,created_at) values ('future-message','test-channel','human','FUTURE_SECRET',now()+interval '1 minute')`;
    const context = JSON.stringify(await native.context(active));
    expect(context).toContain("Launch Tuesday");
    expect(context).not.toMatch(/OTHER_CHANNEL_SECRET|FUTURE_SECRET/);
    await native.progress(active, "planning", "Model step 1.");
    expect((await control.listRunProgress("test-channel"))[0]).toMatchObject({
      stage: "planning",
      runId: active.id,
    });
    expect((await control.listRunProgress("test-channel"))[0]?.nodeId).toBeUndefined();
    await database.client`alter table messages add constraint test_agent_rollback check (author_type <> 'bot')`;
    try {
      await expect(native.complete(active, "Launch Tuesday.")).rejects.toThrow();
      await native.assertScope(active);
      const [counts] =
        await database.client`select count(*)::integer as count from run_events where type='RUN_COMPLETED'`;
      expect(counts?.count).toBe(0);
    } finally {
      await database.client`alter table messages drop constraint test_agent_rollback`;
    }
    const result = await native.complete(active, "Launch Tuesday.");
    expect(result.run.status).toBe("completed");
    expect(result.message).toMatchObject({
      authorType: "bot",
      authorId: active.botId,
      runId: active.id,
      replyToMessageId: task.message.id,
    });
    await expect(native.complete(active, "Duplicate")).rejects.toThrow();
    const [counts] =
      await database.client`select (select count(*) from messages where author_type='bot')::integer as replies, (select count(*) from run_events where type='RUN_COMPLETED')::integer as completed`;
    expect(counts).toEqual({ replies: 1, completed: 1 });
  });

  it("native reads and completion fail closed after Bot membership is removed", async () => {
    if (!database) return;
    const native = new PostgresAgentStore(database.db),
      control = new PostgresControlPlaneStore(database.db);
    const task = await control.submitTask("test-channel", { content: "Review", botId: "test-bot" });
    const active = await native.claim(task.run, "2000-01-01T00:00:00Z");
    if (!active) throw new Error("Fixture did not claim.");
    await database.client`delete from channel_bots`;
    await expect(native.context(active)).rejects.toMatchObject({ code: "scope_revoked" });
    await expect(native.tasks(active)).rejects.toMatchObject({ code: "scope_revoked" });
    await expect(native.complete(active, "Invalid reply")).rejects.toMatchObject({
      code: "scope_revoked",
    });
    expect((await native.fail(active))?.status).toBe("failed");
  });
  it("commits a source-based report with its reply, artifact and audit, with no duplicate publication", async () => {
    if (!database) return;
    const native = new PostgresAgentStore(database.db);
    const control = new PostgresControlPlaneStore(database.db);
    const directory = await mkdtemp(join(tmpdir(), "openbot-report-e2e-"));
    const storage = new FileArtifactStorage(join(directory, "objects"));
    const settings = new ModelSettingsService(
      join(directory, "model.json"),
      "a".repeat(64),
      async () => Response.json({ id: "fixture-model" }),
    );
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step++;
        if (step <= 2)
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call-${step}`,
                toolName: step === 1 ? "read_public_page" : "write_report",
                input:
                  step === 1
                    ? '{"sourceIndex":0}'
                    : '{"name":"findings.md","markdown":"# Findings\\nLaunch is Tuesday."}',
              },
            ],
            usage,
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            warnings: [],
          };
        return {
          content: [{ type: "text", text: "The report is attached." }],
          usage,
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
        };
      },
    });
    const completed = vi.fn();
    const runner = new NativeAgentRunner(
      native,
      settings,
      new ChannelRealtimeHub(),
      vi.fn(),
      () => model,
      {
        artifacts: storage,
        readSource: async (url) => ({
          url,
          text: "Launch is Tuesday.",
          fetchedAt: "2026-09-08T00:00:00.000Z",
          truncated: false,
        }),
        onCompleted: completed,
      },
    );
    try {
      await settings.save({
        provider: "openai",
        model: "fixture-model",
        apiKey: "fixture-key-not-real",
        revision: null,
        agentEnabled: true,
      });
      const task = await control.submitTask("test-channel", {
        content: "Read https://example.com/research and write a report",
        botId: "test-bot",
      });
      runner.start();
      await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
      const artifacts = await control.listArtifacts(task.run.id);
      expect(artifacts).toHaveLength(1);
      const artifact = artifacts[0];
      if (!artifact) throw new Error("Report artifact missing.");
      expect(artifact).toMatchObject({
        runId: task.run.id,
        name: "findings.md",
        mediaType: "text/markdown",
      });
      const record = await control.getArtifact(artifact.id);
      if (!record) throw new Error("Report record missing.");
      const text = (await storage.read(record.storageKey)).toString("utf8");
      expect(text).toContain("Launch is Tuesday.");
      expect(text).toContain("https://example.com/research");
      expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Launch is Tuesday.");
      const [counts] =
        await database.client`select (select count(*) from messages where run_id=${task.run.id} and author_type='bot')::integer as replies, (select count(*) from artifacts where run_id=${task.run.id})::integer as artifacts, (select count(*) from run_events where run_id=${task.run.id} and type='RUN_COMPLETED')::integer as completed`;
      expect(counts).toEqual({ replies: 1, artifacts: 1, completed: 1 });
      await expect(native.complete(task.run, "Duplicate")).rejects.toThrow();
    } finally {
      await runner.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a native report when terminal artifact insertion fails", async () => {
    if (!database) return;
    const native = new PostgresAgentStore(database.db);
    const control = new PostgresControlPlaneStore(database.db);
    const task = await control.submitTask("test-channel", {
      content: "Write a report",
      botId: "test-bot",
    });
    const active = await native.claim(task.run, "2000-01-01T00:00:00Z");
    if (!active) throw new Error("Fixture did not claim.");
    const artifact = {
      id: randomUUID(),
      runId: active.id,
      name: "report.md",
      mediaType: "text/markdown",
      sha256: "a".repeat(64),
      sizeBytes: 10,
      createdAt: new Date().toISOString(),
    };
    const record = { artifact, storageKey: `runs/${active.id}/${artifact.id}.md`, metadata: {} };
    await expect(
      native.complete(active, "Wrong scope", [
        { ...record, artifact: { ...artifact, runId: "other" } },
      ]),
    ).rejects.toThrow("belong");
    await database.client`alter table artifacts add constraint test_report_rollback check (media_type <> 'text/markdown')`;
    try {
      await expect(native.complete(active, "Report prepared", [record])).rejects.toThrow();
      await native.assertScope(active);
      const [counts] =
        await database.client`select (select count(*) from messages where author_type='bot')::integer as replies, (select count(*) from artifacts)::integer as artifacts, (select count(*) from run_events where type='RUN_COMPLETED')::integer as completed`;
      expect(counts).toEqual({ replies: 0, artifacts: 0, completed: 0 });
    } finally {
      await database.client`alter table artifacts drop constraint test_report_rollback`;
    }
  });

  it("runs a newly submitted task through SDK observation and persists its final Bot reply", async () => {
    if (!database) return;
    const native = new PostgresAgentStore(database.db),
      control = new PostgresControlPlaneStore(database.db);
    const directory = await mkdtemp(join(tmpdir(), "openbot-agent-e2e-"));
    const settings = new ModelSettingsService(
      join(directory, "model.json"),
      "a".repeat(64),
      async () => Response.json({ id: "fixture-model" }),
    );
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ++step === 1
          ? {
              content: [
                {
                  type: "tool-call",
                  toolName: "read_channel_context",
                  toolCallId: "call-1",
                  input: "{}",
                },
              ],
              usage,
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              warnings: [],
            }
          : {
              content: [{ type: "text", text: "The channel is ready." }],
              usage,
              finishReason: { unified: "stop", raw: "stop" },
              warnings: [],
            },
    });
    const errors = vi.fn();
    const runner = new NativeAgentRunner(
      native,
      settings,
      new ChannelRealtimeHub(),
      errors,
      () => model,
    );
    try {
      await settings.save({
        provider: "openai",
        model: "fixture-model",
        apiKey: "fixture-key-not-real",
        revision: null,
        agentEnabled: true,
      });
      const task = await control.submitTask("test-channel", {
        content: "Read this channel",
        botId: "test-bot",
      });
      runner.start();
      await vi.waitFor(async () => {
        const [row] = await database.client`select status from runs where id=${task.run.id}`;
        expect(row?.status).toBe("completed");
      });
      const [reply] =
        await database.client`select author_type, content from messages where run_id=${task.run.id} and author_type='bot'`;
      expect(reply).toEqual({ author_type: "bot", content: "The channel is ready." });
      expect(model.doGenerateCalls).toHaveLength(2);
      expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("Read this channel");
      expect((await control.listRunProgress("test-channel")).map((event) => event.stage)).toContain(
        "observation",
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function knowledgeTask(content = "Retain a reusable lesson") {
    if (!database) throw new Error("Missing disposable database.");
    const native = new PostgresAgentStore(database.db);
    const control = new PostgresControlPlaneStore(database.db);
    const task = await control.submitTask("test-channel", { content, botId: "test-bot" });
    const active = await native.claim(task.run, "2000-01-01T00:00:00Z");
    if (!active) throw new Error("Task claim failed.");
    return { native, control, active, knowledge: new PostgresKnowledgeStore(database.db) };
  }
  const lesson = {
    kind: "procedural" as const,
    title: "Cite evidence",
    content: "Separate facts from inference and retain source URLs.",
  };

  it("keeps legacy memory private, rejects secret sharing and isolates the assigned Bot", async () => {
    if (!database) return;
    const { native, control, active } = await knowledgeTask();
    const privateMemory = await control.createEmployeeMemory("test-bot", {
      kind: "semantic",
      title: "Private",
      content: "Owner only",
      sensitivity: "internal",
      portability: "never",
    });
    expect(privateMemory.memory.modelUseEnabled).toBe(false);
    expect((await native.knowledge(active)).memories).toEqual([]);
    await expect(
      control.updateEmployeeMemory("test-bot", privateMemory.memory.id, {
        expectedRevision: 1,
        modelUseEnabled: true,
        sensitivity: "confidential",
      }),
    ).rejects.toThrow(/Only public/);
    const shared = await control.updateEmployeeMemory("test-bot", privateMemory.memory.id, {
      expectedRevision: 1,
      modelUseEnabled: true,
    });
    await database.client`insert into bots (id,name,role) values ('other-bot','Other','Other')`;
    await control.createEmployeeMemory("other-bot", {
      kind: "semantic",
      title: "Other secret",
      content: "Other Bot context",
      sensitivity: "internal",
      portability: "never",
      modelUseEnabled: true,
    });
    expect((await native.knowledge(active)).memories).toEqual([
      expect.objectContaining({ id: shared.memory.id, revision: 2, content: "Owner only" }),
    ]);
    expect(shared.event.changedFields).toEqual(["modelUseEnabled"]);
    await native.assertKnowledge(active, [{ id: shared.memory.id, revision: 2 }]);
    await expect(
      native.assertKnowledge({ ...active, botId: "other-bot" }, [
        { id: shared.memory.id, revision: 2 },
      ]),
    ).rejects.toThrow();
  });

  it("keeps a completed-task proposal inactive until Owner review and explicit sharing, with source provenance", async () => {
    if (!database) return;
    const first = await knowledgeTask();
    await first.native.complete(first.active, "Proposed for review", [], lesson);
    const [proposal] = await first.knowledge.list("test-bot");
    if (!proposal) throw new Error("Proposal missing.");
    expect(proposal).toMatchObject({ ...lesson, sourceRunId: first.active.id });
    const next = await knowledgeTask("Use approved knowledge");
    expect((await next.native.knowledge(next.active)).memories).toEqual([]);
    const accepted = await first.knowledge.review("test-bot", proposal.id, {
      decision: "accept",
      ownerReviewed: true,
      title: "Reviewed evidence",
      content: "Use sources and label inference.",
      modelUseEnabled: false,
    });
    expect((await next.native.knowledge(next.active)).memories).toEqual([]);
    if (!accepted.memoryId) throw new Error("Memory missing.");
    const profile = await next.control.getEmployeeProfile("test-bot");
    expect(profile.memories[0]).toMatchObject({
      id: accepted.memoryId,
      title: "Reviewed evidence",
      content: "Use sources and label inference.",
      provenance: { sourceRunId: first.active.id, proposalId: proposal.id, actor: "owner" },
      modelUseEnabled: false,
    });
    await next.control.updateEmployeeMemory("test-bot", accepted.memoryId, {
      expectedRevision: 1,
      modelUseEnabled: true,
    });
    const snapshot = await next.native.knowledge(next.active);
    expect(snapshot.memories).toEqual([
      expect.objectContaining({
        id: accepted.memoryId,
        revision: 2,
        sourceRunId: first.active.id,
        content: "Use sources and label inference.",
      }),
    ]);
    await next.native.complete(
      next.active,
      "Used reviewed evidence",
      [],
      undefined,
      snapshot.memories,
    );
    const audits =
      await database.client`select type,payload from run_events where run_id=${next.active.id} and type='KNOWLEDGE_READ'`;
    expect(JSON.stringify(audits)).not.toContain("Use sources");
    expect(JSON.stringify(audits)).toContain(accepted.memoryId);
    expect(await first.knowledge.list("test-bot")).toEqual([]);
  });

  it("serializes competing reviews into exactly one memory and one content-free decision", async () => {
    if (!database || !peer) return;
    const { native, active, knowledge } = await knowledgeTask();
    await native.complete(active, "Done", [], lesson);
    const [proposal] = await knowledge.list("test-bot");
    if (!proposal) throw new Error("Missing proposal.");
    const input = {
      decision: "accept" as const,
      ownerReviewed: true as const,
      title: lesson.title,
      content: lesson.content,
      modelUseEnabled: true,
    };
    const outcomes = await Promise.allSettled([
      knowledge.review("test-bot", proposal.id, input),
      new PostgresKnowledgeStore(peer.db).review("test-bot", proposal.id, input),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const memories = await database.client`select id from employee_memories`;
    expect(memories).toHaveLength(1);
    const events =
      await database.client`select payload from run_events where type='KNOWLEDGE_PROPOSAL_REVIEWED'`;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(lesson.content);
    const [row] =
      await database.client`select title,content,status from knowledge_proposals where id=${proposal.id}`;
    expect(row).toEqual({ title: "", content: "", status: "accepted" });
  });

  it("rejects cross-Bot review and removes rejected candidate text without creating memory", async () => {
    if (!database) return;
    const { native, active, knowledge } = await knowledgeTask();
    await native.complete(active, "Done", [], lesson);
    const [proposal] = await knowledge.list("test-bot");
    if (!proposal) throw new Error("Missing proposal.");
    await expect(
      knowledge.review("other-bot", proposal.id, { decision: "reject", ownerReviewed: true }),
    ).rejects.toThrow(/not found/);
    await knowledge.review("test-bot", proposal.id, { decision: "reject", ownerReviewed: true });
    await expect(
      knowledge.review("test-bot", proposal.id, { decision: "reject", ownerReviewed: true }),
    ).rejects.toThrow(/already/);
    expect(await database.client`select id from employee_memories`).toHaveLength(0);
    expect(
      (await database.client`select title,content,status from knowledge_proposals`)[0],
    ).toEqual({ title: "", content: "", status: "rejected" });
  });

  it("publishes no proposal after cancellation and no reply after memory sharing is revoked", async () => {
    if (!database) return;
    const first = await knowledgeTask();
    await first.native.cancel(first.active.id);
    await expect(first.native.complete(first.active, "Late result", [], lesson)).rejects.toThrow();
    expect(await first.knowledge.list("test-bot")).toEqual([]);
    const next = await knowledgeTask();
    const memory = await next.control.createEmployeeMemory("test-bot", {
      kind: "semantic",
      title: "Shared",
      content: "Shared fact",
      sensitivity: "internal",
      portability: "never",
      modelUseEnabled: true,
    });
    const snapshot = await next.native.knowledge(next.active);
    await next.control.updateEmployeeMemory("test-bot", memory.memory.id, {
      expectedRevision: 1,
      modelUseEnabled: false,
    });
    await expect(
      next.native.complete(next.active, "Late result", [], lesson, snapshot.memories),
    ).rejects.toMatchObject({ code: "memory_changed" });
    expect(
      await database.client`select id from messages where run_id=${next.active.id} and author_type='bot'`,
    ).toHaveLength(0);
    expect(await next.knowledge.list("test-bot")).toEqual([]);
    expect(
      (await database.client`select status from runs where id=${next.active.id}`)[0]?.status,
    ).toBe("running");
  });

  it("caps pending lessons transactionally without losing the completed history", async () => {
    if (!database) return;
    for (let index = 0; index < 50; index++) {
      const task = await knowledgeTask(`Lesson ${index}`);
      await task.native.complete(task.active, "Done", [], { ...lesson, title: `Lesson ${index}` });
    }
    const overflow = await knowledgeTask("Overflow");
    await expect(
      overflow.native.complete(overflow.active, "Done", [], lesson),
    ).rejects.toMatchObject({ code: "task_limit" });
    expect(await overflow.knowledge.list("test-bot")).toHaveLength(50);
    expect(
      (
        await database.client`select count(*)::integer as count from runs where status='completed'`
      )[0]?.count,
    ).toBe(50);
    expect(
      await database.client`select id from messages where run_id=${overflow.active.id} and author_type='bot'`,
    ).toHaveLength(0);
    // This case executes 51 real, sequential task/claim/completion transactions.
  }, 15_000);
});
