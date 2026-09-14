import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@openbot/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FileChannelAttachmentStorage } from "./channel-attachments.js";
import { attachmentIsReferenced } from "./postgres-attachment-references.js";
import { PostgresAutomationStore } from "./postgres-automation-store.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";
import { TaskAttachmentReferences } from "./task-attachment-references.js";

const databaseUrl = process.env.OPENBOT_ATTACHMENT_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/openbot_attachment_test_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error(
      "Attachment integration tests require a dedicated loopback openbot_attachment_test_* database.",
    );
}

describe.skipIf(!databaseUrl)("shared task attachment lifecycle in PostgreSQL", () => {
  const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
  function connection() {
    if (!database) throw new Error("An isolated PostgreSQL fixture is required.");
    return database;
  }
  const channelId = randomUUID(),
    botId = randomUUID();
  let root: string;
  let storage: FileChannelAttachmentStorage;
  let references: TaskAttachmentReferences;
  let schedules: PostgresAutomationStore;
  beforeAll(async () => {
    await database?.migrate();
  });
  beforeEach(async () => {
    if (!database) return;
    root = await mkdtemp(join(tmpdir(), "openbot-schedule-attachments-"));
    storage = new FileChannelAttachmentStorage(root);
    references = new TaskAttachmentReferences(storage);
    schedules = new PostgresAutomationStore(database.db, references);
    await database.client`truncate bots, channels cascade`;
    await database.client`insert into bots(id,name,role,computer_profile) values(${botId},'Fixture','Assistant','none')`;
    await database.client`insert into channels(id,name) values(${channelId},'Fixture')`;
    await database.client`insert into channel_bots(channel_id,bot_id) values(${channelId},${botId})`;
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await database?.close();
  });
  const input = (id: string) => ({
    name: "Read evidence",
    channelId,
    botId,
    prompt: `[OpenBot attachment: ${id}]`,
    intervalMinutes: 15,
    firstRunAt: new Date(Date.now() + 60_000).toISOString(),
  });
  async function due(id: string) {
    await connection()
      .client`update automations set next_run_at=now()-interval '1 minute' where id=${id}`;
  }
  const clean = () =>
    storage.cleanup(channelId, new Date(Date.now() + 60_000).toISOString(), (id) =>
      attachmentIsReferenced(connection().db, channelId, id),
    );

  it("retains future and paused schedule references until deletion, without any Run", async () => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    const schedule = await schedules.create(input(file.id));
    await storage.setDeleted(channelId, file.id, true);
    expect(await clean()).toEqual({ removed: 0, retained: 1 });
    await schedules.setEnabled(schedule.id, false);
    expect(await clean()).toEqual({ removed: 0, retained: 1 });
    await schedules.delete(schedule.id);
    expect(await clean()).toEqual({ removed: 1, retained: 0 });
  });
  it("rejects cross-channel, soft-deleted and oversized reference sets before persisting", async () => {
    const file = await storage.persist(randomUUID(), "outside.txt", Buffer.from("evidence"));
    await expect(schedules.create(input(file.id))).rejects.toThrow();
    const local = await storage.persist(channelId, "local.txt", Buffer.from("evidence"));
    await storage.setDeleted(channelId, local.id, true);
    await expect(schedules.create(input(local.id))).rejects.toThrow(/deleted/);
    await expect(
      schedules.create({
        ...input(local.id),
        prompt: Array.from({ length: 9 }, () => `[OpenBot attachment: ${randomUUID()}]`).join(" "),
      }),
    ).rejects.toThrow(/At most 8/);
    expect(await schedules.list()).toHaveLength(0);
  });
  it("submits a valid scheduled file and retains its historical Run after schedule deletion", async () => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    const schedule = await schedules.create(input(file.id));
    await due(schedule.id);
    const submitted = await schedules.submitDue();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.run.instruction).toContain(file.id);
    expect(submitted[0]?.message.authorType).toBe("system");
    await schedules.delete(schedule.id);
    await storage.setDeleted(channelId, file.id, true);
    expect(await clean()).toEqual({ removed: 0, retained: 1 });
  });
  it("pauses an invalid occurrence, rejects resume, then allows explicit resume after restoration", async () => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    const schedule = await schedules.create(input(file.id));
    await storage.setDeleted(channelId, file.id, true);
    await due(schedule.id);
    expect(await schedules.submitDue()).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({
      enabled: false,
      lastOutcome: "attachment_unavailable",
      lastRunId: null,
    });
    const events = await connection()
      .client`select payload from run_events where type='AUTOMATION_OCCURRENCE'`;
    expect(events[0]?.payload.outcome).toBe("attachment_unavailable");
    expect(JSON.stringify(events)).not.toContain(root);
    await expect(schedules.setEnabled(schedule.id, true)).rejects.toThrow(/deleted/);
    await storage.setDeleted(channelId, file.id, false);
    await schedules.setEnabled(schedule.id, true);
    await due(schedule.id);
    expect(await schedules.submitDue()).toHaveLength(1);
  });
  it.each(["missing", "corrupt"])("does not submit a %s attachment", async (condition) => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    const schedule = await schedules.create(input(file.id));
    if (condition === "missing") await rm(join(root, `${file.id}.bin`));
    else await writeFile(join(root, `${file.id}.bin`), "tampered");
    await due(schedule.id);
    expect(await schedules.submitDue()).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({
      enabled: false,
      lastOutcome: "attachment_unavailable",
    });
    expect(await connection().client`select id from messages`).toHaveLength(0);
  });
  it("stops a scheduled processed document when its derived text is missing", async () => {
    const file = await storage.persist(channelId, "evidence.docx", Buffer.from([80, 75, 3, 4]));
    await storage.saveDerived(channelId, file.id, {
      sha256: file.sha256,
      text: "Evidence",
      operation: "extract",
      processedAt: new Date().toISOString(),
      truncated: false,
    });
    const schedule = await schedules.create(input(file.id));
    await rm(join(root, `${file.id}.text.json`));
    await due(schedule.id);
    expect(await schedules.submitDue()).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({
      enabled: false,
      lastOutcome: "attachment_unavailable",
    });
  });
  it("serializes reference persistence and cleanup in file-before-DB order", async () => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const control = new PostgresControlPlaneStore(connection().db);
    const submitting = references.withActive(channelId, input(file.id).prompt, async () => {
      entered();
      await held;
      return control.submitTask(channelId, { content: input(file.id).prompt, botId });
    });
    await started;
    const deleting = storage.setDeleted(channelId, file.id, true);
    const cleaning = clean();
    release();
    const [result, , cleanup] = await Promise.all([submitting, deleting, cleaning]);
    expect(result.run.instruction).toContain(file.id);
    expect(cleanup).toEqual({ removed: 0, retained: 1 });
  });
  it("retains schedule authority when membership is revoked and never creates a Run", async () => {
    const file = await storage.persist(channelId, "evidence.txt", Buffer.from("evidence"));
    const schedule = await schedules.create(input(file.id));
    await connection()
      .client`delete from channel_bots where channel_id=${channelId} and bot_id=${botId}`;
    await due(schedule.id);
    expect(await schedules.submitDue()).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({
      enabled: false,
      lastOutcome: "target_unavailable",
    });
    await storage.setDeleted(channelId, file.id, true);
    expect(await clean()).toEqual({ removed: 0, retained: 1 });
  });
});
