import {
  type AttachmentOperation,
  attachmentByteLimit,
  attachmentMetadataSchema,
} from "@openbot/protocol";
import type { UploadedComposerAttachment } from "./composer-context";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Exact Server English extract-failure copy. Substring or prefix matches must not map. */
export const EMPTY_PDF_EXTRACT_ERROR =
  "No readable PDF text was found. The PDF may be scanned or blank. Upload PNG/JPEG pages and choose image OCR, or use a PDF with a text layer.";
export const EMPTY_DOCUMENT_EXTRACT_ERROR =
  "No readable text was found. Check the original attachment and retry with readable content.";

const ATTACHMENT_PROCESS_ERROR_ZH = new Map<string, string>([
  [
    EMPTY_PDF_EXTRACT_ERROR,
    "未找到可读的 PDF 文字。该 PDF 可能是扫描件或空白文档。请上传 PNG/JPEG 页面后选择图片文字识别，或使用带有可读文字层的 PDF。",
  ],
  [EMPTY_DOCUMENT_EXTRACT_ERROR, "未找到可读文字。请检查原文件，并使用包含可读内容的附件重试。"],
]);

/** Present known Server extract failures in Chinese. Unknown text is returned unchanged. */
export function presentAttachmentProcessError(message: string): string {
  return ATTACHMENT_PROCESS_ERROR_ZH.get(message) ?? message;
}

function attachmentPath(channelId: string, attachmentId: string): string {
  if (!UUID.test(attachmentId)) throw new Error("附件标识无效。");
  return `/api/v1/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new Error("附件暂不可用或无权访问。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("附件未返回有效内容。");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("附件响应超过允许大小。");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function getChannelAttachment(
  channelId: string,
  id: string,
  signal: AbortSignal,
): Promise<UploadedComposerAttachment> {
  const response = await fetch(attachmentPath(channelId, id), {
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const { attachment: candidate } = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 16384)),
  ) as { attachment?: UploadedComposerAttachment };
  const parsed = attachmentMetadataSchema.safeParse(candidate);
  const value = parsed.success ? parsed.data : undefined;
  if (
    !value ||
    value.id !== id ||
    value.channelId !== channelId ||
    typeof value.name !== "string" ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u.test(value.name) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    value.sizeBytes > attachmentByteLimit(value.mediaType)
  )
    throw new Error("附件信息与当前频道不匹配。");
  return value;
}

export async function getAttachmentImage(
  attachment: UploadedComposerAttachment,
  signal: AbortSignal,
): Promise<Blob> {
  if (attachment.mediaType !== "image/png" && attachment.mediaType !== "image/jpeg")
    throw new Error("此附件不支持图片预览。");
  const response = await fetch(`${attachmentPath(attachment.channelId, attachment.id)}/content`, {
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  const bytes = await readBounded(response, Math.min(attachment.sizeBytes, 5 * 1024 * 1024));
  if (bytes.length !== attachment.sizeBytes) throw new Error("附件内容长度不匹配。");
  // Only these raster formats are interpreted by the image element; never render HTML/SVG/PDF.
  const valid =
    attachment.mediaType === "image/png"
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new Error("图片内容格式不匹配。");
  return new Blob([bytes], { type: attachment.mediaType });
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function splitMessageAttachments(content: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  // Strip only the machine-generated description immediately preceding its marker.
  const text = content
    .replace(
      /(?:^User-provided attachment: [^\n]*\r?\n)?\[OpenBot attachment: ([^\]\r\n]*)\]/gmu,
      (_match, id: string) => {
        if (UUID.test(id) && !ids.includes(id) && ids.length < 8) ids.push(id);
        return UUID.test(id) ? "" : "[附件标识无效]";
      },
    )
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { text, ids };
}

export async function updateAttachment(
  attachment: UploadedComposerAttachment,
  operation: AttachmentOperation | "delete" | "restore",
  password?: string,
  signal?: AbortSignal,
): Promise<UploadedComposerAttachment> {
  const process = ["extract", "ocr", "transcribe"].includes(operation);
  const response = await fetch(
    `${attachmentPath(attachment.channelId, attachment.id)}${process ? "/process" : operation === "restore" ? "/restore" : ""}`,
    {
      method: operation === "delete" ? "DELETE" : "POST",
      credentials: "include",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      ...(process
        ? { body: JSON.stringify({ operation, ...(password ? { password } : {}) }) }
        : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(95000)])
        : AbortSignal.timeout(95000),
    },
  );
  const data = new TextDecoder().decode(
    await readBounded(new Response(response.body, { status: 200 }), 16384),
  );
  if (!response.ok) {
    const error = JSON.parse(data) as { error?: string };
    throw new Error(
      typeof error.error === "string"
        ? presentAttachmentProcessError(error.error.slice(0, 300))
        : "附件操作失败。",
    );
  }
  return getChannelAttachment(
    attachment.channelId,
    attachment.id,
    signal ?? new AbortController().signal,
  );
}
export async function downloadAttachment(attachment: UploadedComposerAttachment): Promise<void> {
  const desktop = window.openbotDesktop;
  if (desktop) {
    if (!desktop.saveAttachment) throw new Error("请更新桌面版以下载原附件。");
    const result = await desktop.saveAttachment({
      channelId: attachment.channelId,
      attachmentId: attachment.id,
    });
    if (result.status !== "saved" && result.status !== "cancelled")
      throw new Error(
        result.status === "exists" ? "文件已存在，请换一个保存位置。" : "附件保存失败。",
      );
    return;
  }
  const response = await fetch(`${attachmentPath(attachment.channelId, attachment.id)}/content`, {
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const bytes = await readBounded(response, attachment.sizeBytes);
  if (bytes.length !== attachment.sizeBytes) throw new Error("附件长度不匹配。");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== attachment.sha256
  )
    throw new Error("附件校验失败。");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
