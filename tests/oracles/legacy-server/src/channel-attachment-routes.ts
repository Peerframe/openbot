import { attachmentOperations } from "@openbot/protocol";
import type { Env, Hono } from "hono";
import { z } from "zod";
import type { AttachmentProcessingService } from "./attachment-processing.js";
import {
  AttachmentError,
  type ChannelAttachmentStorage,
  MAX_ATTACHMENT_BYTES,
} from "./channel-attachments.js";

export interface ChannelAttachmentRouteDependencies {
  storage: ChannelAttachmentStorage;
  processing?: AttachmentProcessingService;
  isReferenced?(channelId: string, attachmentId: string): Promise<boolean>;
  channelExists(channelId: string): Promise<boolean>;
}

/** Register only after the app's Owner authentication and Origin-policy middleware. */
export function registerChannelAttachmentRoutes<E extends Env>(
  app: Hono<E>,
  dependencies: ChannelAttachmentRouteDependencies,
): void {
  const prefix = "/api/v1/channels/:channelId/attachments";
  app.get(prefix, async (context) => {
    const channelId = context.req.param("channelId");
    if (!(await dependencies.channelExists(channelId)))
      return context.json({ error: "Channel not found." }, 404);
    if (!dependencies.storage.list)
      return context.json({ error: "Attachment listing unavailable." }, 503);
    return context.json({ attachments: await dependencies.storage.list(channelId) });
  });
  app.post(`${prefix}/cleanup`, async (context) => {
    try {
      const channelId = context.req.param("channelId");
      if (!(await dependencies.channelExists(channelId)))
        throw new AttachmentError("Channel not found.", 404);
      if (!dependencies.storage.cleanup || !dependencies.isReferenced)
        throw new AttachmentError("Reference-safe cleanup is unavailable.", 503);
      const input = z
        .object({ olderThanDays: z.number().int().min(7).max(365) })
        .strict()
        .parse(await boundedJson(context.req.raw));
      const before = new Date(Date.now() - input.olderThanDays * 86400000).toISOString();
      return context.json(
        await dependencies.storage.cleanup(channelId, before, (id) =>
          dependencies.isReferenced
            ? dependencies.isReferenced(channelId, id)
            : Promise.resolve(true),
        ),
      );
    } catch (error) {
      return context.json(
        { error: error instanceof AttachmentError ? error.message : "Invalid cleanup request." },
        error instanceof AttachmentError ? error.status : 400,
      );
    }
  });
  app.post(`${prefix}/:attachmentId/process`, async (context) => {
    try {
      const channelId = context.req.param("channelId");
      if (!(await dependencies.channelExists(channelId)))
        throw new AttachmentError("Channel not found.", 404);
      if (!dependencies.processing)
        throw new AttachmentError("Attachment processing unavailable.", 503);
      const input = z
        .object({
          operation: z.enum(attachmentOperations),
          password: z.string().max(256).optional(),
        })
        .strict()
        .parse(await boundedJson(context.req.raw));
      return context.json({
        attachment: await dependencies.processing.process(
          channelId,
          context.req.param("attachmentId"),
          input,
          context.req.raw.signal,
        ),
      });
    } catch (error) {
      return context.json(
        {
          error: error instanceof AttachmentError ? error.message : "Attachment processing failed.",
        },
        error instanceof AttachmentError ? error.status : 400,
      );
    }
  });
  for (const operation of ["delete", "restore"] as const) {
    const handler = async (context: import("hono").Context<E>) => {
      try {
        const channelId = context.req.param("channelId");
        const attachmentId = context.req.param("attachmentId");
        if (!channelId || !attachmentId || !(await dependencies.channelExists(channelId)))
          throw new AttachmentError("Channel not found.", 404);
        if (!dependencies.storage.setDeleted)
          throw new AttachmentError("Attachment lifecycle unavailable.", 503);
        return context.json({
          attachment: await dependencies.storage.setDeleted(
            channelId,
            attachmentId,
            operation === "delete",
          ),
        });
      } catch (error) {
        return context.json(
          { error: error instanceof AttachmentError ? error.message : "Attachment update failed." },
          error instanceof AttachmentError ? error.status : 503,
        );
      }
    };
    if (operation === "delete") app.delete(`${prefix}/:attachmentId`, handler);
    else app.post(`${prefix}/:attachmentId/restore`, handler);
  }
  app.post(prefix, async (context) => {
    try {
      const channelId = context.req.param("channelId");
      if (!(await dependencies.channelExists(channelId)))
        return context.json({ error: "Channel not found." }, 404);
      if (context.req.header("content-type") !== "application/octet-stream")
        return context.json({ error: "Use a raw attachment body." }, 415);
      const encodedName = context.req.header("x-openbot-filename");
      if (!encodedName || encodedName.length > 2048)
        throw new AttachmentError("Missing attachment filename.");
      let name: string;
      try {
        name = decodeURIComponent(encodedName);
      } catch {
        throw new AttachmentError("Invalid attachment filename encoding.");
      }
      const bytes = await readUpload(context.req.raw);
      const attachment = await dependencies.storage.persist(channelId, name, bytes);
      return context.json({ attachment }, 201);
    } catch (error) {
      return context.json(
        { error: error instanceof AttachmentError ? error.message : "Attachment upload failed." },
        error instanceof AttachmentError ? error.status : 503,
      );
    }
  });
  app.get(`${prefix}/:attachmentId`, async (context) => {
    try {
      const channelId = context.req.param("channelId");
      if (!(await dependencies.channelExists(channelId)))
        throw new AttachmentError("Channel not found.", 404);
      return context.json({
        attachment: await dependencies.storage.metadata(
          channelId,
          context.req.param("attachmentId"),
        ),
      });
    } catch (error) {
      return context.json(
        { error: error instanceof AttachmentError ? error.message : "Attachment unavailable." },
        error instanceof AttachmentError ? error.status : 503,
      );
    }
  });
  app.get(`${prefix}/:attachmentId/content`, async (context) => {
    try {
      const channelId = context.req.param("channelId");
      if (!(await dependencies.channelExists(channelId)))
        throw new AttachmentError("Channel not found.", 404);
      const { attachment, bytes } = await dependencies.storage.read(
        channelId,
        context.req.param("attachmentId"),
      );
      // Even HTML/code and PDFs download as opaque bytes; they are never rendered in this origin.
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
          "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return context.json(
        { error: error instanceof AttachmentError ? error.message : "Attachment unavailable." },
        error instanceof AttachmentError ? error.status : 503,
      );
    }
  });
}

async function readUpload(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new AttachmentError("Missing attachment bytes.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachment exceeds 10 MiB.", 413);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new AttachmentError("Missing JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 4096) throw new AttachmentError("Attachment request exceeds limit.", 413);
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
