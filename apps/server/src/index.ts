import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serverEnvSchema } from "@openbot/config";
import { createDatabase } from "@openbot/db";
import { createLogger, diagnosticFields } from "@openbot/logging";
import { createApp } from "./app.js";
import { FileArtifactStorage } from "./artifact-storage.js";
import { AttachmentProcessingService } from "./attachment-processing.js";
import { AutomationScheduler } from "./automations.js";
import { FileChannelAttachmentStorage } from "./channel-attachments.js";
import { PostgresChannelInteractions } from "./channel-interactions-store.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import { EmployeePublisherKeyring } from "./employee-publisher-keyring.js";
import { closeHttpServer } from "./http-shutdown.js";
import { bootstrapModelSettings } from "./model-settings-bootstrap.js";
import { NativeAgentRunner } from "./native-agent.js";
import { createNativeWebSearch } from "./native-web-tools.js";
import { NodeIdentityService } from "./node-identity.js";
import { NodeRegistry } from "./node-registry.js";
import { OwnerAuthService } from "./owner-auth.js";
import { PluginService } from "./plugin-service.js";
import { FilePluginStore } from "./plugin-store.js";
import { PluginError } from "./plugin-types.js";
import { PostgresAgentStore } from "./postgres-agent-store.js";
import { attachmentIsReferenced } from "./postgres-attachment-references.js";
import { PostgresAutomationStore } from "./postgres-automation-store.js";
import { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { PostgresNodeIdentityStore } from "./postgres-node-identity-store.js";
import { PostgresRequestThrottleStore } from "./postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "./postgres-session-store.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";
import { RequestThrottle } from "./request-throttle.js";
import { RunDispatcher } from "./run-dispatcher.js";
import { RunFrameStore } from "./run-frame-store.js";
import { TaskAttachmentReferences } from "./task-attachment-references.js";
import { WorkspaceRealtimeHub } from "./workspace-realtime-hub.js";

const env = serverEnvSchema.parse(process.env);
const logger = createLogger({ level: env.OPENBOT_LOG_LEVEL });
// Validate retained key material before database migration or Run recovery changes durable state.
const modelSettings = await bootstrapModelSettings(env);
const HTTP_SHUTDOWN_GRACE_MS = 10_000;
const database = createDatabase(env.OPENBOT_DATABASE_URL);
await database.migrate();
const nodeIdentity = new NodeIdentityService(new PostgresNodeIdentityStore(database.db));
const nodeRegistry = new NodeRegistry(nodeIdentity);
const realtime = new ChannelRealtimeHub();
const workspaceRealtime = new WorkspaceRealtimeHub();
const unsubscribeNodeEvents = [
  nodeRegistry.onAvailable((node) => workspaceRealtime.publish({ type: "node.upserted", node })),
  nodeRegistry.onUpdated((node) => workspaceRealtime.publish({ type: "node.upserted", node })),
  nodeRegistry.onUnavailable((node) =>
    workspaceRealtime.publish({
      type: "node.removed",
      nodeId: node.id,
      occurredAt: new Date().toISOString(),
    }),
  ),
];
const store = new PostgresControlPlaneStore(database.db);
const artifactStorage = new FileArtifactStorage(env.OPENBOT_OBJECT_STORE_PATH);
const attachments = new FileChannelAttachmentStorage(
  join(env.OPENBOT_OBJECT_STORE_PATH, "attachments"),
);
const employeePublisher =
  env.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH === undefined
    ? undefined
    : await EmployeePublisherKeyring.load({
        directory: env.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH,
        passphraseFile: env.OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE as string,
      });
const runFrames = new RunFrameStore();
const dispatcher = new RunDispatcher(
  store,
  nodeRegistry,
  realtime,
  artifactStorage,
  runFrames,
  workspaceRealtime,
  undefined,
  logger,
);
await dispatcher.start();
// Existing credentials do not enable inference: the Owner must explicitly opt in in Settings.
const nativeStore = new PostgresAgentStore(database.db);
const plugins = new PluginService({
  store: new FilePluginStore(join(env.OPENBOT_OBJECT_STORE_PATH, "plugins", "state.json")),
  assertScope: (run) => nativeStore.assertScope(run),
  assertOwnerContentScope: async ({ channelId, botId }) => {
    const channel = (await store.listChannels()).find((item) => item.id === channelId);
    if (!channel?.botIds.includes(botId))
      throw new PluginError("forbidden", "Bot is not a member of this channel.");
  },
  botExists: async (botId) => (await store.listBots()).some((bot) => bot.id === botId),
  localEndpoints: env.OPENBOT_PLUGIN_LOCAL_ENDPOINTS,
});
const nativeAgent = modelSettings
  ? new NativeAgentRunner(
      nativeStore,
      modelSettings,
      realtime,
      () =>
        logger.error(
          "agent.poll_failed",
          "Native Agent polling failed; Run state remains in PostgreSQL.",
        ),
      undefined,
      {
        streamOutput: true,
        artifacts: artifactStorage,
        attachments,
        plugins,
        webSearch: (config) => createNativeWebSearch(config, { tavilyApiKey: env.TAVILY_API_KEY }),
        onUpdated: (run) => workspaceRealtime.publish({ type: "run.updated", run }),
        onCompleted: (run, artifacts) =>
          workspaceRealtime.publish({ type: "run.updated", run, artifacts }),
      },
    )
  : undefined;
const requestThrottle = new RequestThrottle(new PostgresRequestThrottleStore(database.db));
const auth = new OwnerAuthService(
  new PostgresOwnerSessionStore(database.db),
  {
    ownerName: env.OPENBOT_OWNER_NAME,
    ownerPassword: env.OPENBOT_OWNER_PASSWORD,
    sessionTtlMs: env.OPENBOT_SESSION_TTL_HOURS * 60 * 60 * 1000,
  },
  requestThrottle,
);
const automations = new PostgresAutomationStore(
  database.db,
  new TaskAttachmentReferences(attachments),
);
const automationScheduler = new AutomationScheduler(
  automations,
  (result) => {
    realtime.publish({
      type: "message.created",
      channelId: result.message.channelId,
      message: result.message,
    });
    realtime.publish({ type: "run.created", channelId: result.run.channelId, run: result.run });
    dispatcher.enqueue(result.run);
    nativeAgent?.enqueue();
  },
  () =>
    logger.error(
      "automation.poll_failed",
      "Automatic task polling failed; committed Run authority remains in PostgreSQL.",
    ),
);
const app = createApp({
  attachments,
  attachmentProcessing: new AttachmentProcessingService({
    storage: attachments,
    ...(modelSettings ? { settings: () => modelSettings.agentSettings() } : {}),
  }),
  attachmentReferenced: (channelId, id) => attachmentIsReferenced(database.db, channelId, id),
  channelInteractions: new PostgresChannelInteractions(database.db),
  onChannelMemberRemoved: ({ cancelledRuns }) => {
    for (const run of cancelledRuns) {
      nativeAgent?.cancel(run.id);
      if (run.nodeId) nodeRegistry.cancelRun(run.nodeId, run.id, "Channel membership removed.");
      realtime.publish({ type: "run.updated", channelId: run.channelId, run });
      workspaceRealtime.publish({ type: "run.updated", run });
    }
  },
  plugins,
  steerNativeRun: (runId, instruction) => nativeStore.steer(runId, instruction),
  nativeRunOutput: async (runId) => {
    const run = await nativeStore.lookup(runId);
    if (!run || run.executionProfile !== "none") return undefined;
    if (!["queued", "running"].includes(run.status)) return undefined;
    await nativeStore.assertScope(run);
    return nativeAgent?.output(runId);
  },
  knowledge: new PostgresKnowledgeStore(database.db),
  cancelNativeRun: async (runId) => {
    const { run, descendants } = await nativeStore.cancelWithDescendants(runId);
    nativeAgent?.cancel(runId);
    for (const child of descendants) {
      nativeAgent?.cancel(child.id);
      realtime.publish({ type: "run.updated", channelId: child.channelId, run: child });
      workspaceRealtime.publish({ type: "run.updated", run: child });
    }
    return run;
  },
  automations,
  ...(modelSettings ? { modelSettings } : {}),
  allowedOrigins: env.OPENBOT_ALLOWED_ORIGINS,
  artifactStorage,
  auth,
  dispatchRun: (run) => {
    dispatcher.enqueue(run);
    nativeAgent?.enqueue();
  },
  ...(employeePublisher === undefined ? {} : { employeePublisher }),
  disconnectNode: (nodeId) => nodeRegistry.disconnect(nodeId),
  getRemoteAddress: (context) => getConnInfo(context).remote.address,
  listNodes: () => nodeRegistry.list(),
  logger,
  nodeIdentity,
  realtime,
  requestThrottle,
  resolveApproval: (resolution) => dispatcher.resolveApproval(resolution),
  runFrames,
  secureCookies: env.OPENBOT_SECURE_COOKIES,
  store,
  trustedProxyAddress: env.OPENBOT_TRUSTED_PROXY_ADDRESS,
  workspaceRealtime,
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: env.OPENBOT_HOST,
    port: env.OPENBOT_PORT,
  },
  (info) => {
    // Only a successful bind can tell the owning Desktop process to send local credentials.
    const parentPort = (
      process as NodeJS.Process & { parentPort?: { postMessage(value: unknown): void } }
    ).parentPort;
    parentPort?.postMessage({ type: "openbot-server-ready", port: info.port });
    logger.info("server.listening", "OpenBot Server is listening.", {
      address: info.address,
      port: info.port,
    });
  },
);

// `serve` uses the HTTP/1 server by default; the cast narrows its public union for upgrades.
const httpServer = server as HttpServer;
nodeRegistry.attach(httpServer);
automationScheduler.start();
nativeAgent?.start();

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = shutdownOnce(signal);
  return shutdownPromise;
}

async function shutdownOnce(signal: string): Promise<void> {
  logger.info("server.shutdown_started", "OpenBot Server shutdown started.", { signal });
  for (const unsubscribe of unsubscribeNodeEvents) unsubscribe();

  const httpDrain = closeHttpServer(httpServer, HTTP_SHUTDOWN_GRACE_MS);
  const automationsDrained = await automationScheduler.stop();
  if (!automationsDrained)
    logger.warn(
      "automation.shutdown_forced",
      "Automatic task polling exceeded the shutdown grace period; queued Runs recover on restart.",
    );
  plugins.close();
  const dispatcherDrain = dispatcher.stop();
  await nativeAgent?.stop();
  nodeRegistry.close();

  const [dispatcherResult, httpResult] = await Promise.allSettled([dispatcherDrain, httpDrain]);
  const [databaseResult] = await Promise.allSettled([database.client.end({ timeout: 5 })]);

  const errors: unknown[] = [];
  if (dispatcherResult.status === "rejected") errors.push(dispatcherResult.reason);
  if (httpResult.status === "rejected") {
    errors.push(httpResult.reason);
  } else if (httpResult.value.forced) {
    logger.warn("server.shutdown_forced", "HTTP connections exceeded the shutdown grace period.", {
      durationMs: HTTP_SHUTDOWN_GRACE_MS,
    });
  }
  if (databaseResult.status === "rejected") errors.push(databaseResult.reason);
  if (errors.length > 0) throw new AggregateError(errors, "OpenBot Server shutdown failed.");
}

function requestShutdown(signal: string): void {
  void shutdown(signal).catch((error: unknown) => {
    logger.error("server.shutdown_failed", "OpenBot Server shutdown failed.", {
      signal,
      ...diagnosticFields(error),
    });
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

// Windows utility processes cannot receive a graceful POSIX signal. Only the owning
// process can use this fixed IPC operation; no network endpoint or arbitrary action exists.
const parentPort = (
  process as NodeJS.Process & {
    parentPort?: { on(event: "message", listener: (event: { data: unknown }) => void): void };
  }
).parentPort;
const parentShutdown = (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    Object.keys(message).length === 1 &&
    (message as { type?: unknown }).type === "openbot-server-shutdown"
  ) {
    // A subscribed Node IPC channel holds the event loop open. Drain storage and
    // children first, then terminate the utility process to acknowledge completion.
    void shutdown("parent").then(
      () => process.exit(0),
      () => process.exit(1),
    );
  }
};
parentPort?.on("message", (event) => parentShutdown(event.data));
process.on("message", parentShutdown);
