import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeTaskText,
  uploadComposerAttachment,
  validateComposerAttachmentBatch,
  validateComposerFile,
} from "./composer-context";

afterEach(() => vi.restoreAllMocks());
const channelId = "00000000-0000-4000-8000-000000000001";
const attachment = {
  id: "00000000-0000-4000-8000-000000000011",
  channelId,
  name: "large.ts",
  mediaType: "text/plain" as const,
  sizeBytes: 200000,
  sha256: "a".repeat(64),
  createdAt: "2026-09-10T00:00:00.000Z",
};

describe("persistent composer attachment requests", () => {
  it("uploads binary file bytes and stores only a short immutable task reference", async () => {
    const file = new File(["a".repeat(200000)], "large.ts");
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ attachment }, { status: 201 }));
    const result = await uploadComposerAttachment(channelId, file);
    const content = composeTaskText("Review the code", [result]);
    expect(content.length).toBeLessThan(300);
    expect(content).toContain(`[OpenBot attachment: ${attachment.id}]`);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/channels/${channelId}/attachments`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: file,
        headers: { "Content-Type": "application/octet-stream", "X-OpenBot-Filename": "large.ts" },
      }),
    );
  });
  it.each(["channel", "size", "digest", "type"])(
    "rejects a mismatched upload response: %s",
    async (mode) => {
      const returned = {
        ...attachment,
        channelId: mode === "channel" ? "wrong" : attachment.channelId,
        sizeBytes: mode === "size" ? 1 : attachment.sizeBytes,
        sha256: mode === "digest" ? "bad" : attachment.sha256,
        mediaType: mode === "type" ? "text/html" : attachment.mediaType,
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ attachment: returned }, { status: 201 }),
      );
      await expect(
        uploadComposerAttachment(channelId, new File(["a".repeat(200000)], "large.ts")),
      ).rejects.toThrow("不匹配");
    },
  );
  it("reads bounded upload errors before applying status without accepting returned identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ attachment, error: "denied".repeat(110) }, { status: 403 }),
    );
    await expect(
      uploadComposerAttachment(channelId, new File(["a".repeat(200000)], "large.ts")),
    ).rejects.toMatchObject({ message: "denied".repeat(110).slice(0, 500) });
  });

  it("rejects upload overflow even when stream cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16385));
      },
      cancel,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    await expect(
      uploadComposerAttachment(channelId, new File(["data"], "file.txt")),
    ).rejects.toThrow("附件上传响应过大。");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  }, 1000);

  it("allows richer code/text types and bounds file count, bytes and unsupported formats", () => {
    for (const name of [
      "file.ts",
      "file.py",
      "file.csv",
      "file.yaml",
      "file.png",
      "file.jpg",
      "file.pdf",
    ])
      expect(() => validateComposerFile(new File(["data"], name))).not.toThrow();
    expect(() =>
      validateComposerAttachmentBatch(
        [],
        Array.from({ length: 9 }, (_, i) => new File(["data"], `file${i}.txt`)),
      ),
    ).toThrow("8 个");
    expect(() => validateComposerFile(new File(["a".repeat(256 * 1024 + 1)], "large.ts"))).toThrow(
      "大小超限",
    );
    expect(() => validateComposerFile(new File(["data"], "archive.zip"))).toThrow("暂不支持");
    expect(() => validateComposerFile(new File(["data"], "../file.md"))).toThrow("名称");
  });
});
