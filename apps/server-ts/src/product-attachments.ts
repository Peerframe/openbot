import { createHash } from "node:crypto";
import { closeSync, constants } from "node:fs";
import type postgres from "postgres";
import { attachmentReferences, withReferenceCounts } from "./attachment-references.js";
import { attachmentUpload } from "./attachment-upload.js";
import { type Attachment, FileSession, OwnerFiles, readFileAt } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { openAt, openDirectory } from "./posix-files.js";
import type { AuthorizedProductOperation, ProductRoute } from "./product-identity.js";
import { ProductBytes } from "./product-response.js";

export async function attachmentChannel(db: postgres.TransactionSql, channel: string | null) {
  if (
    channel !== null &&
    !(await db`SELECT id FROM channels WHERE id=${channel} AND deleted_at IS NULL FOR SHARE`).length
  )
    return refuse(404, "channel_not_found");
}
export const download = (data: Buffer, name: string, media = "application/octet-stream") =>
  new ProductBytes(data, {
    "Content-Type": media,
    "Content-Length": String(data.length),
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition":
      "attachment; filename*=UTF-8''" +
      encodeURIComponent(name).replace(
        /[!'()*]/g,
        (value) => "%" + value.charCodeAt(0).toString(16).toUpperCase(),
      ),
  });
export async function fileMutation(
  files: OwnerFiles,
  owner: AuthorizedProductOperation,
  channel: string | null,
  id: string | undefined,
  operation: (session: FileSession) => Attachment,
  signal: AbortSignal,
) {
  return files.withLock(async (session) => {
    let prior: Buffer | undefined, created: string | undefined;
    try {
      return await owner(async (db) => {
        await attachmentChannel(db, channel);
        if (id) prior = session.read(id + ".json", 4096);
        const result = operation(session);
        if (!id) created = result.id;
        return result;
      }, session.signal);
    } catch (error) {
      if (prior) session.write(id + ".json", prior);
      if (created) {
        session.remove(created + ".json");
        session.remove(created + ".bin");
      }
      throw error;
    }
  }, signal);
}
export function attachmentRoutes(files: OwnerFiles, objectRoot: string): ProductRoute[] {
  const routes: ProductRoute[] = [];
  for (const ownerScope of [true, false]) {
    const base = ownerScope
      ? "/api/v1/task-attachments"
      : "/api/v1/channels/{channel_id}/attachments";
    const scope = (ids: string[]) => ({
      channel: ownerScope ? null : ids[0]!,
      id: ids[ownerScope ? 0 : 1]!,
    });
    const add = (
      method: string,
      path: string,
      remote: NonNullable<ProductRoute["remote"]>,
      extra: Partial<ProductRoute> = {},
    ) =>
      routes.push({
        method,
        path: base + path,
        kind: "product",
        remote,
        execute: async () => {
          throw new Error("File authority must hold its inode lock.");
        },
        ...extra,
      });
    const read =
      (
        action: (
          session: FileSession,
          db: postgres.TransactionSql,
          channel: string | null,
          id: string,
          query: URLSearchParams,
        ) => Promise<unknown>,
      ): NonNullable<ProductRoute["remote"]> =>
      (owner, ids, _body, signal, request) => {
        const { channel, id } = scope(ids);
        return files.withLock(
          (session) =>
            owner(async (db) => {
              await attachmentChannel(db, channel);
              return action(session, db, channel, id, request.query);
            }, session.signal),
          signal,
        );
      };
    add(
      "GET",
      "",
      read(async (session, db, channel) => ({
        attachments:
          channel === null
            ? session.list(null)
            : await withReferenceCounts(db, channel, session.list(channel)),
      })),
    );
    add(
      "POST",
      "",
      async (owner, ids, _body, signal, request) => {
        const { name, data } = await attachmentUpload(request.payload, request.headers, signal),
          { channel } = scope(ids);
        return {
          attachment: await fileMutation(
            files,
            owner,
            channel,
            undefined,
            (session) => session.persist(channel, name, data),
            signal,
          ),
        };
      },
      { status: 201, maxBytes: 32768 },
    );
    add(
      "GET",
      "/{attachment_id}",
      read(async (session, _db, channel, id) => ({ attachment: session.metadata(channel, id) })),
    );
    add(
      "GET",
      "/{attachment_id}/content",
      read(async (session, _db, channel, id) => {
        const { item, data } = session.content(channel, id);
        if (channel === null && item.deletedAt) return refuse(404, "attachment_deleted");
        return download(data, item.name);
      }),
    );
    if (!ownerScope)
      add(
        "GET",
        "/{attachment_id}/references",
        read(async (session, db, channel, id, query) => {
          const item = session.metadata(channel, id);
          return attachmentReferences(db, channel!, item.id, query);
        }),
      );
    for (const deleted of [true, false])
      add(
        deleted ? "DELETE" : "POST",
        "/{attachment_id}" + (deleted ? "" : "/restore"),
        async (owner, ids, body, signal) => {
          if (
            ownerScope &&
            body !== null &&
            (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
          )
            return refuse(422, "invalid_attachment_command");
          const { channel, id } = scope(ids);
          return {
            attachment: await fileMutation(
              files,
              owner,
              channel,
              id,
              (session) => session.setDeleted(channel, id, deleted),
              signal,
            ),
          };
        },
      );
  }
  routes.push({
    method: "GET",
    path: "/api/v1/artifacts/{artifact_id}/content",
    kind: "product",
    execute: async (db, ids) => {
      const [row] =
        await db`SELECT name,media_type,storage_key,sha256,metadata FROM artifacts WHERE id=${ids[0]!}`;
      if (!row) return refuse(404, "artifact_not_found");
      if (
        typeof row.storage_key !== "string" ||
        !/^runs\/[0-9a-f-]+\/[0-9a-f-]+\.(?:png|md)$/i.test(row.storage_key)
      )
        return refuse(503, "artifact_storage_key_refused");
      const parts = row.storage_key.split("/");
      let fd = openDirectory(objectRoot, false),
        data: Buffer;
      try {
        for (const part of parts.slice(0, -1)) {
          const child = openAt(fd, part, constants.O_RDONLY | constants.O_DIRECTORY);
          closeSync(fd);
          fd = child;
        }
        data = readFileAt(fd, parts.at(-1)!, 5 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
      if (
        data.length !== row.metadata?.sizeBytes ||
        createHash("sha256").update(data).digest("hex") !== row.sha256
      )
        return refuse(503, "artifact_integrity");
      return download(data, row.name as string, row.media_type as string);
    },
  });
  return routes;
}
