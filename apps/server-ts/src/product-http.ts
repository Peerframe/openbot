import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import {
  controlHttpOperations,
  employeeHttpOperations,
  lifecycleHttpOperations,
} from "@openbot/protocol";
import { identityRoutes, identityError } from "./product-identity.js";
import { ownerTransactions, refuse } from "./owner-transaction.js";
import { ownerCookie } from "./transcription-read.js";
import { boundedJson } from "./write-input.js";
import { WriteFailure, writeUnavailable } from "./primary-bot-write.js";

const inventory = [...controlHttpOperations, ...employeeHttpOperations, ...lifecycleHttpOperations];
const routes = identityRoutes.map((route) => {
  if (
    !inventory.some(
      (item) => item.method.toUpperCase() === route.method && item.path === route.path,
    )
  )
    throw new Error("Product route is absent from the shared inventory.");
  return { ...route, pattern: new RegExp("^" + route.path.replace(/\{[^}]+\}/g, "([^/]+)") + "$") };
});
export function productHandler(
  options: { databaseUrl: string; allowedOrigins?: readonly string[] },
  publicOrigin: string,
  secure: boolean,
) {
  const store = ownerTransactions(options.databaseUrl);
  const origins = options.allowedOrigins ?? [publicOrigin];
  const match = (method: string, path: string) =>
    routes.find((route) => route.method === method && route.pattern.test(path));
  return {
    verify: store.verify,
    close: store.close,
    owns: (method: string, path: string) => Boolean(match(method, path)),
    async handle(request: FastifyRequest, reply: FastifyReply) {
      const path = decodeURIComponent((request.raw.url ?? "").split("?")[0]!);
      const route = match(request.method, path)!;
      const ids = route.pattern.exec(path)!.slice(1);
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const origin = request.headers.origin;
      if (origin) {
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Access-Control-Expose-Headers", "X-OpenBot-Next-Before");
        if (origins.includes(origin))
          reply.header("Access-Control-Allow-Origin", origin).header("Vary", "Origin");
      }
      const invalidId = ids.some((id) => [...id].length < 1 || [...id].length > 128);
      try {
        // FastAPI typed path validation precedes endpoint authorization; generic product routes
        // deliberately authenticate first. Preserve that observable error precedence.
        if (invalidId && route.kind === "typed") refuse(422, "Invalid request input.");
        if (request.method !== "GET" && (!origin || !origins.includes(origin)))
          refuse(403, "Request origin is not allowed.");
        const token = ownerCookie(request.headers.cookie, secure);
        await store.preflight(token, abort.signal);
        if (invalidId) refuse(422, "Invalid resource identifier.");
        let body: unknown = null;
        if (
          request.method !== "GET" &&
          route.maxBytes !== 0 &&
          (route.kind === "typed" ||
            request.headers["content-type"]?.startsWith("application/json"))
        )
          body = await boundedJson(
            request.body as Readable,
            request.headers["content-type"],
            request.headers["content-length"],
            abort.signal,
            route.maxBytes ?? 8192,
          );
        const result = await store.run(token, abort.signal, async (db) => {
          try {
            const value = await route.execute(db, ids, body);
            // Empty committed invalidation only: Python owns the SSE projection during coexistence.
            if (route.kind === "product" && request.method !== "GET")
              await db`SELECT pg_notify('openbot_product_changed','')`;
            return value;
          } catch (error) {
            return identityError(error, route);
          }
        });
        if (!reply.raw.destroyed) return reply.code(route.status ?? 200).send(result);
      } catch (error) {
        if (reply.raw.destroyed) return;
        const failure = error instanceof WriteFailure ? error : writeUnavailable();
        if (!(request.body as Readable | undefined)?.readableEnded && request.method !== "GET")
          reply.header("Connection", "close");
        return reply.code(failure.status).send(failure.body);
      }
    },
  };
}
