// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  emptyNativeTaskScope,
  getNativeTaskScope,
  listOwnerAttachments,
  nativeTaskScopeInputSchema,
  updateOwnerAttachment,
  uploadOwnerAttachment,
} from "./native-task-api";
import { nativeIds, nativeScope, ownerFile } from "./test/native-task-fixture";
import { workFixture } from "./test/work-fixture";
import { createWorkTask, listWorkBots } from "./work-api";
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("uploads exact raw bytes and encoded filename under the Owner session without a channel or token", async () => {
  const file = new File(["synthetic evidence"], "证据.txt", { type: "text/plain" });
  const fetcher = vi.fn(async () => Response.json({ attachment: ownerFile() }));
  vi.stubGlobal("fetch", fetcher);
  expect(await uploadOwnerAttachment(file, signal)).toEqual(ownerFile());
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/task-attachments", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-OpenBot-Filename": encodeURIComponent(file.name),
    },
    body: file,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal,
  });
});
it("uses explicit delete, restore and process calls and sends the password only to process", async () => {
  const fetcher = vi.fn(async () => Response.json({ attachment: ownerFile() }));
  vi.stubGlobal("fetch", fetcher);
  await updateOwnerAttachment(nativeIds.file, "delete", signal, "unused");
  await updateOwnerAttachment(nativeIds.file, "restore", signal, "unused");
  await updateOwnerAttachment(nativeIds.file, "extract", signal, "transient password");
  expect(fetcher.mock.calls.map(([path, options]) => [path, options.method, options.body])).toEqual(
    [
      [`/api/v1/task-attachments/${nativeIds.file}`, "DELETE", "{}"],
      [`/api/v1/task-attachments/${nativeIds.file}/restore`, "POST", "{}"],
      [
        `/api/v1/task-attachments/${nativeIds.file}/process`,
        "POST",
        JSON.stringify({ operation: "extract", password: "transient password" }),
      ],
    ],
  );
});
it.each([
  { channelId: nativeIds.file },
  { scopeKind: "channel" },
  { ownerId: "other" },
  { sha256: "invalid" },
  { sizeBytes: 262145 },
  { sizeBytes: 0 },
  {
    processing: {
      operation: "ocr",
      characters: 262145,
      truncated: false,
      processedAt: "2026-09-25T00:00:00Z",
    },
  },
])("rejects malformed/cross-namespace resource metadata %j", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ attachments: [{ ...ownerFile(), ...change }] })),
  );
  await expect(listOwnerAttachments(signal)).rejects.toThrow();
});
it("refuses a mutation response for a different file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ attachment: ownerFile({ id: nativeIds.peer }) })),
  );
  await expect(updateOwnerAttachment(nativeIds.file, "restore", signal)).rejects.toThrow(
    "identity mismatch",
  );
});
it("reads the immutable scope and preserves null without inferring channel rights", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ scope: nativeScope() }))
    .mockResolvedValueOnce(Response.json({ scope: null }));
  vi.stubGlobal("fetch", fetcher);
  expect(await getNativeTaskScope("task/id", signal)).toEqual(nativeScope());
  expect(fetcher.mock.calls[0][0]).toBe("/api/v1/tasks/task%2Fid/scope");
  expect(await getNativeTaskScope("task-one", signal)).toBeNull();
});
it.each([
  { attachmentIds: [] },
  { attachments: [] },
  { attachmentIds: [nativeIds.file, nativeIds.file] },
  { collaboratorBotIds: ["not-a-uuid"] },
  { extra: "not-authority" },
  { knowledge: "true" },
])("rejects inconsistent scope metadata %j", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ scope: { ...nativeScope(), ...change } })),
  );
  await expect(getNativeTaskScope("task-one", signal)).rejects.toThrow();
});
it("keeps the exact scope beside the original creation key and does not serialize file bytes", async () => {
  const fetcher = vi.fn(async () => Response.json(workFixture()));
  vi.stubGlobal("fetch", fetcher);
  const input = {
    botId: nativeIds.self,
    objective: "review",
    tokenLimit: 100,
    requestKey: "original-key",
    scope: { ...emptyNativeTaskScope(), attachmentIds: [nativeIds.file], knowledge: true },
  };
  await createWorkTask(input, signal);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
  expect(
    nativeTaskScopeInputSchema.safeParse({
      ...input.scope,
      collaboratorBotIds: Array(33).fill(nativeIds.peer),
    }).success,
  ).toBe(false);
});
it("preserves Bot execution profile and fails closed on a missing or unknown profile", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ bots: [{ id: nativeIds.self, name: "Self", computerProfile: "none" }] }),
    )
    .mockResolvedValueOnce(Response.json({ bots: [{ id: nativeIds.self, name: "Self" }] }));
  vi.stubGlobal("fetch", fetcher);
  expect((await listWorkBots(signal))[0]?.computerProfile).toBe("none");
  await expect(listWorkBots(signal)).rejects.toThrow();
});
it("uses finite errors and the existing unauthorized event instead of server diagnostic text", async () => {
  const listener = vi.fn();
  window.addEventListener("openbot:unauthorized", listener);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ detail: "private diagnostic" }, { status: 401 })),
  );
  try {
    await expect(listOwnerAttachments(signal)).rejects.toThrow(
      "Task resource request failed (401).",
    );
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("openbot:unauthorized", listener);
  }
});
