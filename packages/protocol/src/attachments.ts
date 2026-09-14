import { z } from "zod";

export const attachmentOperations = ["extract", "ocr", "transcribe"] as const;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TASK_ATTACHMENTS = 8;
export const TEXT_ATTACHMENT_EXTENSIONS =
  "txt md markdown csv tsv json jsonl yaml yml xml html css js jsx ts tsx mjs cjs py go rs java c cpp cxx h hpp swift kt kts sh bash zsh sql toml ini conf log r rb php vue svelte diff patch tex rst ipynb srt".split(
    " ",
  );
export const attachmentMediaTypes = [
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/webm",
  "video/mp4",
  "video/webm",
] as const;
export const attachmentMetadataSchema = z
  .object({
    id: z.string().uuid(),
    channelId: z.string().uuid(),
    name: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u),
    mediaType: z.enum(attachmentMediaTypes),
    sizeBytes: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().optional(),
    processing: z
      .object({
        operation: z.enum(attachmentOperations),
        characters: z.number().int().min(0).max(262144),
        truncated: z.boolean(),
        processedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (attachment) => attachment.sizeBytes <= attachmentByteLimit(attachment.mediaType),
    "Attachment exceeds its media limit.",
  );
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_EXTENSIONS = [
  ...TEXT_ATTACHMENT_EXTENSIONS,
  "png",
  "jpg",
  "jpeg",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "webm",
];
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(
  ",",
);
export type ChannelAttachment = z.infer<typeof attachmentMetadataSchema>;
export type AttachmentOperation = NonNullable<ChannelAttachment["processing"]>["operation"];
export function attachmentByteLimit(mediaType: (typeof attachmentMediaTypes)[number]): number {
  return mediaType === "text/plain"
    ? MAX_TEXT_ATTACHMENT_BYTES
    : mediaType.startsWith("image/")
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : MAX_ATTACHMENT_BYTES;
}
export function attachmentExtensionByteLimit(extension: string): number {
  return TEXT_ATTACHMENT_EXTENSIONS.includes(extension)
    ? MAX_TEXT_ATTACHMENT_BYTES
    : ["png", "jpg", "jpeg"].includes(extension)
      ? MAX_IMAGE_ATTACHMENT_BYTES
      : MAX_ATTACHMENT_BYTES;
}
