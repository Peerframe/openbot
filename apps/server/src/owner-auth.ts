/** Owns the public authentication lifecycle without delegating session authority. */
import { reportFailure } from "./logging.js";
/** Implements owner auth behavior for the Server. */
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authSessionSchema,
  controlHttpOperations,
  loginRequestSchema,
  loginResponseSchema,
  ownerPasswordChangeRequestSchema,
  ownerPasswordChangeResponseSchema,
  ownerSessionRevocationResponseSchema,
  ownerSessionsResponseSchema,
} from "@openbot/protocol";
import type { EntryOptions } from "./config.js";
import { clientDigest, digest, ownerCrypto } from "./owner-auth-crypto.js";
import { ownerAuthStore } from "./owner-auth-store.js";
import { HttpFailure, storageUnavailable } from "./http-errors.js";
import { ownerCookie } from "./transcription-read.js";
import { boundedJson } from "./write-input.js";

const paths = new Map([
  ["get /api/v1/auth/session", "session"],
  ["post /api/v1/auth/login", "login"],
  ["post /api/v1/auth/logout", "logout"],
  ["get /api/v1/auth/sessions", "sessions"],
  ["post /api/v1/auth/sessions/revoke-others", "revoke"],
  ["post /api/v1/auth/password", "password"],
]);
for (const key of paths.keys()) {
  if (!controlHttpOperations.some((operation) => `${operation.method} ${operation.path}` === key))
    throw new Error("Owner auth operation is absent from the shared inventory.");
}
export function ownerAuthentication(
  options: NonNullable<EntryOptions["ownerAuth"]>,
  publicOrigin: string,
  secure: boolean,
) {
  const store = ownerAuthStore(options.databaseUrl);
  const crypto = ownerCrypto();
  const bootstrapDigest = digest(options.password);
  const origins = options.allowedOrigins ?? [publicOrigin];
  const owner = { id: "owner", name: options.ownerName };
  const cookieName = secure ? "__Host-openbot_session" : "openbot_session";
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=strict${secure ? "; Secure" : ""}`;
  const clearCookie = () => `${cookie('""', 0)}; expires=${new Date().toUTCString()}`;
  const issued = (result: Awaited<ReturnType<typeof store.login>>) => {
    if (result.status === "invalid")
      throw new HttpFailure(401, { error: "Password is incorrect." });
    if (result.status === "throttled")
      return { retryAfter: Math.max(1, Math.min(300, result.retryAfter)) };
    return { expiresAt: result.expiresAt };
  };
  return {
    verify: store.verify,
    close: store.close,
    owns: (method: string, path: string) => paths.has(`${method.toLowerCase()} ${path}`),
    async handle(request: FastifyRequest, reply: FastifyReply) {
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const signal = abort.signal;
      const path = decodeURIComponent(request.raw.url!.split("?")[0]!);
      const operation = paths.get(`${request.method.toLowerCase()} ${path}`);
      const token = ownerCookie(request.headers.cookie, secure, false);
      if (request.headers.origin) {
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Access-Control-Expose-Headers", "X-OpenBot-Next-Before");
        if (origins.includes(request.headers.origin)) {
          reply.header("Access-Control-Allow-Origin", request.headers.origin);
          reply.header("Vary", "Origin");
        }
      }
      const throttle = (retryAfter: number) =>
        reply
          .code(429)
          .header("Retry-After", String(retryAfter))
          .send({ error: "Too many login attempts. Try again later." });
      try {
        if (
          request.method === "POST" &&
          (!request.headers.origin || !origins.includes(request.headers.origin))
        )
          throw new HttpFailure(403, { error: "Request origin is not allowed." });
        if (operation === "session") {
          const expiresAt = await store.session(token, signal);
          return reply.send(
            authSessionSchema.parse(
              expiresAt ? { authenticated: true, owner, expiresAt } : { authenticated: false },
            ),
          );
        }
        if (operation === "sessions")
          return reply.send(
            ownerSessionsResponseSchema.parse({ sessions: await store.sessions(token, signal) }),
          );
        if (operation === "logout" || operation === "revoke") {
          // Python ignores these bodies; close an unread upload rather than retaining the connection.
          if (!(request.body as Readable | undefined)?.readableEnded)
            reply.header("Connection", "close");
          if (operation === "revoke")
            return reply.send(
              ownerSessionRevocationResponseSchema.parse({
                revoked: await store.revokeOthers(token, signal),
              }),
            );
          if (!(await store.logout(token, signal)))
            throw new HttpFailure(401, { error: "Authentication required." });
          return reply.header("Set-Cookie", clearCookie()).code(204).send();
        }
        const value = await boundedJson(
          request.body as Readable,
          request.headers["content-type"],
          request.headers["content-length"],
          signal,
        );
        if (operation === "login") {
          const parsed = loginRequestSchema.safeParse(value);
          if (!parsed.success) throw new HttpFailure(422, { error: "Invalid login input." });
          const client = clientDigest(request.raw.socket.remoteAddress);
          const credential = await store.credentials(signal);
          const valid = await crypto.verify(
            parsed.data.password,
            credential?.password_hash,
            bootstrapDigest,
            signal,
          );
          const newToken = randomBytes(32).toString("base64url");
          const result = issued(
            await store.login(
              {
                valid,
                revision: credential?.revision,
                client,
                token: newToken,
                ttlHours: options.ttlHours,
                userAgent: [...(request.headers["user-agent"] ?? "")].slice(0, 256).join(""),
              },
              signal,
            ),
          );
          if (result.retryAfter !== undefined) return throttle(result.retryAfter);
          const body = loginResponseSchema.parse({
            session: { authenticated: true, owner, expiresAt: result.expiresAt },
          });
          return reply
            .header(
              "Set-Cookie",
              cookie(
                newToken,
                Math.max(1, Math.trunc((Date.parse(result.expiresAt!) - Date.now()) / 1000)),
              ),
            )
            .send(body);
        }
        if (operation === "password") {
          const parsed = ownerPasswordChangeRequestSchema.safeParse(value);
          if (!parsed.success)
            throw new HttpFailure(422, { error: "Invalid password change input." });
          const client = clientDigest(request.raw.socket.remoteAddress);
          const credential = await store.credentials(signal, token, true);
          const valid = await crypto.verify(
            parsed.data.currentPassword,
            credential?.password_hash,
            bootstrapDigest,
            signal,
          );
          const hash = valid ? await crypto.hash(parsed.data.newPassword, signal) : undefined;
          const result = issued(
            await store.rotate(
              token,
              { valid, revision: credential?.revision, client, hash },
              signal,
            ),
          );
          if (result.retryAfter !== undefined) return throttle(result.retryAfter);
          return reply
            .header("Set-Cookie", clearCookie())
            .send(
              ownerPasswordChangeResponseSchema.parse({
                changed: true,
                reauthenticationRequired: true,
              }),
            );
        }
        throw storageUnavailable();
      } catch (error) {
        if (reply.raw.destroyed) return;
        reportFailure("owner-authentication", error, { requestId: request.id });
        const failure = error instanceof HttpFailure ? error : storageUnavailable(error);
        if (!(request.body as Readable | undefined)?.readableEnded)
          reply.header("Connection", "close");
        // Security operations retain their machine-readable authentication envelope.
        const body = failure.status === 401 && failure.body.error === "Authentication required." &&
          ["sessions", "revoke", "password"].includes(operation ?? "")
          ? { error: "authentication_required" } : failure.body;
        return reply.code(failure.status).send(body);
      }
    },
  };
}
