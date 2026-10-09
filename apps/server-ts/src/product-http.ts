import { join } from "node:path";
import type { Readable } from "node:stream";
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
import type { FastifyReply, FastifyRequest } from "fastify";
import { NodeAttachmentParser } from "./attachment-parser.js";
import { AttachmentProcessing, processingRoutes } from "./attachment-processing.js";
import { AttachmentTranscription } from "./attachment-transcription.js";
import { BotGreetings } from "./bot-greeting.js";
import type { EntryOptions } from "./config.js";
import { employeeKnowledgeRoutes } from "./employee-knowledge.js";
import { portabilityRoutes } from "./employee-portability.js";
import { loadEmployeePublisher } from "./employee-publisher.js";
import { creationRoutes } from "./identity-create.js";
import { lifecycleRoutes } from "./identity-lifecycle.js";
import { ModelConnections, modelRoutes } from "./model-connections.js";
import { ModelNetwork, modelNetworkRoutes } from "./model-network.js";
import { digest } from "./owner-auth-crypto.js";
import { OwnerFiles } from "./owner-files.js";
import { ownerTransactions, refuse } from "./owner-transaction.js";
import { WriteFailure, writeUnavailable } from "./primary-bot-write.js";
import { approvalRoutes } from "./product-approvals.js";
import { attachmentRoutes } from "./product-attachments.js";
import { automationRoutes } from "./product-automations.js";
import { BrowserSessions, browserRoutes } from "./product-browser.js";
import { eventRoutes, ProductInvalidations, ProductStream } from "./product-events.js";
import { identityError, identityRoutes } from "./product-identity.js";
import { nodeRoutes, WorkerIdentities } from "./product-nodes.js";
import { Plugins, pluginRoutes } from "./product-plugins.js";
import { productReadRoutes } from "./product-reads.js";
import { ProductBytes, ProductJson } from "./product-response.js";
import { storageRoutes } from "./product-storage.js";
import { workspaceRoutes } from "./product-workspace.js";
import { RuntimePort } from "./runtime-port.js";
import { StorageService } from "./storage-service.js";
import { ownerCookie } from "./transcription-read.js";
import { workChannelRoutes } from "./work-channel.js";
import { workRoutes } from "./work-public.js";
import { WorkService } from "./work-service.js";
import { boundedJson } from "./write-input.js";

const inventory = [
  ...workHttpOperations,
  ...browserHttpOperations,
  ...nodeHttpOperations,
  ...portabilityHttpOperations,
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
  upstream?: string,
) {
  const store = ownerTransactions(options.databaseUrl);
  const runtime =
    options.controlReads && upstream ? new RuntimePort(upstream, publicOrigin, secure) : undefined;
  const invalidations = options.controlReads
    ? new ProductInvalidations(options.databaseUrl)
    : undefined;
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
  const work =
    options.work && models
      ? new WorkService(
          options.databaseUrl,
          options.work,
          models,
          options.modelTransport,
          files,
          plugins,
        )
      : undefined;
  const greetings =
    options.controlReads && models
      ? new BotGreetings(options.databaseUrl, models, options.modelTransport)
      : undefined;
  const browsers = runtime ? new BrowserSessions(options.databaseUrl) : undefined;
  const workerIdentities = runtime ? new WorkerIdentities(options.databaseUrl) : undefined;
  const publisher = options.publisher ? loadEmployeePublisher(options.publisher) : undefined;
  const routes = [
    ...(work
      ? [
          ...workRoutes(work.files, files),
          ...workChannelRoutes(files, work.options.tokenLimit ?? 100000),
        ]
      : []),
    ...(browsers ? browserRoutes(browsers) : []),
    ...(workerIdentities ? nodeRoutes(workerIdentities) : []),
    ...(runtime ? portabilityRoutes(publisher) : []),
    ...(runtime && invalidations ? [...workspaceRoutes, ...eventRoutes(invalidations)] : []),
    ...(files && plugins ? lifecycleRoutes(files, plugins) : []),
    ...(models && greetings ? creationRoutes(models, greetings) : []),
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
      await invalidations?.start();
      files?.verify();
      await plugins?.verify();
      await store.verify(models ? (db) => models.initialize(db) : undefined);
      await work?.start();
      await storage?.verify();
      storage?.start();
    },
    close: async () => {
      await work?.close();
      runtime?.close();
      await browsers?.close();
      await workerIdentities?.close();
      await invalidations?.close();
      network?.close();
      await greetings?.close();
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
        if (
          route.owner !== false &&
          request.method !== "GET" &&
          (!origin || !origins.includes(origin))
        )
          refuse(403, "Request origin is not allowed.");
        const token = ownerCookie(request.headers.cookie, secure);
        if (route.owner !== false) await store.preflight(token, abort.signal);
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
          peer: request.raw.socket.remoteAddress,
          ownerDigest: token ? digest(token) : undefined,
          dispatchProof: (wire: string) => {
            if (!token) return refuse(401, "Authentication required.");
            return digest("openbot:browser-dispatch:v1\0" + token + "\0" + wire);
          },
          runtime: runtime?.access(token, request.raw.socket.remoteAddress),
        };
        const result = route.remote
          ? await route
              .remote(
                (operation, signal, isolation) =>
                  store.run(
                    token,
                    signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
                    operation,
                    true,
                    isolation,
                  ),
                ids,
                body,
                abort.signal,
                context,
              )
              .catch((error) => identityError(error, route))
          : await store.run(
              token,
              abort.signal,
              async (db) => {
                try {
                  const value = await route.execute(db, ids, body, context);
                  // Empty committed invalidation only: the selected SSE owner builds the public projection.
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
        if (route.remote && route.owner !== false && request.method !== "GET")
          await store.run(token, abort.signal, async (db) => {
            await db`SELECT pg_notify('openbot_product_changed','')`;
          });
        if (!reply.raw.destroyed) {
          if (result instanceof ProductJson)
            return reply.headers(result.headers).code(result.status).send(result.value);
          if (result instanceof ProductStream)
            return reply
              .headers({
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
              })
              .send(result.stream);
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
