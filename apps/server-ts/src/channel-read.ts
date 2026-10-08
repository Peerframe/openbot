import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import postgres from "postgres";
import { controlHttpOperations } from "@openbot/protocol";
import { boundedAdmission, scalarText } from "./owner-auth-crypto.js";
import { WriteFailure, writeUnavailable } from "./primary-bot-write.js";
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
  const sql = postgres(options.databaseUrl, {
    max: 4,
    connect_timeout: 3,
    onnotice: () => undefined,
    connection: {
      application_name: "openbot-ts-channel-read",
      default_transaction_read_only: true,
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      search_path: "public,pg_catalog",
      timezone: "UTC",
    },
  });
  const admit = boundedAdmission(4);
  const unauthorized = () => new WriteFailure(401, { error: "Authentication required." });
  return {
    close: () => sql.end({ timeout: 1 }),
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
        if (!token) throw unauthorized();
        const digest = createHash("sha256").update(token, "ascii").digest("hex");
        const result = await admit(abort.signal, (check) =>
          sql.begin("isolation level read committed read only", async (db) => {
            const authorized = async () => {
              check();
              const rows =
                await db`SELECT token_digest FROM auth_sessions WHERE token_digest=${digest}
              AND owner_id='owner' AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1`;
              check();
              if (rows.length !== 1) throw unauthorized();
            };
            await authorized();
            if (page?.boundary && !scalarText(page.boundary.id)) throw writeUnavailable();
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
              throw new WriteFailure(404, { error: "Channel not found." });
            if (rows.some((row) => row.oversized)) throw writeUnavailable();
            const present = rows.filter((row) => row.id != null);
            const ceiling =
              route.kind === "bots"
                ? 1000
                : route.kind === "channels"
                  ? 10000
                  : route.kind === "runs"
                    ? 50
                    : page!.limit;
            if (present.length > ceiling) throw writeUnavailable();
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
        const failure = error instanceof WriteFailure ? error : writeUnavailable();
        if (!reply.raw.destroyed) return reply.code(failure.status).send(failure.body);
      }
    },
  };
}
