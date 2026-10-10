/** Projects authenticated channel messages, membership and bounded reaction reads. */
import { reportFailure } from "./logging.js";
/** Serves bounded channel projections with read-only transactions and final session validation. */
import { databasePool } from "./database-pool.js";
import { sessionDigest, requireOwnerSession } from "./owner-session.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import postgres from "postgres";
import { controlHttpOperations } from "@openbot/protocol";
import { boundedAdmission } from "./request-limits.js";
import { scalarText } from "./owner-auth-crypto.js";
import { HttpFailure, storageUnavailable } from "./http-errors.js";
import { ownerCookie } from "./transcription-read.js";
import { botsQuery, channelsQuery, messagesQuery, runsQuery } from "./channel-read-query.js";
import {
  botProjection,
  channelProjection,
  messageProjection,
  runProjection,
  channelIdentity,
  messagePagination,
  encodeCursor,
  boundedProjection,
} from "./channel-read-projection.js";

const paths = [
  "/api/v1/bots",
  "/api/v1/channels",
  "/api/v1/channels/{channel_id}/messages",
  "/api/v1/channels/{channel_id}/runs",
];
const operationIds = ["listBots", "listChannels", "listMessages", "listRuns"];
for (const [index, id] of operationIds.entries()) {
  const operation = controlHttpOperations.find((item) => item.operationId === id);
  if (!operation || operation.method !== "get" || operation.path !== paths[index])
    throw new Error("Channel read operation is absent from the shared inventory.");
}
const matchPath = (path: string) => {
  if (path === paths[0]) return { kind: "bots" as const };
  if (path === paths[1]) return { kind: "channels" as const };
  const match = /^\/api\/v1\/channels\/([^/]+)\/(messages|runs)$/.exec(path);
  return match ? { kind: match[2] as "messages" | "runs", channelId: match[1]! } : undefined;
};

export function channelReader(
  options: { databaseUrl: string; allowedOrigins?: readonly string[] },
  publicOrigin: string,
  secure: boolean,
) {
  const pool = databasePool(options.databaseUrl);
  const sql = pool.sql;
  const admit = boundedAdmission(4);
  return {
    close: () => pool.close(),
    async verify() {
      await sql`SELECT token_digest,owner_id,revoked_at,expires_at FROM auth_sessions WHERE false`;
      await sql`SELECT id,name,role,status,computer_profile,configuration,created_at FROM bots WHERE false`;
      await sql`SELECT id,direct_bot_id,deleted_at FROM channels WHERE false`;
      await sql`SELECT id,origin,reply_to_message_id,content,created_at FROM messages WHERE false`;
      await sql`SELECT id,model_usage,model_selection,work_task_id FROM runs_work_projection WHERE false`;
    },
    owns: (method: string, path: string) => method === "GET" && matchPath(path) !== undefined,
    async handle(request: FastifyRequest, reply: FastifyReply) {
      const raw = request.raw.url ?? "";
      const separator = raw.indexOf("?");
      const rawPath = separator < 0 ? raw : raw.slice(0, separator);
      const query = separator < 0 ? "" : raw.slice(separator + 1);
      const route = matchPath(decodeURIComponent(rawPath))!;
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const origin = request.headers.origin;
      if (origin) {
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Access-Control-Expose-Headers", "X-OpenBot-Next-Before");
        if ((options.allowedOrigins ?? [publicOrigin]).includes(origin)) {
          reply.header("Access-Control-Allow-Origin", origin);
          reply.header("Vary", "Origin");
        }
      }
      try {
        const channelId =
          route.channelId === undefined ? undefined : channelIdentity(route.channelId);
        const page = route.kind === "messages" ? messagePagination(query, channelId!) : undefined;
        const token = ownerCookie(request.headers.cookie, secure);
        const digest = sessionDigest(token);
        const result = await admit(abort.signal, (check) =>
          sql.begin("isolation level read committed read only", async (db) => {
            const authorized = async () => {
              check();
              await requireOwnerSession(db, digest);
              check();
            };
            await authorized();
            if (page?.boundary && !scalarText(page.boundary.id)) throw storageUnavailable();
            const operation =
              route.kind === "messages"
                ? messagesQuery(channelId!, page!.limit, page!.boundary)
                : {
                    text:
                      route.kind === "bots"
                        ? botsQuery
                        : route.kind === "channels"
                          ? channelsQuery
                          : runsQuery,
                    values: route.kind === "runs" ? [channelId!] : [],
                  };
            const rows = await db.unsafe(operation.text, operation.values);
            // READ COMMITTED sees logout/expiry committed while the projection query was blocked.
            // Recheck before a missing-channel or bad-record error can disclose scoped facts.
            await authorized();
            if (channelId !== undefined && !rows.length)
              throw new HttpFailure(404, { error: "Channel not found." });
            if (rows.some((row) => row.oversized)) throw storageUnavailable();
            const present = rows.filter((row) => row.id != null);
            const ceiling =
              route.kind === "bots"
                ? 1000
                : route.kind === "channels"
                  ? 10000
                  : route.kind === "runs"
                    ? 50
                    : page!.limit;
            if (present.length > ceiling) throw storageUnavailable();
            let projection: unknown;
            if (route.kind === "bots") projection = { bots: present.map(botProjection) };
            else if (route.kind === "channels")
              projection = { channels: channelProjection(present) };
            else if (route.kind === "runs") projection = { runs: present.map(runProjection) };
            else
              projection = {
                messages: present.map(messageProjection),
                hasMore: Boolean(rows[0]?.has_more),
                ...(rows[0]?.has_more && present.length
                  ? { nextCursor: encodeCursor(channelId!, present[0]!) }
                  : {}),
              };
            check();
            return boundedProjection(projection);
          }),
        );
        if (!reply.raw.destroyed) return reply.send(result);
      } catch (error) {
        reportFailure("channel-read", error, { requestId: request.id });
        const failure = error instanceof HttpFailure ? error : storageUnavailable(error);
        if (!reply.raw.destroyed) return reply.code(failure.status).send(failure.body);
      }
    },
  };
}
