import { Plugins, pluginRoutes } from "./product-plugins.js";
import { approvalRoutes } from "./product-approvals.js";
import { automationRoutes } from "./product-automations.js";
import { employeeKnowledgeRoutes } from "./employee-knowledge.js";
import { AttachmentProcessing, processingRoutes } from "./attachment-processing.js";
import { NodeAttachmentParser } from "./attachment-parser.js";
import { AttachmentTranscription } from "./attachment-transcription.js";
import { StorageService } from "./storage-service.js";
import { storageRoutes } from "./product-storage.js";
import { join } from "node:path";
import { OwnerFiles } from "./owner-files.js";
import { attachmentRoutes } from "./product-attachments.js";
import type { Readable } from "node:stream";
import {
  pluginHttpOperations,
  automationHttpOperations,
  controlHttpOperations,
  employeeHttpOperations,
  lifecycleHttpOperations,
  resourceHttpOperations,
} from "@openbot/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { EntryOptions } from "./config.js";
import { ModelConnections, modelRoutes } from "./model-connections.js";
import { ModelNetwork, modelNetworkRoutes } from "./model-network.js";
import { ownerTransactions, refuse } from "./owner-transaction.js";
import { WriteFailure, writeUnavailable } from "./primary-bot-write.js";
import { identityError, identityRoutes } from "./product-identity.js";
import { productReadRoutes } from "./product-reads.js";
import { ProductBytes } from "./product-response.js";
import { ownerCookie } from "./transcription-read.js";
import { boundedJson } from "./write-input.js";

const inventory = [
  ...pluginHttpOperations,
  ...automationHttpOperations,
  ...controlHttpOperations,
  ...employeeHttpOperations,
  ...lifecycleHttpOperations,
  ...resourceHttpOperations,
];
export function productHandler(
  options: NonNullable<EntryOptions["product"]>,
  publicOrigin: string,
  secure: boolean,
) {
  const store = ownerTransactions(options.databaseUrl);
  const models = options.models
    ? new ModelConnections(options.models.keyPath, options.models.customBaseUrls)
    : undefined;
  const network = models ? new ModelNetwork(models, options.modelTransport) : undefined;
  const files = options.files
    ? new OwnerFiles(join(options.files.objectRoot, "attachments"))
    : undefined;
  const storage = files
    ? new StorageService(
        options.databaseUrl,
        files,
        options.files!.objectRoot,
        options.files!.artifactRoot,
      )
    : undefined;
  const processing =
    files && options.files?.parser
      ? new AttachmentProcessing(
          files,
          new NodeAttachmentParser(options.files.parser.worker, options.files.parser.modules),
          models
            ? new AttachmentTranscription(models, files, options.attachmentTransport)
            : undefined,
        )
      : undefined;
  const plugins = options.plugins
    ? new Plugins(
        options.plugins.storePath,
        options.plugins.localEndpoints,
        options.plugins.catalogPath,
      )
    : undefined;
  const routes = [
    ...(plugins ? pluginRoutes(plugins) : []),
    ...identityRoutes,
    ...(processing ? processingRoutes(processing) : []),
    ...(storage ? storageRoutes(storage) : []),
    ...(files
      ? [
          ...attachmentRoutes(files, options.files!.objectRoot),
          ...approvalRoutes(files),
          ...automationRoutes(files),
        ]
      : []),
    ...(options.controlReads ? [...productReadRoutes, ...employeeKnowledgeRoutes] : []),
    ...(models ? modelRoutes(models) : []),
    ...(network ? modelNetworkRoutes(network) : []),
  ].map((route) => {
    if (
      !inventory.some(
        (item) => item.method.toUpperCase() === route.method && item.path === route.path,
      )
    )
      throw new Error("Product route is absent from the shared inventory.");
    return {
      ...route,
      pattern: new RegExp("^" + route.path.replace(/\{[^}]+\}/g, "([^/]+)") + "$"),
    };
  });
  const origins = options.allowedOrigins ?? [publicOrigin];
  const match = (method: string, path: string) =>
    routes.find((route) => route.method === method && route.pattern.test(path));
  return {
    verify: async () => {
      files?.verify();
      await plugins?.verify();
      await store.verify(models ? (db) => models.initialize(db) : undefined);
      await storage?.verify();
      storage?.start();
    },
    close: async () => {
      network?.close();
      await plugins?.close();
      await processing?.close();
      await storage?.close();
      await store.close();
    },
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
            route.maxBytes ?? (route.kind === "product" ? 32768 : 8192),
          );
        const context = {
          query: new URLSearchParams((request.raw.url ?? "").split("?").slice(1).join("?")),
          payload: request.body as Readable,
          headers: request.headers,
        };
        const result = route.remote
          ? await route.remote(
              (operation, signal) =>
                store.run(
                  token,
                  signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
                  operation,
                ),
              ids,
              body,
              abort.signal,
              context,
            )
          : await store.run(
              token,
              abort.signal,
              async (db) => {
                try {
                  const value = await route.execute(db, ids, body, context);
                  // Empty committed invalidation only: Python owns the SSE projection during coexistence.
                  if (route.kind === "product" && request.method !== "GET")
                    await db`SELECT pg_notify('openbot_product_changed','')`;
                  return value;
                } catch (error) {
                  return identityError(error, route);
                }
              },
              true,
              route.isolation,
            );
        if (route.remote && request.method !== "GET")
          await store.run(token, abort.signal, async (db) => {
            await db`SELECT pg_notify('openbot_product_changed','')`;
          });
        if (!reply.raw.destroyed) {
          if (result instanceof ProductBytes)
            return reply
              .headers(result.headers)
              .code(route.status ?? 200)
              .send(result.bytes);
          return reply.code(route.status ?? 200).send(result);
        }
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
