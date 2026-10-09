import { runtimePrefix } from "./runtime-port.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable } from "node:stream";
import type { Socket } from "node:net";
import replyFrom from "@fastify/reply-from";
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
import {
  type EntryOptions,
  forbiddenHeader,
  peerForwarded,
  safeRequestTarget,
  validateOptions,
} from "./config.js";
import { entryTls } from "./tls.js";
import { ownerCookie, ReadFailure, transcriptionReader } from "./transcription-read.js";
import { primaryBotWriter, WriteFailure, writeUnavailable } from "./primary-bot-write.js";
import { primaryBotJson } from "./write-input.js";
import { ownerAuthentication } from "./owner-auth.js";
import { productHandler } from "./product-http.js";
import { channelReader } from "./channel-read.js";
import { workerTunnel } from "./worker-tunnel.js";

// This inventory is shared with P1. Only the explicitly enabled read operation changes owner.
export const pythonOperations: readonly {
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
  const operation = pythonOperations.find(
    (item) => item.method === "get" && item.path === "/api/v1/settings/transcription",
  );
  if (!operation)
    throw new Error("The transcription read operation is absent from the shared inventory.");
  return operation;
})();

const primaryBotOperation = (() => {
  const operation = pythonOperations.find(
    (item) => item.method === "put" && item.path === "/api/v1/workspace/primary-bot",
  );
  if (!operation)
    throw new Error("The primary Bot write operation is absent from the shared inventory.");
  return operation;
})();

export async function createEntry(input: EntryOptions) {
  const options = validateOptions(input);
  const publicHost = new URL(options.publicOrigin).host;
  const transport = new AsyncLocalStorage<AbortSignal>();
  const app = Fastify({
    ...(options.tls ? { https: await entryTls(options) } : {}),
    logger: false,
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
    } catch {
      await app.close();
      throw new Error("The transcription read schema is unavailable.");
    }
  }
  const writes = options.primaryBotWrite
    ? primaryBotWriter(options.primaryBotWrite.databaseUrl)
    : undefined;
  if (writes) {
    app.addHook("onClose", () => writes.close());
    try {
      await writes.verify();
    } catch {
      await app.close();
      throw new Error("The primary Bot write schema is unavailable.");
    }
  }
  const auth = options.ownerAuth
    ? ownerAuthentication(options.ownerAuth, options.publicOrigin, Boolean(options.tls))
    : undefined;
  if (auth) {
    app.addHook("onClose", () => auth.close());
    try {
      await auth.verify();
    } catch {
      await app.close();
      throw new Error("The Owner authentication schema is unavailable.");
    }
  }
  const channels = options.channelRead
    ? channelReader(options.channelRead, options.publicOrigin, Boolean(options.tls))
    : undefined;
  if (channels) {
    app.addHook("onClose", () => channels.close());
    try {
      await channels.verify();
    } catch {
      await app.close();
      throw new Error("The channel read schema is unavailable.");
    }
  }
  const product = options.product
    ? productHandler(options.product, options.publicOrigin, Boolean(options.tls), options.upstream)
    : undefined;
  if (product) {
    app.addHook("onClose", () => product.close());
    try {
      await product.verify();
    } catch {
      await app.close();
      throw new Error("Product schema is unavailable.");
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
  // Forward invalid JSON/raw integer spelling to the authority, without body conversion.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  await app.register(replyFrom, {
    base: options.upstream,
    retryMethods: [],
    disableRequestLogging: true,
    destroyAgent: true,
    disableCache: true,
    http: {
      agentOptions: { keepAlive: true, maxSockets: 128, maxFreeSockets: 16 },
      requestOptions: {
        timeout: 45000,
        // Reviewed reply-from spreads requestOptions per dispatch. Use Node's public
        // AbortSignal option to cancel even before upstream response headers arrive.
        get signal() {
          return transport.getStore();
        },
      },
    },
  });
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
  app.setErrorHandler((_error, _request, reply) => {
    reply.code(400).send({ error: "Invalid entry request." });
  });
  app.all("/*", (request, reply) => {
    if (decodeURIComponent((request.raw.url ?? "").split("?")[0] ?? "").startsWith(runtimePrefix))
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
          throw new WriteFailure(403, { error: "Request origin is not allowed." });
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
          const failure = error instanceof WriteFailure ? error : writeUnavailable();
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
          const failure =
            error instanceof ReadFailure
              ? error
              : new ReadFailure(503, {
                  error: "Control-plane storage is unavailable.",
                });
          return reply.code(failure.status).send(failure.body);
        });
    }
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 45000);
    deadline.unref();
    reply.raw.once("close", () => {
      clearTimeout(deadline);
      if (!reply.raw.writableFinished) abort.abort();
    });
    return transport.run(abort.signal, () =>
      reply.from(undefined, {
        retriesCount: 0,
        retryDelay: () => null,
        timeout: 45000,
        rewriteRequestHeaders: (_request, headers) => ({
          ...headers,
          host: publicHost,
          forwarded: peerForwarded(request.raw.socket.remoteAddress),
        }),
        onError: (response) => {
          clearTimeout(deadline);
          if (!response.raw.destroyed)
            response.code(503).send({ error: "Control-plane upstream is unavailable." });
        },
        onResponse: (_request, response, incoming) => {
          clearTimeout(deadline);
          incoming.stream.setTimeout(45000, () => incoming.stream.destroy());
          response.send(incoming.stream);
        },
      }),
    );
  });
  // Python also serves the optional built Web root and owns unknown method/path refusals.
  // The fixed destination cannot be selected by path, Origin, Host, query or request body.
  const closeTunnels = product?.attachWorkers(app.server) ?? workerTunnel(app.server, options);
  app.addHook("preClose", async () => {
    await closeTunnels();
  });
  return app;
}
