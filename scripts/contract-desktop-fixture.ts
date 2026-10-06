import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  ownerAttachmentSchema,
  ownerPreferencesSchema,
  approvalSettingsSchema,
  storageSettingsSchema,
  transcriptionSettingsSchema,
  workspacePrimaryBotSchema,
} from "@openbot/protocol";
import { proxyDesktopServerRequest } from "../apps/desktop/src/server-proxy.ts";
import { contractTargetSchema } from "../packages/contract-tests/src/target.ts";

// Exercise the actual Web client and Desktop proxy against the owned product. This is transport
// evidence using Node Fetch, not an installed Electron/native-platform qualification.
const [fixturePath, ...extra] = process.argv.slice(2);
assert(fixturePath && !extra.length, "Supply one private disposable contract fixture.");
assert.equal((await stat(fixturePath)).mode & 0o077, 0);
const input = JSON.parse(await readFile(fixturePath, "utf8"));
const target = contractTargetSchema.parse({
  baseUrl: input.baseUrl,
  origin: input.origin,
  cookie: input.cookie,
  botId: input.botId,
});
const originalFetch = globalThis.fetch;
// Web owns bundler/DOM compilation; tsx resolves its real module without changing that contract.
const { uploadOwnerAttachment, listOwnerAttachments, updateOwnerAttachment } = await import(
  new URL("../apps/web/src/native-task-api.ts", import.meta.url).href
);
const api = await import(new URL("../apps/web/src/api.ts", import.meta.url).href);
const signal = AbortSignal.timeout(10000);
const upstream = (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", target.cookie);
  return originalFetch(url, { ...init, headers });
};
globalThis.fetch = async (url, init) => {
  assert(typeof url === "string" && url.startsWith("/api/v1/"));
  const result = await proxyDesktopServerRequest(
    new Request(`openbot://app${url}`, init),
    { status: "configured", serverUrl: target.baseUrl },
    upstream,
  );
  assert(result, "Desktop refused its own Web API target.");
  return result;
};
let attachmentId: string | undefined;
try {
  const preferences = ownerPreferencesSchema.parse(await api.getOwnerPreferences(signal));
  const saved = ownerPreferencesSchema.parse(
    await api.saveOwnerPreferences({
      expectedRevision: preferences.revision,
      timezone: preferences.timezone,
      defaultModel: preferences.defaultModel,
    }),
  );
  assert.equal(saved.timezone, preferences.timezone);
  assert.deepEqual(saved.defaultModel, preferences.defaultModel);
  const approvals = approvalSettingsSchema.parse(await api.getApprovalSettings(signal));
  const savedApprovals = approvalSettingsSchema.parse(
    await api.saveApprovalSettings({
      expectedRevision: approvals.revision,
      productRead: approvals.productRead,
      publicWeb: approvals.publicWeb,
      exceptions: approvals.exceptions,
    }),
  );
  assert.equal(savedApprovals.productRead, approvals.productRead);
  const storage = storageSettingsSchema.parse(await api.getStorageSettings(signal));
  const savedStorage = storageSettingsSchema.parse(
    await api.updateStorageSettings({
      expectedRevision: storage.revision,
      trashAutoPurgeDays: storage.trashAutoPurgeDays,
    }),
  );
  assert.equal(savedStorage.trashAutoPurgeDays, storage.trashAutoPurgeDays);
  const transcription = transcriptionSettingsSchema.parse(
    await api.getTranscriptionSettings(signal),
  );
  assert.deepEqual(
    transcriptionSettingsSchema.parse(
      await api.saveTranscriptionSettings({
        expectedRevision: transcription.revision,
        connectionId: transcription.connectionId,
      }),
    ),
    transcription,
  );
  const workspace = await api.getWorkspace(signal);
  const primary = workspacePrimaryBotSchema.parse(
    await api.setWorkspacePrimaryBot({
      expectedRevision: workspace.revision,
      botId: workspace.primaryBotId,
    }),
  );
  assert.equal(primary.primaryBotId, workspace.primaryBotId);
  console.log(
    "Actual Web/desktop settings PUT transport: general, approvals, storage, transcription and workspace primary Bot passed.",
  );
  const text = "Synthetic Desktop 文档 🧪\n",
    name = "合成 桌面文档.txt";
  const uploaded = ownerAttachmentSchema.parse(
    await uploadOwnerAttachment(new File([text], name), signal),
  );
  attachmentId = uploaded.id;
  assert.equal(uploaded.name, name);
  assert.equal(uploaded.scopeKind, "owner");
  assert.equal(uploaded.sha256, createHash("sha256").update(text).digest("hex"));
  assert(
    (await listOwnerAttachments(signal)).some(
      (value: unknown) => ownerAttachmentSchema.parse(value).id === uploaded.id,
    ),
  );
  const response = await fetch(`/api/v1/task-attachments/${uploaded.id}/content`, { signal });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), text);
  await updateOwnerAttachment(uploaded.id, "delete", signal);
  assert.equal(
    (await fetch(`/api/v1/task-attachments/${uploaded.id}/content`, { signal })).status,
    404,
  );
  console.log(
    "Actual Web/desktop Owner attachment transport: upload metadata, listing, exact bytes and deletion passed.",
  );
} finally {
  try {
    if (attachmentId)
      await updateOwnerAttachment(attachmentId, "delete", AbortSignal.timeout(10000));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
