import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  attachmentPurgeSchema,
  attachmentReferencesSchema,
  botResponseSchema,
  channelAttachmentResponseSchema,
  channelAttachmentsResponseSchema,
  channelResponseSchema,
  controlHttpErrorSchema,
  employeeModelResponseSchema,
  modelConnectionDeletionConflictSchema,
  modelConnectionDeletionSchema,
  modelConnectionResponseSchema,
  modelServicesSnapshotSchema,
  ownerAttachmentResponseSchema,
  ownerAttachmentsResponseSchema,
  ownerPreferencesSchema,
  storageSettingsSchema,
  storageTrashCleanupSchema,
  storageUsageSchema,
  submitTaskResponseSchema,
  transcriptionSettingsSchema,
  trashCleanupSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import { type ContractTarget, contractTargetSchema } from "./target.ts";

/** Synthetic keys are stored locally; no successful discovery/test/transcription request is sent. */
export async function runResourceContracts(input: ContractTarget) {
  const target = contractTargetSchema.parse(input);
  const client = contractClient(target);
  const { request } = client;
  const passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    controlHttpErrorSchema.parse(result.body);
    return result;
  };
  for (const path of [
    "/api/v1/model-services",
    "/api/v1/storage",
    "/api/v1/settings/storage",
    "/api/v1/settings/transcription",
    "/api/v1/task-attachments",
  ]) {
    await check(`unauthenticated ${path}`, () =>
      error(path, 401, { cookie: false }).then(() => {}),
    );
  }
  await check("upload authorization precedes raw-byte validation", async () => {
    await error("/api/v1/task-attachments", 401, {
      method: "POST",
      cookie: false,
      bytes: new Uint8Array([128]),
      filename: "fixture.txt",
    });
    await error("/api/v1/task-attachments", 403, {
      method: "POST",
      origin: "https://foreign.invalid",
      bytes: new Uint8Array([128]),
      filename: "fixture.txt",
    });
  });
  const apiKey = `synthetic-only-${randomUUID()}`;
  const connectionInput = {
    name: " Synthetic connection ",
    presetId: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    defaultModel: " synthetic-model ",
  };
  const services = async () => {
    const result = await request("/api/v1/model-services");
    assert.equal(result.response.status, 200);
    assert(!JSON.stringify(result.body).includes(apiKey));
    return modelServicesSnapshotSchema.parse(result.body);
  };
  await check("model catalog is a secret-free public projection", async () => {
    assert((await services()).presets.some((item) => item.id === "openai"));
  });
  await check(
    "operator endpoint policy refuses unapproved create and verify before network",
    async () => {
      await error("/api/v1/model-connections", 422, {
        method: "POST",
        body: { ...connectionInput, baseUrl: "https://unapproved.invalid/v1" },
      });
      await error("/api/v1/model-connections/verify", 422, {
        method: "POST",
        body: { presetId: "openai", baseUrl: "https://unapproved.invalid/v1", apiKey },
      });
    },
  );
  await check("connection names retain their UTF-16 ceiling", () =>
    error("/api/v1/model-connections", 422, {
      method: "POST",
      body: { ...connectionInput, name: "🧪".repeat(41) },
    }).then(() => {}),
  );
  let connectionId = "";
  await check("connection creation normalizes fields without returning credentials", async () => {
    const result = await request("/api/v1/model-connections", {
      method: "POST",
      body: connectionInput,
    });
    assert.equal(result.response.status, 201);
    const data = modelConnectionResponseSchema.parse(result.body).connection;
    assert.equal(data.name, "Synthetic connection");
    assert.equal(data.defaultModel, "synthetic-model");
    assert.equal(data.hasApiKey, true);
    assert.equal(data.revision, 1);
    assert.equal(data.source, "saved");
    assert(!JSON.stringify(result.body).includes(apiKey));
    connectionId = data.id;
    assert((await services()).connections.some((item) => item.id === connectionId));
  });
  await check("nullable default-only updates and no-ops preserve revision semantics", async () => {
    const result = await request(`/api/v1/model-connections/${connectionId}`, {
      method: "PATCH",
      body: { expectedRevision: 1, defaultModel: null },
    });
    assert.equal(result.response.status, 200);
    const data = modelConnectionResponseSchema.parse(result.body).connection;
    assert.equal(data.revision, 2);
    assert(!("defaultModel" in data));
    const noop = await request(`/api/v1/model-connections/${connectionId}`, {
      method: "PATCH",
      body: { expectedRevision: 2, defaultModel: null },
    });
    assert.deepEqual(modelConnectionResponseSchema.parse(noop.body).connection, data);
    await error(`/api/v1/model-connections/${connectionId}`, 409, {
      method: "PATCH",
      body: { expectedRevision: 1, enabled: false },
    });
  });
  let modelBotId = "";
  await check("Employee model selection is versioned and bound to a model profile", async () => {
    const created = await request("/api/v1/bots", {
      method: "POST",
      body: { name: "Model contract", role: "Synthetic only", computerProfile: "model" },
    });
    assert.equal(created.response.status, 201);
    modelBotId = botResponseSchema.parse(created.body).bot.id;
    const model = { connectionId, modelId: "synthetic-model" };
    const selected = await request(`/api/v1/bots/${modelBotId}/model`, {
      method: "PATCH",
      body: { expectedRevision: 1, model },
    });
    assert.equal(selected.response.status, 200);
    const data = employeeModelResponseSchema.parse(selected.body);
    assert.deepEqual(data.employee.model, model);
    assert.equal(data.details.revision, 2);
    await error(`/api/v1/bots/${modelBotId}/model`, 409, {
      method: "PATCH",
      body: { expectedRevision: 1, model: null },
    });
    await error(`/api/v1/bots/${target.botId}/model`, 422, {
      method: "PATCH",
      body: { expectedRevision: 1, model },
    });
  });
  const preferences = async () => {
    const result = await request("/api/v1/settings/general");
    assert.equal(result.response.status, 200);
    return ownerPreferencesSchema.parse(result.body);
  };
  await check(
    "owner default and official transcription selection retain one revision",
    async () => {
      const prior = await preferences();
      const result = await request("/api/v1/settings/general", {
        method: "PUT",
        body: {
          expectedRevision: prior.revision,
          timezone: prior.timezone,
          defaultModel: { connectionId, modelId: "synthetic-model" },
        },
      });
      assert.equal(result.response.status, 200);
      const general = ownerPreferencesSchema.parse(result.body);
      const initial = await request("/api/v1/settings/transcription");
      const previous = transcriptionSettingsSchema.parse(initial.body);
      assert.equal(previous.revision, general.revision);
      const selected = await request("/api/v1/settings/transcription", {
        method: "PUT",
        body: { expectedRevision: previous.revision, connectionId },
      });
      assert.equal(selected.response.status, 200);
      const data = transcriptionSettingsSchema.parse(selected.body);
      assert.equal(data.connectionId, connectionId);
      assert.equal(data.revision, previous.revision + 1);
      await error("/api/v1/settings/transcription", 409, {
        method: "PUT",
        body: { expectedRevision: previous.revision, connectionId: null },
      });
    },
  );
  await check("deletion explains Bot, owner-default and transcription dependencies", async () => {
    const result = await request(`/api/v1/model-connections/${connectionId}`, {
      method: "DELETE",
      body: { expectedRevision: 2 },
    });
    assert.equal(result.response.status, 409);
    const data = modelConnectionDeletionConflictSchema.parse(result.body);
    assert(data.bots.some((item) => item.id === modelBotId));
    assert.equal(data.ownerDefault, true);
    assert.equal(data.transcription, true);
    assert(!JSON.stringify(result.body).includes(apiKey));
  });
  await check("disabled connections refuse discovery/test without provider traffic", async () => {
    const result = await request(`/api/v1/model-connections/${connectionId}`, {
      method: "PATCH",
      body: { expectedRevision: 2, enabled: false },
    });
    assert.equal(result.response.status, 200);
    assert.equal(modelConnectionResponseSchema.parse(result.body).connection.enabled, false);
    await error(`/api/v1/model-connections/${connectionId}/models`, 422, { method: "POST" });
    await error(`/api/v1/model-connections/${connectionId}/test`, 422, {
      method: "POST",
      body: { modelId: "synthetic-model" },
    });
  });
  await check("clearing dependencies permits deletion of the saved connection", async () => {
    const transcription = transcriptionSettingsSchema.parse(
      (await request("/api/v1/settings/transcription")).body,
    );
    assert.equal(
      (
        await request("/api/v1/settings/transcription", {
          method: "PUT",
          body: { expectedRevision: transcription.revision, connectionId: null },
        })
      ).response.status,
      200,
    );
    const prior = await preferences();
    assert.equal(
      (
        await request("/api/v1/settings/general", {
          method: "PUT",
          body: { expectedRevision: prior.revision, timezone: prior.timezone, defaultModel: null },
        })
      ).response.status,
      200,
    );
    const cleared = await request(`/api/v1/bots/${modelBotId}/model`, {
      method: "PATCH",
      body: { expectedRevision: 2, model: null },
    });
    assert.equal(cleared.response.status, 200);
    assert(!("model" in employeeModelResponseSchema.parse(cleared.body).employee));
    const result = await request(`/api/v1/model-connections/${connectionId}`, {
      method: "DELETE",
      body: { expectedRevision: 3 },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(modelConnectionDeletionSchema.parse(result.body), {
      deleted: true,
      connectionId,
    });
    assert(!(await services()).connections.some((item) => item.id === connectionId));
  });
  let channelId = "";
  await check(
    "attachment fixture channel is created through public identity admission",
    async () => {
      const result = await request("/api/v1/channels", {
        method: "POST",
        body: { name: "Resource contract", botIds: [target.botId] },
      });
      assert.equal(result.response.status, 201);
      channelId = channelResponseSchema.parse(result.body).channel.id;
    },
  );
  const base = `/api/v1/channels/${channelId}/attachments`;
  const original = new TextEncoder().encode("Synthetic 文档 🧪\n");
  const digest = createHash("sha256").update(original).digest("hex");
  const upload = async (path: string, filename: string) => {
    const result = await request(path, { method: "POST", bytes: original, filename });
    assert.equal(result.response.status, 201);
    return result;
  };
  const bytes = async (path: string, filename: string) => {
    const result = await client.download(path, original.byteLength);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.bytes, original);
    assert.equal(result.response.headers.get("content-type"), "application/octet-stream");
    assert.equal(result.response.headers.get("content-length"), String(original.byteLength));
    assert.equal(
      result.response.headers.get("content-disposition"),
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    assert.equal(createHash("sha256").update(result.bytes).digest("hex"), digest);
  };
  for (const [name, options, status] of [
    [
      "wrong content type",
      { bytes: original, filename: "fixture.txt", contentType: "text/plain" },
      415,
    ],
    ["path filename", { bytes: original, filename: "bad/name.txt" }, 400],
    ["invalid UTF-8 text", { bytes: new Uint8Array([128]), filename: "fixture.txt" }, 415],
    [
      "text byte ceiling",
      { bytes: new Uint8Array(256 * 1024 + 1).fill(65), filename: "fixture.txt" },
      413,
    ],
  ] as const) {
    await check(`upload rejects ${name}`, () =>
      error(base, status, { method: "POST", ...options }).then(() => {}),
    );
  }
  let channelFile = "";
  let ownerFile = "";
  const filename = "合成 文档.txt";
  await check("channel and Owner uploads preserve exact bytes/digests and namespaces", async () => {
    const channel = channelAttachmentResponseSchema.parse(
      (await upload(base, filename)).body,
    ).attachment;
    const owner = ownerAttachmentResponseSchema.parse(
      (await upload("/api/v1/task-attachments", filename)).body,
    ).attachment;
    channelFile = channel.id;
    ownerFile = owner.id;
    assert.equal(channel.channelId, channelId);
    assert.equal(owner.scopeKind, "owner");
    assert.equal(owner.ownerId, "owner");
    assert.equal(channel.sha256, digest);
    assert.equal(owner.sha256, digest);
    await bytes(`${base}/${channelFile}/content`, filename);
    await bytes(`/api/v1/task-attachments/${ownerFile}/content`, filename);
    await error(`${base}/${ownerFile}`, 404);
    await error(`/api/v1/task-attachments/${channelFile}`, 404);
  });
  await check("attachment lists retain reference counts and Owner scope", async () => {
    const channel = channelAttachmentsResponseSchema
      .parse((await request(base)).body)
      .attachments.find((item) => item.id === channelFile);
    const owner = ownerAttachmentsResponseSchema
      .parse((await request("/api/v1/task-attachments")).body)
      .attachments.find((item) => item.id === ownerFile);
    assert(channel && owner);
    assert.deepEqual(channel.referenceCount, { messages: 0, tasks: 0 });
  });
  await check("plain text refuses unnecessary extraction and explicit null passwords", async () => {
    for (const path of [`${base}/${channelFile}`, `/api/v1/task-attachments/${ownerFile}`]) {
      await error(`${path}/process`, 415, {
        method: "POST",
        body: { operation: "extract" },
      });
      await error(`${path}/process`, 422, {
        method: "POST",
        body: { operation: "extract", password: null },
      });
    }
  });
  await check(
    "released document parser returns bounded public metadata in both scopes",
    async () => {
      const document = await readFile(new URL("../fixtures/document.docx", import.meta.url));
      const documentDigest = createHash("sha256").update(document).digest("hex");
      for (const scope of [base, "/api/v1/task-attachments"]) {
        const uploaded = await request(scope, {
          method: "POST",
          bytes: document,
          filename: "synthetic.docx",
        });
        assert.equal(uploaded.response.status, 201);
        const schema =
          scope === base ? channelAttachmentResponseSchema : ownerAttachmentResponseSchema;
        const item = schema.parse(uploaded.body).attachment;
        assert.equal(item.sha256, documentDigest);
        const result = await request(`${scope}/${item.id}/process`, {
          method: "POST",
          body: { operation: "extract" },
          // The released parser has a 30s product deadline; allow its bounded result to arrive.
          timeoutMs: 35000,
        });
        assert.equal(result.response.status, 200);
        const data = schema.parse(result.body).attachment;
        assert.equal(data.processing?.operation, "extract");
        assert.equal(data.processing?.truncated, false);
        assert.equal(data.processing?.characters, "OpenBot synthetic document evidence".length);
        assert.equal(data.sha256, documentDigest);
        assert(!JSON.stringify(result.body).includes("OpenBot synthetic document evidence"));
        const download = await client.download(`${scope}/${item.id}/content`, document.length);
        assert.equal(download.response.status, 200);
        assert.deepEqual(download.bytes, new Uint8Array(document));
      }
    },
  );
  await check("Owner deletion hides bytes while restore retains the original digest", async () => {
    const path = `/api/v1/task-attachments/${ownerFile}`;
    const result = await request(path, { method: "DELETE", body: {} });
    assert.equal(result.response.status, 200);
    assert(ownerAttachmentResponseSchema.parse(result.body).attachment.deletedAt);
    await error(`${path}/content`, 404);
    await error(`${path}/restore`, 422, { method: "POST", body: { extra: true } });
    const restored = await request(`${path}/restore`, { method: "POST", body: {} });
    assert.equal(restored.response.status, 200);
    assert(!("deletedAt" in ownerAttachmentResponseSchema.parse(restored.body).attachment));
    await bytes(`${path}/content`, filename);
  });
  await check("live channel bytes cannot be permanently purged", () =>
    error(`${base}/${channelFile}/purge`, 409, { method: "DELETE", body: {} }).then(() => {}),
  );
  await check("message and Run references protect deleted channel files", async () => {
    const admitted = await request(`/api/v1/channels/${channelId}/messages`, {
      method: "POST",
      body: {
        content: `Synthetic reference [OpenBot attachment: ${channelFile}]`,
        botId: target.botId,
      },
    });
    assert.equal(admitted.response.status, 201);
    submitTaskResponseSchema.parse(admitted.body);
    const refs = attachmentReferencesSchema.parse(
      (await request(`${base}/${channelFile}/references?limit=1`)).body,
    );
    assert.equal(refs.messageCount, 1);
    assert.equal(refs.taskCount, 1);
    assert.equal(refs.messages.length, 1);
    assert.equal(refs.tasks.length, 1);
    assert.equal(refs.messages[0]?.author.kind, "owner");
    assert(!refs.messages[0]?.preview.includes("[OpenBot attachment:"));
    const removed = await request(`${base}/${channelFile}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert(channelAttachmentResponseSchema.parse(removed.body).attachment.deletedAt);
    await bytes(`${base}/${channelFile}/content`, filename);
    const refusal = await error(`${base}/${channelFile}/purge`, 409, {
      method: "DELETE",
      body: {},
    });
    assert.deepEqual(controlHttpErrorSchema.parse(refusal.body).referenceCount, {
      messages: 1,
      tasks: 1,
    });
  });
  await check("reference query rejects duplicate/unknown/out-of-range limits", async () => {
    for (const query of ["limit=0", "limit=101", "limit=1&limit=2", "extra=true"])
      await error(`${base}/${channelFile}/references?${query}`, 422);
  });
  await check("single purge returns a durable receipt and content-free 410", async () => {
    const item = channelAttachmentResponseSchema.parse(
      (await upload(base, "purge.txt")).body,
    ).attachment;
    assert.equal((await request(`${base}/${item.id}`, { method: "DELETE" })).response.status, 200);
    const result = await request(`${base}/${item.id}/purge`, { method: "DELETE", body: {} });
    assert.equal(result.response.status, 200);
    const data = attachmentPurgeSchema.parse(result.body);
    assert.equal(data.id, item.id);
    assert(data.freedBytes > 0);
    const replay = await request(`${base}/${item.id}/purge`, { method: "DELETE", body: {} });
    assert.deepEqual(attachmentPurgeSchema.parse(replay.body), data);
    const gone = await error(`${base}/${item.id}`, 410);
    assert.equal(controlHttpErrorSchema.parse(gone.body).purged, true);
  });
  await check("channel cleanup replays its receipt and retains referenced trash", async () => {
    const item = channelAttachmentResponseSchema.parse(
      (await upload(base, "cleanup.txt")).body,
    ).attachment;
    await request(`${base}/${item.id}`, { method: "DELETE" });
    const body = { requestKey: randomUUID() };
    const result = await request(`${base}/cleanup`, { method: "POST", body });
    assert.equal(result.response.status, 200);
    const data = trashCleanupSchema.parse(result.body);
    assert.equal(data.removed, 1);
    assert.equal(data.retainedCount, 1);
    assert.equal(data.retained[0]?.id, channelFile);
    assert(data.freedBytes > 0);
    const replay = await request(`${base}/cleanup`, { method: "POST", body });
    assert.deepEqual(trashCleanupSchema.parse(replay.body), data);
    await error(`${base}/${item.id}/content`, 410);
  });
  await check(
    "storage usage reports measured bytes, referenced trash and explicit unknowns",
    async () => {
      const result = await request("/api/v1/storage");
      assert.equal(result.response.status, 200);
      const data = storageUsageSchema.parse(result.body);
      assert(data.totalBytes > 0);
      assert.equal(data.trash.referencedFileCount, 1);
      assert(data.trash.referencedSizeBytes > 0);
      assert.equal(data.categories.workingComputerBrowserData, null);
      assert(data.topChannels.some((item) => item.id === channelId));
      await error("/api/v1/storage?extra=1", 422);
    },
  );
  await check("storage setting CAS preserves strict JSON integer tokens", async () => {
    const initial = await request("/api/v1/settings/storage");
    assert.equal(initial.response.status, 200);
    const prior = storageSettingsSchema.parse(initial.body);
    await error("/api/v1/settings/storage", 422, {
      method: "PUT",
      rawBody: `{"expectedRevision":${prior.revision}.0,"trashAutoPurgeDays":null}`,
    });
    await error("/api/v1/settings/storage", 422, {
      method: "PUT",
      body: { expectedRevision: prior.revision, trashAutoPurgeDays: 29 },
    });
    const changed = await request("/api/v1/settings/storage", {
      method: "PUT",
      body: { expectedRevision: prior.revision, trashAutoPurgeDays: 30 },
    });
    assert.equal(changed.response.status, 200);
    const data = storageSettingsSchema.parse(changed.body);
    assert.equal(data.revision, prior.revision + 1);
    assert.equal(data.trashAutoPurgeDays, 30);
    await error("/api/v1/settings/storage", 409, {
      method: "PUT",
      body: { expectedRevision: prior.revision, trashAutoPurgeDays: null },
    });
    const disabled = await request("/api/v1/settings/storage", {
      method: "PUT",
      body: { expectedRevision: data.revision, trashAutoPurgeDays: null },
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(storageSettingsSchema.parse(disabled.body).trashAutoPurgeDays, null);
  });
  await check("whole-workspace cleanup replays the same bounded retained set", async () => {
    const body = { requestKey: randomUUID() };
    const result = await request("/api/v1/storage/trash/cleanup", { method: "POST", body });
    assert.equal(result.response.status, 200);
    const data = storageTrashCleanupSchema.parse(result.body);
    assert.equal(data.removed, 0);
    assert.equal(data.retainedCount, 1);
    assert.equal(data.channelCount, 1);
    const replay = await request("/api/v1/storage/trash/cleanup", { method: "POST", body });
    assert.deepEqual(storageTrashCleanupSchema.parse(replay.body), data);
  });
  return { count: passed.length, passed };
}
