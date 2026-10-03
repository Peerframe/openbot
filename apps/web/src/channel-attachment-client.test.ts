import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentCommandError,
  AttachmentPurgedError,
  cleanupChannelTrash,
  EMPTY_DOCUMENT_EXTRACT_ERROR,
  EMPTY_PDF_EXTRACT_ERROR,
  getAttachmentImage,
  getChannelAttachment,
  presentAttachmentProcessError,
  purgeAttachment,
  splitMessageAttachments,
  updateAttachment,
} from "./channel-attachment-client";

const id = "00000000-0000-4000-8000-000000000001";
const channel = "00000000-0000-4000-8000-000000000002";
const attachment = {
  id,
  channelId: channel,
  name: "image.png",
  mediaType: "image/png" as const,
  sizeBytes: 8,
  sha256: "a".repeat(64),
  createdAt: "2026-09-10T00:00:00Z",
};
afterEach(() => vi.unstubAllGlobals());

describe("channel attachment display boundary", () => {
  it("removes only generated descriptions, deduplicates IDs and preserves user text", () => {
    expect(
      splitMessageAttachments(
        `Read this\n\nUser-provided attachment: image.png (image/png, 8 bytes)\n[OpenBot attachment: ${id}]\n\nPlease compare [OpenBot attachment: ${id}]`,
      ),
    ).toEqual({ text: "Read this\n\nPlease compare", ids: [id] });
    expect(splitMessageAttachments("User-provided attachment: legacy.md\nlegacy text")).toEqual({
      text: "User-provided attachment: legacy.md\nlegacy text",
      ids: [],
    });
    expect(splitMessageAttachments("[OpenBot attachment: ../../other-channel]")).toEqual({
      text: "[附件标识无效]",
      ids: [],
    });
  });
  it("bounds cards even for model-produced marker spam", () => {
    const content = Array.from(
      { length: 20 },
      (_, index) =>
        `[OpenBot attachment: 00000000-0000-4000-8000-${index.toString().padStart(12, "0")}]`,
    ).join("\n");
    expect(splitMessageAttachments(content).ids).toHaveLength(8);
    expect(splitMessageAttachments(content).text).not.toContain("OpenBot");
  });
  it("fetches only scoped authenticated metadata and rejects scope/type/size mismatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ attachment })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getChannelAttachment(channel, id, new AbortController().signal)).resolves.toEqual(
      attachment,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/channels/${channel}/attachments/${id}`,
      expect.objectContaining({ credentials: "include", redirect: "error" }),
    );
    for (const patch of [
      { channelId: "other" },
      { mediaType: "image/svg+xml" },
      { sizeBytes: 6 * 1024 * 1024 },
      { name: "<script>.png" },
    ]) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ attachment: { ...attachment, ...patch } })),
      );
      await expect(
        getChannelAttachment(channel, id, new AbortController().signal),
      ).rejects.toThrow();
    }
  });
  it("rejects denied metadata, oversized JSON and invalid IDs without external requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response(" ".repeat(16385)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getChannelAttachment(channel, id, new AbortController().signal)).rejects.toThrow(
      "无权访问",
    );
    await expect(getChannelAttachment(channel, id, new AbortController().signal)).rejects.toThrow(
      "大小",
    );
    await expect(
      getChannelAttachment(channel, "https://evil.test/image", new AbortController().signal),
    ).rejects.toThrow("标识");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("tells a permanently deleted file apart from a denied one", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "attachment_purged", purged: true }, { status: 410 }),
        )
        .mockResolvedValueOnce(Response.json({ error: "gone" }, { status: 410 })),
    );
    await expect(
      getChannelAttachment(channel, id, new AbortController().signal),
    ).rejects.toBeInstanceOf(AttachmentPurgedError);
    await expect(getChannelAttachment(channel, id, new AbortController().signal)).rejects.toThrow(
      "无权访问",
    );
  });
  it("purges and cleans the 回收站 through scoped routes and keeps refusal details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "attachment_referenced", referenceCount: { messages: 2, tasks: 1 } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ id, purged: true, freedBytes: 8 }))
      .mockResolvedValueOnce(
        Response.json({
          removed: 2,
          retained: [],
          retainedCount: 0,
          retainedHasMore: false,
          freedBytes: 16,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const refusal = await purgeAttachment(channel, id).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(AttachmentCommandError);
    expect(refusal).toMatchObject({
      code: "attachment_referenced",
      status: 409,
      referenceCount: { messages: 2, tasks: 1 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/channels/${channel}/attachments/${id}/purge`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(await purgeAttachment(channel, id)).toEqual({ id, purged: true, freedBytes: 8 });
    const key = "11111111-1111-4111-8111-111111111111";
    expect((await cleanupChannelTrash(channel, key)).removed).toBe(2);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/v1/channels/${channel}/attachments/cleanup`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ requestKey: key });
    await expect(purgeAttachment(channel, "../escape")).rejects.toThrow("标识");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("rejects denied metadata before locking or reading a hostile body", async () => {
    const pull = vi.fn(() => {
      throw new Error("must not read denied content");
    });
    const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 403 })));
    await expect(getChannelAttachment(channel, id, new AbortController().signal)).rejects.toThrow(
      "无权访问",
    );
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("takes update identity from a second scoped metadata request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ attachment: { ...attachment, channelId: "wrong" } }))
      .mockResolvedValueOnce(Response.json({ attachment }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(updateAttachment(attachment, "restore")).resolves.toEqual(attachment);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/channels/${channel}/attachments/${id}/restore`,
      expect.objectContaining({ method: "POST", credentials: "include", redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/channels/${channel}/attachments/${id}`,
      expect.objectContaining({ credentials: "include", redirect: "error" }),
    );
  });

  it("does not invent metadata success for a missing update body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(updateAttachment(attachment, "restore")).rejects.toThrow("未返回有效内容");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("only previews bounded PNG/JPEG bytes and rejects active content", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response("<script>"))
      .mockResolvedValueOnce(new Response(new Uint8Array(9)));
    vi.stubGlobal("fetch", fetchMock);
    const blob = await getAttachmentImage(attachment, new AbortController().signal);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(8);
    await expect(getAttachmentImage(attachment, new AbortController().signal)).rejects.toThrow(
      "格式",
    );
    await expect(getAttachmentImage(attachment, new AbortController().signal)).rejects.toThrow(
      "大小",
    );
    await expect(
      getAttachmentImage(
        { ...attachment, mediaType: "application/pdf" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("不支持");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("attachment process error presentation", () => {
  it("maps only exact Server empty-extract copy and leaves unknown reasons unchanged", () => {
    expect(presentAttachmentProcessError(EMPTY_PDF_EXTRACT_ERROR)).toBe(
      "未找到可读的 PDF 文字。该 PDF 可能是扫描件或空白文档。请上传 PNG/JPEG 页面后选择图片文字识别，或使用带有可读文字层的 PDF。",
    );
    expect(presentAttachmentProcessError(EMPTY_DOCUMENT_EXTRACT_ERROR)).toBe(
      "未找到可读文字。请检查原文件，并使用包含可读内容的附件重试。",
    );
    expect(presentAttachmentProcessError(EMPTY_DOCUMENT_EXTRACT_ERROR)).not.toContain("扫描件");
    expect(presentAttachmentProcessError("No readable PDF text was found.")).toBe(
      "No readable PDF text was found.",
    );
    expect(presentAttachmentProcessError(`${EMPTY_PDF_EXTRACT_ERROR} extra`)).toBe(
      `${EMPTY_PDF_EXTRACT_ERROR} extra`,
    );
    expect(presentAttachmentProcessError("PDF password is missing or incorrect.")).toBe(
      "PDF password is missing or incorrect.",
    );
    expect(presentAttachmentProcessError("Attachment processing timed out.")).toBe(
      "Attachment processing timed out.",
    );
  });
  it("localizes an exact empty-PDF process response without inventing success", async () => {
    const pdf = {
      ...attachment,
      name: "scan.pdf",
      mediaType: "application/pdf" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ error: EMPTY_PDF_EXTRACT_ERROR }), { status: 415 }),
          ),
        ),
    );
    await expect(updateAttachment(pdf, "extract")).rejects.toThrow(
      "未找到可读的 PDF 文字。该 PDF 可能是扫描件或空白文档。请上传 PNG/JPEG 页面后选择图片文字识别，或使用带有可读文字层的 PDF。",
    );
  });
  it("does not map an unknown process failure onto the empty-PDF reason", async () => {
    const pdf = {
      ...attachment,
      name: "scan.pdf",
      mediaType: "application/pdf" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "Attachment parser exceeded resources or failed." }),
            {
              status: 413,
            },
          ),
        ),
      ),
    );
    await expect(updateAttachment(pdf, "extract")).rejects.toThrow(
      "Attachment parser exceeded resources or failed.",
    );
    await expect(updateAttachment(pdf, "extract")).rejects.not.toThrow("扫描件");
  });
});
