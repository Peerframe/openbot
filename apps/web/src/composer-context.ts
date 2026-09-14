import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_EXTENSIONS,
  attachmentExtensionByteLimit,
  attachmentMetadataSchema,
  type ChannelAttachment,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
} from "@openbot/protocol";

export { attachmentMediaTypes as ATTACHMENT_MEDIA_TYPES } from "@openbot/protocol";
export type UploadedComposerAttachment = ChannelAttachment & { text?: undefined };
export type ComposerAttachment =
  | UploadedComposerAttachment
  | {
      name: string;
      text: string;
      id?: undefined;
      sizeBytes?: undefined;
    };
export interface ComposerSkill {
  id: string;
  name: string;
  version: string;
}

export function composeTaskText(
  text: string,
  attachments: ComposerAttachment[] = [],
  skills: ComposerSkill[] = [],
): string {
  const parts = [text.trim()];
  if (skills.length)
    parts.push(
      `Requested reviewed skills (use only if still assigned and verified):\n${skills.map((skill) => `${skill.name} · v${skill.version} (${skill.id})`).join("\n")}`,
    );
  for (const file of attachments)
    parts.push(
      file.id
        ? `User-provided attachment: ${file.name} (${file.mediaType}, ${file.sizeBytes} bytes)\n[OpenBot attachment: ${file.id}]`
        : `User-provided attachment: ${file.name}\n${file.text}`,
    );
  return parts.filter(Boolean).join("\n\n");
}

export async function readComposerAttachment(file: File): Promise<ComposerAttachment> {
  if (!/\.(txt|md|csv|json)$/i.test(file.name) || file.size > 6000)
    throw new Error("请选择不超过 6 KB 的 TXT、Markdown、CSV 或 JSON 文件。");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  if (text.includes("\0")) throw new Error("附件必须是 UTF-8 文本文件。");
  return {
    name: Array.from(file.name, (character) => (character.charCodeAt(0) < 32 ? " " : character))
      .join("")
      .slice(0, 160),
    text,
  };
}

export const COMPOSER_ATTACHMENT_ACCEPT = ATTACHMENT_ACCEPT;
export const MAX_COMPOSER_ATTACHMENTS = MAX_TASK_ATTACHMENTS;
export const MAX_COMPOSER_ATTACHMENT_BYTES = MAX_TASK_ATTACHMENT_BYTES;

export function validateComposerFile(file: File): void {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!ATTACHMENT_EXTENSIONS.includes(extension))
    throw new Error(
      "暂不支持此文件格式，请选择文本、代码、图片、PDF、Office 文档或 MP3、WAV、M4A、MP4、WebM。",
    );
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u.test(file.name))
    throw new Error("附件名称须为 160 字符以内的普通文件名。");
  const max = attachmentExtensionByteLimit(extension);
  if (file.size === 0 || file.size > max)
    throw new Error("附件大小超限：文本/代码 256 KB，图片 5 MB，文档/媒体 10 MB；不能上传空文件。");
}

export function validateComposerAttachmentBatch(
  existing: ComposerAttachment[],
  files: File[],
): void {
  if (existing.length + files.length > MAX_COMPOSER_ATTACHMENTS)
    throw new Error("每条消息最多添加 8 个附件。");
  let bytes = existing.reduce(
    (sum, item) => sum + (item.sizeBytes ?? new TextEncoder().encode(item.text).byteLength),
    0,
  );
  const names = new Set(existing.map((item) => item.name));
  for (const file of files) {
    validateComposerFile(file);
    bytes += file.size;
    if (names.has(file.name)) throw new Error("已添加同名附件，请先移除后重试。");
    names.add(file.name);
  }
  if (bytes > MAX_COMPOSER_ATTACHMENT_BYTES) throw new Error("每条消息的附件合计不能超过 20 MB。");
}

export async function uploadComposerAttachment(
  channelId: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadedComposerAttachment> {
  validateComposerFile(file);
  const response = await fetch(`/api/v1/channels/${encodeURIComponent(channelId)}/attachments`, {
    method: "POST",
    credentials: "include",
    redirect: "error",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-OpenBot-Filename": encodeURIComponent(file.name),
    },
    body: file,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("附件上传未返回有效响应。");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) throw new Error("附件上传响应过大。");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result = JSON.parse(new TextDecoder().decode(data)) as {
    attachment?: UploadedComposerAttachment;
    error?: string;
  };
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error.slice(0, 500)
        : "附件上传失败，请检查连接后重试。",
    );
  const parsed = attachmentMetadataSchema.safeParse(result.attachment);
  const attachment = parsed.success ? parsed.data : undefined;
  if (
    !attachment ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(attachment.id) ||
    attachment.channelId !== channelId ||
    attachment.name !== file.name ||
    attachment.sizeBytes !== file.size ||
    !/^[a-f0-9]{64}$/u.test(attachment.sha256)
  )
    throw new Error("附件上传响应与当前文件不匹配。");
  return attachment;
}
