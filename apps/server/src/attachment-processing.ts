/** Coordinates bounded attachment parsing and transcription against persisted state. */
import { attachmentProcessInputSchema } from "@openbot/protocol";
import {
  boundedAttachmentText,
  boundedImage,
  NodeAttachmentParser,
  parsedAttachment,
  parserResponseMaximum,
  type ProcessCommand,
} from "./attachment-parser.js";
import type { AttachmentTranscription } from "./attachment-transcription.js";
import { attachmentId, type Attachment, OwnerFiles } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { attachmentChannel } from "./product-attachments.js";
import type { AuthorizedProductOperation, ProductRoute } from "./product-identity.js";

type Derived = {
  text: string;
  truncated: boolean;
  sha256: string;
  operation: ProcessCommand["operation"];
  processedAt: string;
};
export class AttachmentProcessing {
  private readonly stopping = new AbortController();
  private readonly jobs = new Set<Promise<Attachment>>();
  constructor(
    readonly files: OwnerFiles,
    readonly parser: NodeAttachmentParser,
    readonly transcription?: AttachmentTranscription,
  ) {}
  private snapshot(
    owner: AuthorizedProductOperation,
    channel: string | null,
    id: string,
    signal: AbortSignal,
  ) {
    return this.files.withLock(
      (session) =>
        owner(async (db) => {
          await attachmentChannel(db, channel);
          const value = session.content(channel, id);
          if (value.item.deletedAt) return refuse(400, "restore_attachment_before_processing");
          return value;
        }, session.signal),
      signal,
    );
  }
  async process(
    owner: AuthorizedProductOperation,
    channel: string | null,
    id: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Attachment> {
    const input = attachmentProcessInputSchema.safeParse(body);
    if (!input.success) return refuse(422, "Invalid request input.");
    if (!attachmentId.test(id) || (channel !== null && !attachmentId.test(channel)))
      return refuse(404, "attachment_not_found");
    if (this.jobs.size >= 2) return refuse(503, "attachment_processing_busy");
    const bounded = AbortSignal.any([signal, this.stopping.signal]);
    const work = this.perform(owner, channel, id, input.data, bounded);
    this.jobs.add(work);
    try {
      return await work;
    } finally {
      this.jobs.delete(work);
    }
  }
  private async perform(
    owner: AuthorizedProductOperation,
    channel: string | null,
    id: string,
    command: ProcessCommand,
    signal: AbortSignal,
  ) {
    const { item, data } = await this.snapshot(owner, channel, id, signal),
      extension = item.name.split(".").at(-1)!.toLowerCase();
    if (command.password && extension !== "pdf")
      return refuse(400, "password_only_supported_for_pdf");
    if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
    let parsed: unknown;
    if (command.operation === "transcribe") {
      if (!/^(audio|video)\//.test(item.mediaType))
        return refuse(415, "audio_video_attachment_required");
      if (!this.transcription) return refuse(415, "enabled_openai_transcription_required");
      parsed = await this.transcription.transcribe(owner, channel, item, data, signal);
    } else {
      if (command.operation === "ocr") {
        if (!["image/png", "image/jpeg"].includes(item.mediaType))
          return refuse(415, "ocr_image_required");
        boundedImage(data, item.mediaType);
      } else if (!["pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(extension))
        return refuse(415, "document_extraction_not_required");
      parsed = await this.parser.parse(data, extension, command, signal);
    }
    if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
    const result = parsedAttachment(parsed),
      { text, truncated } = boundedAttachmentText(result.text);
    if (!text.trim())
      return refuse(
        415,
        extension === "pdf" ? "no_readable_pdf_text" : "no_readable_attachment_text",
      );
    return this.save(
      owner,
      channel,
      id,
      {
        text,
        truncated: result.truncated || truncated,
        sha256: item.sha256,
        operation: command.operation,
        processedAt: new Date().toISOString(),
      },
      signal,
    );
  }
  private async save(
    owner: AuthorizedProductOperation,
    channel: string | null,
    id: string,
    derived: Derived,
    signal: AbortSignal,
  ) {
    return this.files.withLock(async (session) => {
      let metadata: Buffer | undefined,
        priorText: Buffer | undefined,
        changed = false;
      try {
        if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
        return await owner(async (db) => {
          await attachmentChannel(db, channel);
          const current = session.content(channel, id).item;
          if (current.deletedAt || current.sha256 !== derived.sha256)
            return refuse(404, "attachment_changed_or_deleted");
          metadata = session.read(id + ".json", 4096);
          try {
            priorText = session.read(id + ".text.json", parserResponseMaximum);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const updated = {
            ...current,
            processing: {
              operation: derived.operation,
              characters: derived.text.length,
              truncated: derived.truncated,
              processedAt: derived.processedAt,
            },
          };
          if (signal.aborted) return refuse(400, "attachment_processing_cancelled");
          changed = true;
          session.write(id + ".text.json", Buffer.from(JSON.stringify(derived)));
          session.write(id + ".json", Buffer.from(JSON.stringify(updated)));
          return updated;
        }, session.signal);
      } catch (error) {
        if (changed) {
          if (priorText === undefined) session.remove(id + ".text.json");
          else session.write(id + ".text.json", priorText);
          session.write(id + ".json", metadata!);
        }
        throw error;
      }
    }, signal);
  }
  async close() {
    this.stopping.abort();
    await Promise.allSettled([...this.jobs]);
  }
}
export function processingRoutes(service: AttachmentProcessing): ProductRoute[] {
  return [true, false].map((ownerScope) => ({
    method: "POST",
    path: ownerScope
      ? "/api/v1/task-attachments/{attachment_id}/process"
      : "/api/v1/channels/{channel_id}/attachments/{attachment_id}/process",
    kind: "product",
    maxBytes: 4096,
    remote: async (owner, ids, body, signal) => ({
      attachment: await service.process(
        owner,
        ownerScope ? null : ids[0]!,
        ids[ownerScope ? 0 : 1]!,
        body,
        signal,
      ),
    }),
    execute: async () => {
      throw new Error("Attachment processing must own locks and child lifetime.");
    },
  }));
}
