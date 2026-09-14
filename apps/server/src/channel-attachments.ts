import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AttachmentOperation,
  attachmentOperations,
  type ChannelAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  attachmentMetadataSchema as metadataSchema,
  TEXT_ATTACHMENT_EXTENSIONS,
} from "@openbot/protocol";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

export {
  attachmentMediaTypes,
  type ChannelAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENT_BYTES,
  MAX_TASK_ATTACHMENTS,
} from "@openbot/protocol";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const TEXT_EXTENSIONS = new Set(TEXT_ATTACHMENT_EXTENSIONS);
const derivedSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    text: z.string().max(262144),
    operation: z.enum(attachmentOperations),
    truncated: z.boolean(),
    processedAt: z.iso.datetime(),
  })
  .strict();
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415 | 503 = 400,
  ) {
    super(message);
  }
}
export interface DerivedAttachmentText {
  sha256: string;
  text: string;
  operation: AttachmentOperation;
  truncated: boolean;
  processedAt: string;
}
export type ValidateAttachmentReferences = (channelId: string, ids: string[]) => Promise<void>;
export interface ChannelAttachmentStorage {
  withReferenceLock?<T>(
    persist: (validate: ValidateAttachmentReferences) => Promise<T>,
  ): Promise<T>;
  withActiveReferences?<T>(channelId: string, ids: string[], persist: () => Promise<T>): Promise<T>;
  list?(channelId: string): Promise<ChannelAttachment[]>;
  setDeleted?(channelId: string, id: string, deleted: boolean): Promise<ChannelAttachment>;
  cleanup?(
    channelId: string,
    before: string,
    isReferenced: (id: string) => Promise<boolean>,
  ): Promise<{ removed: number; retained: number }>;
  derived?(channelId: string, id: string): Promise<DerivedAttachmentText | undefined>;
  saveDerived?(
    channelId: string,
    id: string,
    value: DerivedAttachmentText,
  ): Promise<ChannelAttachment>;
  persist(channelId: string, name: string, bytes: Uint8Array): Promise<ChannelAttachment>;
  metadata(channelId: string, id: string): Promise<ChannelAttachment>;
  read(channelId: string, id: string): Promise<{ attachment: ChannelAttachment; bytes: Buffer }>;
}

/** Immutable private objects; only a Server-approved channel and random IDs select storage paths. */
export class FileChannelAttachmentStorage implements ChannelAttachmentStorage {
  readonly #root: string;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    root: string,
    readonly limits = { bytes: 256 * 1024 * 1024, files: 1024 },
  ) {
    this.#root = resolve(root);
  }
  persist(channelId: string, name: string, input: Uint8Array): Promise<ChannelAttachment> {
    if (!UUID.test(channelId))
      return Promise.reject(new AttachmentError("Invalid channel identity."));
    // Snapshot caller bytes before queueing so validation, digest and disk content cannot diverge.
    const bytes = Buffer.from(input);
    const operation = this.#queue.then(async () => {
      const mediaType = validateAttachment(name, bytes);
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.#root);
      const objects = entries.filter((entry) => /^[0-9a-f-]{36}\.bin$/iu.test(entry));
      if (objects.length >= this.limits.files)
        throw new AttachmentError("Attachment storage file limit reached.", 413);
      let used = 0;
      // Count orphaned bytes after a crash as well as committed objects; no silent quota bypass.
      for (const entry of objects) used += (await stat(join(this.#root, entry))).size;
      if (used + bytes.byteLength > this.limits.bytes)
        throw new AttachmentError("Attachment storage is full.", 413);
      const attachment: ChannelAttachment = {
        id: randomUUID(),
        channelId,
        name,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: new Date().toISOString(),
      };
      const contentPath = this.#path(attachment.id, "bin");
      try {
        await writeFileAtomic(contentPath, bytes, { mode: 0o600 });
        // Metadata is the commit marker. Failed/incomplete writes never become readable objects.
        await writeFileAtomic(this.#path(attachment.id, "json"), JSON.stringify(attachment), {
          mode: 0o600,
        });
      } catch (error) {
        await rm(contentPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return attachment;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
  async metadata(channelId: string, id: string): Promise<ChannelAttachment> {
    if (!UUID.test(channelId) || !UUID.test(id))
      throw new AttachmentError("Attachment not found.", 404);
    try {
      const path = this.#path(id, "json");
      if ((await stat(path)).size > 4096) throw new Error("Oversized metadata.");
      const attachment = metadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (attachment.id !== id || attachment.channelId !== channelId)
        throw new Error("Wrong attachment scope.");
      return attachment;
    } catch {
      throw new AttachmentError("Attachment not found or metadata is invalid.", 404);
    }
  }
  async read(channelId: string, id: string) {
    const attachment = await this.metadata(channelId, id);
    const path = this.#path(id, "bin");
    try {
      if ((await stat(path)).size !== attachment.sizeBytes)
        throw new Error("Wrong attachment size.");
      const bytes = await readFile(path);
      if (
        bytes.byteLength !== attachment.sizeBytes ||
        createHash("sha256").update(bytes).digest("hex") !== attachment.sha256 ||
        validateAttachment(attachment.name, bytes) !== attachment.mediaType
      )
        throw new Error("Wrong attachment digest or media type.");
      return { attachment, bytes };
    } catch {
      throw new AttachmentError("Attachment bytes failed integrity validation.", 404);
    }
  }
  withActiveReferences<T>(channelId: string, ids: string[], persist: () => Promise<T>): Promise<T> {
    return this.withReferenceLock(async (validate) => {
      await validate(channelId, ids);
      return persist();
    });
  }
  /** Acquire before a DB transaction; the supplied validator only reads and never reacquires. */
  withReferenceLock<T>(
    persist: (validate: ValidateAttachmentReferences) => Promise<T>,
  ): Promise<T> {
    return this.#mutate(() =>
      persist((channelId, ids) => this.#validateActiveReferences(channelId, ids)),
    );
  }
  async #validateActiveReferences(channelId: string, ids: string[]): Promise<void> {
    if (
      ids.length > MAX_TASK_ATTACHMENTS ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !UUID.test(id))
    )
      throw new AttachmentError("Invalid attachment reference set.");
    let bytes = 0;
    for (const id of ids) {
      const attachment = await this.metadata(channelId, id);
      if (attachment.deletedAt)
        throw new AttachmentError(
          "A deleted attachment cannot be added to a new task. Restore it first.",
        );
      bytes += attachment.sizeBytes;
      if (bytes > MAX_TASK_ATTACHMENT_BYTES)
        throw new AttachmentError("Task attachments exceed 20 MiB.", 413);
      await this.read(channelId, id);
      if (attachment.processing) {
        try {
          const derived = await this.derived(channelId, id);
          if (!derived?.text.trim()) throw new Error("Empty processed text.");
        } catch {
          throw new AttachmentError(
            "Processed attachment text is unavailable. Reprocess the original file.",
            404,
          );
        }
      }
    }
  }
  async list(channelId: string): Promise<ChannelAttachment[]> {
    if (!UUID.test(channelId)) throw new AttachmentError("Invalid channel identity.");
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: ChannelAttachment[] = [];
    for (const name of entries
      .filter((name) => /^[0-9a-f-]{36}\.json$/iu.test(name))
      .slice(0, this.limits.files)) {
      try {
        result.push(await this.metadata(channelId, name.slice(0, -5)));
      } catch {
        /* Other channels and invalid entries reveal no metadata. */
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  setDeleted(channelId: string, id: string, deleted: boolean): Promise<ChannelAttachment> {
    return this.#mutate(async () => {
      const attachment = await this.metadata(channelId, id);
      const next = { ...attachment };
      if (deleted) next.deletedAt ??= new Date().toISOString();
      else delete next.deletedAt;
      await writeFileAtomic(this.#path(id, "json"), JSON.stringify(next), { mode: 0o600 });
      return next;
    });
  }
  async derived(channelId: string, id: string): Promise<DerivedAttachmentText | undefined> {
    const attachment = await this.metadata(channelId, id);
    if (!attachment.processing) return undefined;
    const path = this.#path(id, "text.json");
    if ((await stat(path)).size > 2 * 1024 * 1024)
      throw new AttachmentError("Derived text exceeds limit.", 413);
    const value = derivedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (value.sha256 !== attachment.sha256)
      throw new AttachmentError("Derived text digest does not match.", 404);
    return value;
  }
  saveDerived(
    channelId: string,
    id: string,
    input: DerivedAttachmentText,
  ): Promise<ChannelAttachment> {
    return this.#mutate(async () => {
      const value = derivedSchema.parse(input);
      const attachment = await this.metadata(channelId, id);
      if (value.sha256 !== attachment.sha256 || attachment.deletedAt)
        throw new AttachmentError("Attachment changed or was deleted.", 404);
      await writeFileAtomic(this.#path(id, "text.json"), JSON.stringify(value), { mode: 0o600 });
      const next = {
        ...attachment,
        processing: {
          operation: value.operation,
          characters: value.text.length,
          truncated: value.truncated,
          processedAt: value.processedAt,
        },
      };
      await writeFileAtomic(this.#path(id, "json"), JSON.stringify(next), { mode: 0o600 });
      return next;
    });
  }
  cleanup(channelId: string, before: string, isReferenced: (id: string) => Promise<boolean>) {
    return this.#mutate(async () => {
      let removed = 0;
      let retained = 0;
      for (const attachment of await this.list(channelId)) {
        if (!attachment.deletedAt || attachment.deletedAt >= before) continue;
        if (await isReferenced(attachment.id)) {
          retained += 1;
          continue;
        }
        // Metadata is removed last; a crash may leave a visible unavailable item, never foreign bytes.
        await rm(this.#path(attachment.id, "bin"), { force: true });
        await rm(this.#path(attachment.id, "text.json"), { force: true });
        await rm(this.#path(attachment.id, "json"), { force: true });
        removed += 1;
      }
      return { removed, retained };
    });
  }
  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  #path(id: string, extension: "bin" | "json" | "text.json") {
    if (!UUID.test(id)) throw new AttachmentError("Invalid attachment identity.");
    return join(this.#root, `${id}.${extension}`);
  }
}

export function validateAttachment(
  name: string,
  bytes: Uint8Array,
): ChannelAttachment["mediaType"] {
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,159}$/u.test(name))
    throw new AttachmentError("Invalid attachment filename.");
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (bytes.byteLength === 0) throw new AttachmentError("Empty files cannot be attached.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (TEXT_EXTENSIONS.has(extension)) {
    if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES)
      throw new AttachmentError("Text attachment exceeds 256 KiB.", 413);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/\0/u.test(text)) throw new Error("Binary text.");
    } catch {
      throw new AttachmentError("Text/code attachments must contain UTF-8 text.", 415);
    }
    return "text/plain";
  }
  if (extension === "png" || extension === "jpg" || extension === "jpeg") {
    if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES)
      throw new AttachmentError("Image attachment exceeds 5 MiB.", 413);
    if (
      extension === "png" &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return "image/png";
    if (
      extension !== "png" &&
      buffer.length >= 4 &&
      buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
      buffer.subarray(-2).equals(Buffer.from([255, 217]))
    )
      return "image/jpeg";
    throw new AttachmentError("Image signature does not match its filename.", 415);
  }
  if (extension === "pdf") {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
      throw new AttachmentError("PDF attachment exceeds 10 MiB.", 413);
    if (
      /^%PDF-[12]\.\d/u.test(buffer.subarray(0, 8).toString("ascii")) &&
      buffer.subarray(-1024).includes(Buffer.from("%%EOF"))
    )
      return "application/pdf";
    throw new AttachmentError("PDF signature is invalid.", 415);
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError("Attachment exceeds 10 MiB.", 413);
  const office: Record<string, ChannelAttachment["mediaType"]> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
  };
  if (office[extension]) {
    if (!buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])))
      throw new AttachmentError("Office container signature is invalid.", 415);
    return office[extension];
  }
  if (
    extension === "wav" &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WAVE"
  )
    return "audio/wav";
  if (
    extension === "mp3" &&
    (buffer.subarray(0, 3).toString() === "ID3" ||
      (buffer[0] === 255 && ((buffer[1] ?? 0) & 224) === 224))
  )
    return "audio/mpeg";
  if (["mp4", "m4a"].includes(extension) && buffer.subarray(4, 8).toString() === "ftyp")
    return extension === "m4a" ? "audio/mp4" : "video/mp4";
  if (extension === "webm" && buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return "video/webm";
  throw new AttachmentError("This attachment format is not supported.", 415);
}

/** Parse only the initial task instruction; never call this on model output or attachment text. */
export function taskAttachmentIds(instruction: string): string[] {
  const ids = Array.from(
    instruction.matchAll(
      /\[OpenBot attachment: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]/giu,
    ),
    (match) => match[1]?.toLowerCase() ?? "",
  );
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length > MAX_TASK_ATTACHMENTS)
    throw new AttachmentError("At most 8 attachments may be used per task.", 413);
  return unique;
}
