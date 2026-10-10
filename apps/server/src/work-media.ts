/** Validates immutable attachment media manifests and live access before model use. */
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession } from "./owner-files.js";
import { attachmentRead } from "./work-attachment.js";
import type { WorkFiles } from "./work-files.js";
import { workEvent, type WorkDb } from "./work-handoff.js";
import { currentWork, type WorkScope } from "./work-ledger.js";
import { resolveWorkSource, sourceWorkAttachments, workAttachmentIds } from "./work-source.js";
import { workCanonical } from "./work-values.js";
import { type WorkMediaItem, validateMediaItems } from "./work-model-media.js";

const reference = z.strictObject({
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(1).max(12288),
});
/** Immutable manifest only in Work storage; original media stays under the existing Owner file lease. */
export class WorkMedia {
  constructor(readonly files: WorkFiles) {}
  private async manifest(db: WorkDb, scope: WorkScope, session?: FileSession, hydrate = false) {
    const task = await currentWork(db, scope),
      source = await resolveWorkSource(db, task, scope.browserProfiles, scope.commandProfiles);
    const attached = sourceWorkAttachments(source, task.objective, session);
    if (
      source.kind === "task" &&
      (workAttachmentIds(task.objective).some((id) => !attached.attachmentIds.includes(id)) ||
        (!source.native && /\[openbot attachment:/i.test(task.objective)))
    )
      throw new WorkConflict("attachment_outside_task");
    const binary: WorkMediaItem[] = [];
    const items = attached.attachmentIds.map((id) => {
      const { item, data } = session!.content(attached.channelId, id);
      let mode: "text" | "derived" | "binary" = "binary",
        derivedSha256: string | null = null;
      if (item.processing || item.mediaType === "text/plain") {
        const read = attachmentRead(session, attached, { attachmentId: id, offset: 0, limit: 1 });
        mode = item.processing ? "derived" : "text";
        derivedSha256 = read.snapshot.derivedSha256;
      } else {
        const media = {
          attachmentId: id,
          name: item.name,
          mediaType: item.mediaType,
          sha256: item.sha256,
          data,
        };
        validateMediaItems([media]);
        if (hydrate) binary.push(media);
      }
      return {
        id,
        name: item.name,
        mediaType: item.mediaType,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        metadataSha256: workCanonical(item).digest,
        mode,
        derivedSha256,
      };
    });
    return {
      manifest: {
        version: 1,
        taskId: task.id,
        runId: scope.binding.input.runId,
        source: source.provenance,
        items,
      },
      binary,
    };
  }
  private async anchor(db: WorkDb, scope: WorkScope) {
    const rows =
      await db`SELECT payload FROM work_events WHERE task_id=${scope.binding.input.taskId} AND kind='model.media_bound' AND payload->>'runId'=${scope.binding.input.runId} ORDER BY revision LIMIT 2`;
    if (!rows.length) return null;
    if (
      rows.length !== 1 ||
      Object.keys(rows[0]!.payload).sort().join(",") !== "inputMedia,runId" ||
      rows[0]!.payload.runId !== scope.binding.input.runId
    )
      throw new WorkConflict("model_media_binding_changed");
    return reference.parse(rows[0]!.payload.inputMedia);
  }
  async prepare(db: WorkDb, scope: WorkScope, session?: FileSession) {
    const { manifest } = await this.manifest(db, scope, session),
      anchored = await this.anchor(db, scope);
    if (!manifest.items.length) {
      if (anchored) throw new WorkConflict("model_media_binding_changed");
      return;
    }
    const encoded = workCanonical(manifest, 12288),
      ref = {
        version: 1 as const,
        sha256: encoded.digest,
        sizeBytes: Buffer.byteLength(encoded.wire),
      };
    if (anchored) {
      if (
        workCanonical(ref).wire !== workCanonical(anchored).wire ||
        this.files.read(anchored).toString("utf8") !== encoded.wire
      )
        throw new WorkConflict("attachment_unavailable");
      return;
    }
    if (
      (
        await db`SELECT 1 FROM work_actions WHERE task_id=${scope.binding.input.taskId} AND run_id=${scope.binding.input.runId} LIMIT 1`
      ).length
    )
      throw new WorkConflict("model_media_bootstrap_required");
    this.files.put(Buffer.from(encoded.wire));
    await workEvent(db, scope.binding.input.taskId, "model.media_bound", {
      runId: scope.binding.input.runId,
      inputMedia: ref,
    });
  }
  async validate(db: WorkDb, scope: WorkScope, session?: FileSession, hydrate = false) {
    const { manifest, binary } = await this.manifest(db, scope, session, hydrate),
      ref = await this.anchor(db, scope);
    if (!manifest.items.length) {
      if (ref) throw new WorkConflict("model_media_binding_changed");
      return { reference: null, binary, attachments: [], reservation: 0 };
    }
    if (!ref) throw new WorkConflict("model_media_binding_required");
    const encoded = workCanonical(manifest, 12288);
    if (
      encoded.digest !== ref.sha256 ||
      Buffer.byteLength(encoded.wire) !== ref.sizeBytes ||
      this.files.read(ref).toString("utf8") !== encoded.wire
    )
      throw new WorkConflict("attachment_unavailable");
    return {
      reference: ref,
      binary,
      attachments: manifest.items.map(
        ({ metadataSha256: _metadata, derivedSha256: _derived, ...item }) => item,
      ),
      reservation: manifest.items.filter((i) => i.mode === "binary").length * 8192,
    };
  }
}
