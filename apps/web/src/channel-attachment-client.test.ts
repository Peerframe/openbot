import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_DOCUMENT_EXTRACT_ERROR,
  EMPTY_PDF_EXTRACT_ERROR,
  getAttachmentImage,
  getChannelAttachment,
  presentAttachmentProcessError,
  splitMessageAttachments,
  updateAttachment,
} from "./channel-attachment-client";

const id = "00000000-0000-4000-8000-000000000001";
const attachment = {
  id,
  channelId: "channel",
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
    await expect(
      getChannelAttachment("channel", id, new AbortController().signal),
    ).resolves.toEqual(attachment);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/channels/channel/attachments/${id}`,
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
        getChannelAttachment("channel", id, new AbortController().signal),
      ).rejects.toThrow();
    }
  });
  it("rejects denied metadata, oversized JSON and invalid IDs without external requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response(" ".repeat(16385)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getChannelAttachment("channel", id, new AbortController().signal)).rejects.toThrow(
      "无权访问",
    );
    await expect(getChannelAttachment("channel", id, new AbortController().signal)).rejects.toThrow(
      "大小",
    );
    await expect(
      getChannelAttachment("channel", "https://evil.test/image", new AbortController().signal),
    ).rejects.toThrow("标识");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
