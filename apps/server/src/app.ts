/** Composes the sole public HTTP/Worker authority with bounded ingress and built Web resources. */
import { httpLogger, reportFailure, StartupFailure } from "./logging.js";
import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import fastifyStatic from "@fastify/static";
import {
  automationHttpOperations,
  browserHttpOperations,
  controlHttpOperations,
  employeeHttpOperations,
  lifecycleHttpOperations,
  nodeHttpOperations,
  pluginHttpOperations,
  portabilityHttpOperations,
  resourceHttpOperations,
  workHttpOperations,
} from "@openbot/protocol";
import Fastify from "fastify";
import { channelReader } from "./channel-read.js";
import {
  type EntryOptions,
  forbiddenHeader,
  safeRequestTarget,
  validateOptions,
} from "./config.js";
import { ownerAuthentication } from "./owner-auth.js";
import { primaryBotWriter } from "./primary-bot-write.js";
import { HttpFailure, storageUnavailable } from "./http-errors.js";
import { productHandler } from "./product-http.js";
import { entryTls } from "./tls.js";
import { publicOpenApi } from "./openapi.js";
import { ownerCookie, transcriptionReader } from "./transcription-read.js";
import { primaryBotJson } from "./write-input.js";

// Every public operation is defined by the shared protocol inventory.
export const serverOperations: readonly {
  method: string;
  path: string;
  operationId: string;
}[] = [
  ...workHttpOperations,
  ...controlHttpOperations,
  ...resourceHttpOperations,
  ...lifecycleHttpOperations,
  ...employeeHttpOperations,
  ...automationHttpOperations,
  ...nodeHttpOperations,
  ...pluginHttpOperations,
  ...browserHttpOperations,
  ...portabilityHttpOperations,
];

const transcriptionOperation = (() => {
  const operation = serverOperations.find(
    (item) => item.method === "get" && item.path === "/api/v1/settings/transcription",
  );
  if (!operation)
    throw new Error("The transcription read operation is absent from the shared inventory.");
  return operation;
})();

const primaryBotOperation = (() => {
  const operation = serverOperations.find(
    (item) => item.method === "put" && item.path === "/api/v1/workspace/primary-bot",
  );
  if (!operation)
    throw new Error("The primary Bot write operation is absent from the shared inventory.");
  return operation;
})();

export async function createEntry(input: EntryOptions) {
  const options = validateOptions(input);
  const publicHost = new URL(options.publicOrigin).host;
  const app = Fastify({
    ...(options.tls ? { https: await entryTls(options) } : {}),
    loggerInstance: httpLogger(),
    forceCloseConnections: true,
    requestTimeout: 45000,
    connectionTimeout: 45000,
    bodyLimit: 64 * 1024 * 1024,
    routerOptions: { maxParamLength: 8192 },
  });
  const reads = options.transcriptionRead
    ? transcriptionReader(options.transcriptionRead.databaseUrl)
    : undefined;
  if (reads) {
    app.addHook("onClose", () => reads.close());
    try {
      await reads.verify();
    } catch (cause) {
      await app.close();
      throw new StartupFailure("transcription-schema", cause);
    }
  }
  const writes = options.primaryBotWrite
    ? primaryBotWriter(options.primaryBotWrite.databaseUrl)
    : undefined;
  if (writes) {
    app.addHook("onClose", () => writes.close());
    try {
      await writes.verify();
    } catch (cause) {
      await app.close();
      throw new StartupFailure("primary-bot-schema", cause);
    }
  }
  const auth = options.ownerAuth
    ? ownerAuthentication(options.ownerAuth, options.publicOrigin, Boolean(options.tls))
    : undefined;
  if (auth) {
    app.addHook("onClose", () => auth.close());
    try {
      await auth.verify();
    } catch (cause) {
      await app.close();
      throw new StartupFailure("owner-auth-schema", cause);
    }
  }
  const channels = options.channelRead
    ? channelReader(options.channelRead, options.publicOrigin, Boolean(options.tls))
    : undefined;
  if (channels) {
    app.addHook("onClose", () => channels.close());
    try {
      await channels.verify();
    } catch (cause) {
      await app.close();
      throw new StartupFailure("channel-schema", cause);
    }
  }
  const product = options.product
    ? productHandler(options.product, options.publicOrigin, Boolean(options.tls))
    : undefined;
  if (product) {
    app.addHook("onClose", () => product.close());
    try {
      await product.verify();
    } catch (cause) {
      await app.close();
      throw new StartupFailure("product-schema", cause);
    }
  }
  if (options.tls) {
    // Bound TCP/TLS admission too, before HTTP and Worker limits can see a request.
    app.server.maxConnections = 192;
    const sockets = new Set<Socket>();
    app.server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    app.addHook("preClose", async () => {
      // Node HTTP shutdown does not own unfinished TLS handshakes.
      for (const socket of sockets) socket.destroy();
    });
  }
  // Route owners collect bounded bytes after authorization, preserving JSON integer spelling.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  if (options.webRoot) await app.register(fastifyStatic, {
    root: options.webRoot, serve: false, dotfiles: "deny", index: false,
    cacheControl: false, acceptRanges: false, allowedPath: (path, root) => {
      if (path.split("/").some((part) => part.startsWith("."))) return false;
      // Built resources are operator-owned and immutable while serving. Refuse symlink escapes.
      try {
        const target = join(root, path), actual = realpathSync(target);
        const within = relative(realpathSync(root), actual);
        return actual === resolve(target) && within !== ".." && !within.startsWith(".." + sep);
      } catch { return false; }
    },
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "not_found" }));
  const allowedOrigins = (method: string, path: string): readonly string[] => {
    const origin = [options.publicOrigin];
    if ((path === "/health" && method === "GET") || product?.owns(method, path)) return options.product?.allowedOrigins ?? origin;
    if (channels?.owns(method, path)) return options.channelRead?.allowedOrigins ?? origin;
    if (auth?.owns(method, path)) return options.ownerAuth?.allowedOrigins ?? origin;
    if (writes && method === "PUT" && path === primaryBotOperation.path) return options.primaryBotWrite?.allowedOrigins ?? origin;
    if (reads && method === "GET" && path === transcriptionOperation.path) return options.transcriptionRead?.allowedOrigins ?? origin;
    return [];
  };
  let active = 0;
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    if (
      !safeRequestTarget(request.raw.url) ||
      request.headers.host !== publicHost ||
      Object.keys(request.headers).some(forbiddenHeader)
    ) {
      return reply.code(400).send({ error: "Invalid entry request." });
    }
    const path = decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "");
    if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
      const method = request.headers["access-control-request-method"];
      const requested = request.headers["access-control-request-headers"];
      const headers = typeof requested === "string" ? requested.toLowerCase().split(",").map((v) => v.trim()) : [];
      if (typeof method !== "string" || !["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ||
        !request.headers.origin || !allowedOrigins(method, path).includes(request.headers.origin) ||
        headers.some((name) => !["accept", "accept-language", "content-language", "content-type", "x-openbot-filename", "if-match"].includes(name)))
        return reply.code(400).send({ error: "Invalid preflight request." });
      return reply.header("Access-Control-Allow-Origin", request.headers.origin)
        .header("Vary", "Origin").header("Access-Control-Allow-Credentials", "true")
        .header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE")
        .header("Access-Control-Allow-Headers", "Accept, Accept-Language, Content-Language, Content-Type, X-OpenBot-Filename, If-Match")
        .header("Access-Control-Max-Age", "600").code(200).send("OK");
    }
    if (path === "/health" && request.headers.origin && allowedOrigins("GET", path).includes(request.headers.origin))
      reply.header("Access-Control-Allow-Origin", request.headers.origin).header("Access-Control-Allow-Credentials", "true").header("Vary", "Origin");
    if (active >= 128)
      return reply
        .code(503)
        .header("Retry-After", "1")
        .send({ error: "Control-plane entry is busy." });
    active++;
    reply.raw.once("close", () => {
      active--;
    });
  });
  app.setErrorHandler((error, request, reply) => {
    reportFailure("http-handler", error, { requestId: request.id });
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply.code(413).send({ error: "Request is too large." });
    if (code === "FST_ERR_BAD_URL" || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH")
      return reply.code(400).send({ error: "Invalid entry request." });
    const failure = error instanceof HttpFailure ? error : storageUnavailable(error);
    return reply.code(failure.status).send(failure.body);
  });
  // Preserve the existing public contract document using the shared executable schema owner.
  const openApi = publicOpenApi(Boolean(options.tls));
  app.get("/openapi.json", (_request, reply) => reply.send(openApi));
  app.all("/*", (request, reply) => {
    if (request.method === "GET" && request.url.split("?")[0] === "/health" && product?.health) {
      const health = product.health();
      return reply.code(health.ok ? 200 : 503).send(health);
    }
    if (decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "").startsWith("/_openbot/"))
      return reply.code(404).send({ error: "Not found." });
    if (
      product?.owns(request.method, decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? ""))
    )
      return product.handle(request, reply);
    if (
      channels?.owns(
        request.method,
        decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? ""),
      )
    )
      return channels.handle(request, reply);
    if (auth?.owns(request.method, decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "")))
      return auth.handle(request, reply);
    if (
      writes &&
      request.method.toLowerCase() === primaryBotOperation.method &&
      decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "") === primaryBotOperation.path
    ) {
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      const origins = options.primaryBotWrite?.allowedOrigins ?? [options.publicOrigin];
      if (request.headers.origin) {
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Access-Control-Expose-Headers", "X-OpenBot-Next-Before");
        if (origins.includes(request.headers.origin)) {
          reply.header("Access-Control-Allow-Origin", request.headers.origin);
          reply.header("Vary", "Origin");
        }
      }
      const token = ownerCookie(request.headers.cookie, Boolean(options.tls));
      const perform = async () => {
        if (!request.headers.origin || !origins.includes(request.headers.origin))
          throw new HttpFailure(403, { error: "Request origin is not allowed." });
        await writes.preflight(token, abort.signal);
        const body = await primaryBotJson(
          request.body as Readable,
          request.headers["content-type"],
          request.headers["content-length"],
          abort.signal,
        );
        return writes.update(token, body, abort.signal);
      };
      return perform()
        .then((result) => {
          if (!reply.raw.destroyed) return reply.send(result);
        })
        .catch((error: unknown) => {
          if (reply.raw.destroyed) return;
          reportFailure("primary-bot", error, { requestId: request.id });
        const failure = error instanceof HttpFailure ? error : storageUnavailable(error);
          if (!(request.body as Readable | undefined)?.readableEnded)
            reply.header("Connection", "close");
          return reply.code(failure.status).send(failure.body);
        });
    }
    if (
      reads &&
      request.method.toLowerCase() === transcriptionOperation.method &&
      decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "") ===
        transcriptionOperation.path
    ) {
      const abort = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      if (request.headers.origin) {
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header("Access-Control-Expose-Headers", "X-OpenBot-Next-Before");
        if (
          (options.transcriptionRead?.allowedOrigins ?? [options.publicOrigin]).includes(
            request.headers.origin,
          )
        ) {
          reply.header("Access-Control-Allow-Origin", request.headers.origin);
          reply.header("Vary", "Origin");
        }
      }
      return reads
        .read(ownerCookie(request.headers.cookie, Boolean(options.tls)), abort.signal)
        .then((settings) => {
          if (!reply.raw.destroyed) return reply.send(settings);
        })
        .catch((error: unknown) => {
          if (reply.raw.destroyed) return;
          reportFailure("transcription-read", error, { requestId: request.id });
          const failure = error instanceof HttpFailure ? error : storageUnavailable(error);
          return reply.code(failure.status).send(failure.body);
        });
    }
    const path = decodeURIComponent(request.url.split("?")[0]!);
    const methods = ["GET", "POST", "PATCH", "PUT", "DELETE"].filter((method) => allowedOrigins(method, path).length);
    if (methods.length) return reply.header("Allow", methods.join(", ")).code(405).send({ error: "Method not allowed." });
    if (options.webRoot && (request.method === "GET" || request.method === "HEAD") &&
        !path.startsWith("/api/") && !path.startsWith("/ws/")) {
      return reply.sendFile(path === "/" ? "index.html" : path.slice(1));
    }
    return reply.code(404).send({ error: "not_found" });
  });
  const closeWorkers = product?.attachWorkers(app.server);
  if (closeWorkers) app.addHook("preClose", closeWorkers);
  else app.server.on("upgrade", (_request, socket) => socket.destroy());
  return app;
}
