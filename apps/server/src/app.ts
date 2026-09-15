import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalResolution,
  BootstrapSummary,
  Channel,
  ChannelRealtimeEvent,
  EmployeeProfileSection,
  ExecutionNode,
  NodeIdentitySummary,
  Run,
  RunOutput,
  WorkspaceRealtimeEvent,
  WorkspaceSnapshot,
} from "@openbot/domain";
import { createSilentLogger, diagnosticFields, type OpenBotLogger } from "@openbot/logging";
import {
  activateEmployeeImportInputSchema,
  approvalDecisionInputSchema,
  createBotInputSchema,
  createChannelInputSchema,
  createEmployeeMemoryInputSchema,
  createEmployeeSkillInputSchema,
  createMessageInputSchema,
  createNodeEnrollmentTokenInputSchema,
  type DsseEnvelope,
  deleteEmployeeMemoryInputSchema,
  dsseEnvelopeSchema,
  type EmployeeTemplatePackage,
  employeeExportDownloadQuerySchema,
  exchangeNodeEnrollmentInputSchema,
  joinChannelBotInputSchema,
  loginInputSchema,
  steerNativeRunInputSchema,
  unsignedEmployeeTemplatePackageSchema,
  updateEmployeeMemoryInputSchema,
  updateEmployeeProfileDetailsInputSchema,
  updateEmployeeSkillStateInputSchema,
} from "@openbot/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { type ZodType, z } from "zod";
import { reviewKnowledgeProposalSchema } from "./agent-knowledge.js";
import { importSkillSchema, parseSkillDocument } from "./agent-skills.js";
import type { SteeringInstruction } from "./agent-steering.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import type { AttachmentProcessingService } from "./attachment-processing.js";
import {
  type AutomationStore,
  createAutomationInputSchema,
  updateAutomationInputSchema,
} from "./automations.js";
import { registerChannelAttachmentRoutes } from "./channel-attachment-routes.js";
import {
  AttachmentError,
  type ChannelAttachmentStorage,
  taskAttachmentIds,
} from "./channel-attachments.js";
import { createChannelInteractionRoutes } from "./channel-interactions-routes.js";
import type { ChannelInteractionStore } from "./channel-interactions-store.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import { ClientIdentityError, resolveClientIdentity } from "./client-identity.js";
import {
  type ControlPlaneStore,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./control-plane-store.js";
import {
  type EmployeeTemplateEnvelopeVerification,
  employeeTemplatePackageDigest,
  inspectEmployeeTemplate,
  prepareEmployeeTemplateExport,
} from "./employee-package.js";
import {
  ModelSettingsError,
  type ModelSettingsService,
  modelDiscoveryInputSchema,
  modelSettingsInputSchema,
} from "./model-settings.js";
import {
  InvalidNodeEnrollmentError,
  NodeIdentityNotFoundError,
  type NodeIdentityService,
} from "./node-identity.js";
import {
  InvalidCredentialsError,
  LoginRateLimitedError,
  type OwnerAuthService,
} from "./owner-auth.js";
import { createPluginRoutes } from "./plugin-routes.js";
import type { PluginService } from "./plugin-service.js";
import type { PostgresKnowledgeStore } from "./postgres-knowledge-store.js";
import { RealtimeEventBuffer } from "./realtime-event-buffer.js";
import type { RequestThrottle } from "./request-throttle.js";
import type { RunFrameStore } from "./run-frame-store.js";
import { TaskAttachmentReferences } from "./task-attachment-references.js";
import { WorkspaceRealtimeHub } from "./workspace-realtime-hub.js";

export interface AppDependencies {
  plugins?: PluginService;
  attachments?: ChannelAttachmentStorage;
  attachmentProcessing?: AttachmentProcessingService;
  attachmentReferenced?: (channelId: string, id: string) => Promise<boolean>;
  channelInteractions?: ChannelInteractionStore;
  onChannelMemberRemoved?: (result: { channel: Channel; cancelledRuns: Run[] }) => void;
  knowledge?: Pick<PostgresKnowledgeStore, "list" | "review">;
  cancelNativeRun?: (runId: string) => Promise<Run>;
  steerNativeRun?: (runId: string, instruction: string) => Promise<SteeringInstruction>;
  nativeRunOutput?: (runId: string) => Promise<RunOutput | undefined>;
  automations?: AutomationStore;
  modelSettings?: ModelSettingsService;
  allowedOrigins: string[];
  artifactStorage?: Pick<ArtifactStorage, "read">;
  auth: OwnerAuthService;
  dispatchRun?: (run: Run) => void;
  employeePublisher?: {
    activeKeyId: string;
    sign(document: EmployeeTemplatePackage): DsseEnvelope;
    verify(input: unknown): EmployeeTemplateEnvelopeVerification;
  };
  getRemoteAddress: (context: Context) => string | undefined;
  listNodes: () => ExecutionNode[];
  logger?: OpenBotLogger;
  nodeIdentity?: Pick<NodeIdentityService, "enroll" | "issueEnrollmentToken" | "list" | "revoke">;
  disconnectNode?: (nodeId: string) => boolean;
  realtime?: ChannelRealtimeHub;
  requestThrottle: RequestThrottle;
  resolveApproval?: (resolution: ApprovalResolution) => void | Promise<void>;
  runFrames?: Pick<RunFrameStore, "get">;
  secureCookies: boolean;
  store: ControlPlaneStore;
  trustedProxyAddress?: string | undefined;
  workspaceRealtime?: WorkspaceRealtimeHub;
}

export const ownerSessionCookie = "openbot_session";
export const secureOwnerSessionCookie = "__Host-openbot_session";

const maximumPendingRealtimeEvents = 128;

export function createApp(dependencies: AppDependencies) {
  const taskReferences = new TaskAttachmentReferences(dependencies.attachments);
  const app = new Hono<{
    Variables: { requestId: string; requestStartedAt: number };
  }>();
  const realtime = dependencies.realtime ?? new ChannelRealtimeHub();
  const workspaceRealtime = dependencies.workspaceRealtime ?? new WorkspaceRealtimeHub();
  const sessionCookie = dependencies.secureCookies ? secureOwnerSessionCookie : ownerSessionCookie;
  const applicationLogger = dependencies.logger ?? createSilentLogger();

  app.use(async (context, next) => {
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    context.set("requestId", requestId);
    context.set("requestStartedAt", requestStartedAt);
    context.header("X-Request-Id", requestId);
    await next();
    applicationLogger.info("http.request_completed", "HTTP request completed.", {
      requestId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Math.max(0, Math.round(performance.now() - requestStartedAt)),
    });
  });
  app.use(
    secureHeaders({
      crossOriginResourcePolicy: "same-site",
      permissionsPolicy: {
        camera: [],
        geolocation: [],
        microphone: ["self"],
        payment: [],
        usb: [],
      },
      strictTransportSecurity: dependencies.secureCookies,
      xFrameOptions: "DENY",
    }),
  );
  app.use(
    "/api/*",
    cors({
      origin: dependencies.allowedOrigins,
      allowHeaders: ["Content-Type", "If-Match", "X-OpenBot-Filename"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["ETag", "X-Request-Id"],
      credentials: true,
    }),
  );
  app.use(
    "/api/v1/nodes/enroll",
    bodyLimit({
      maxSize: maximumNodeIdentityRequestBytes,
      onError: (context) => context.json({ error: "Node enrollment request is too large." }, 413),
    }),
  );

  app.use("/api/v1/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (isPublicNodeEnrollmentRoute(context.req.path)) return next();
    if (
      isMutation(context.req.method) &&
      !isTrustedMutationOrigin(
        context.req.header("origin"),
        context.req.url,
        dependencies.allowedOrigins,
      )
    ) {
      return context.json({ error: "Request origin is not allowed." }, 403);
    }
    if (isPublicAuthRoute(context.req.path)) return next();

    const session = await dependencies.auth.authenticate(getCookie(context, sessionCookie));
    if (!session.authenticated) return context.json({ error: "Authentication required." }, 401);
    return next();
  });

  if (dependencies.attachments)
    registerChannelAttachmentRoutes(app, {
      storage: dependencies.attachments,
      ...(dependencies.attachmentProcessing
        ? { processing: dependencies.attachmentProcessing }
        : {}),
      ...(dependencies.attachmentReferenced
        ? { isReferenced: dependencies.attachmentReferenced }
        : {}),
      channelExists: async (channelId) =>
        (await dependencies.store.listChannels()).some((channel) => channel.id === channelId),
    });

  if (dependencies.channelInteractions)
    app.route(
      "/api/v1",
      createChannelInteractionRoutes({
        store: dependencies.channelInteractions,
        realtime,
        ...(dependencies.onChannelMemberRemoved
          ? { onRemoved: dependencies.onChannelMemberRemoved }
          : {}),
      }),
    );

  if (dependencies.plugins) app.route("/api/v1", createPluginRoutes(dependencies.plugins));

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "openbot-server",
      phase: "m1",
      time: new Date().toISOString(),
    }),
  );

  app.get("/api/v1/auth/session", async (context) => {
    const session = await dependencies.auth.authenticate(getCookie(context, sessionCookie));
    return context.json(session);
  });

  app.post("/api/v1/auth/login", async (context) => {
    const input = await parseRequest(context.req.raw, loginInputSchema);
    const clientIdentity = resolveRequestClientIdentity(context, dependencies);
    const result = await dependencies.auth.login(input.password, clientIdentity.digest);
    const maxAge = Math.max(
      1,
      Math.floor((new Date(result.session.expiresAt).getTime() - Date.now()) / 1000),
    );
    setCookie(context, sessionCookie, result.token, {
      httpOnly: true,
      maxAge,
      path: "/",
      sameSite: "Strict",
      secure: dependencies.secureCookies,
    });
    return context.json({ session: result.session });
  });

  app.post("/api/v1/auth/logout", async (context) => {
    await dependencies.auth.logout(getCookie(context, sessionCookie));
    deleteCookie(context, sessionCookie, {
      path: "/",
      sameSite: "Strict",
      secure: dependencies.secureCookies,
    });
    return context.body(null, 204);
  });

  app.post("/api/v1/nodes/enroll", async (context) => {
    const identity = requireNodeIdentity(dependencies.nodeIdentity);
    const input = await parseRequest(
      context.req.raw,
      exchangeNodeEnrollmentInputSchema,
      maximumNodeIdentityRequestBytes,
    );
    const clientIdentity = resolveRequestClientIdentity(context, dependencies);
    const reservation = await dependencies.requestThrottle.reserve(
      "node-enrollment",
      clientIdentity.digest,
    );
    if (!reservation.allowed) {
      context.header("Retry-After", String(reservation.retryAfterSeconds));
      return context.json({ error: "Too many Node enrollment attempts. Try again later." }, 429);
    }
    const result = await identity.enroll(input, clientIdentity);
    await dependencies.requestThrottle.clear("node-enrollment", clientIdentity.digest);
    // Re-enrollment rotates the durable credential. Terminate any session that authenticated with
    // the previous value so it cannot remain live until its next reconnect.
    dependencies.disconnectNode?.(result.nodeId);
    return context.json(result, 201);
  });

  app.get("/api/v1/bootstrap", async (context) => {
    const nodes = dependencies.listNodes();
    const persistedCounts = await dependencies.store.getCounts();
    const summary: BootstrapSummary = {
      project: "openbot",
      phase: "m1",
      counts: {
        ...persistedCounts,
        connectedNodes: nodes.length,
      },
    };
    return context.json(summary);
  });

  app.get("/api/v1/settings/model", async (context) => {
    if (!dependencies.modelSettings) return context.json({ status: "unavailable" });
    try {
      return context.json(await dependencies.modelSettings.summary());
    } catch {
      return context.json({ error: "Model configuration could not be read." }, 503);
    }
  });
  app.post("/api/v1/settings/model", async (context) => {
    if (!dependencies.modelSettings)
      return context.json({ error: "Model configuration is not enabled on this Server." }, 503);
    const input = await parseRequest(context.req.raw, modelSettingsInputSchema, 4096);
    try {
      return context.json(await dependencies.modelSettings.save(input));
    } catch (error) {
      if (error instanceof ModelSettingsError) {
        return context.json(
          { error: error.code },
          error.code === "conflict" || error.code === "busy"
            ? 409
            : error.code === "storage_unavailable"
              ? 503
              : 422,
        );
      }
      return context.json({ error: "Model configuration could not be saved." }, 503);
    }
  });

  app.post("/api/v1/settings/model/models", async (context) => {
    if (!dependencies.modelSettings) return context.json({ error: "storage_unavailable" }, 503);
    const input = await parseRequest(context.req.raw, modelDiscoveryInputSchema, 4096);
    try {
      return context.json({ models: await dependencies.modelSettings.discover(input) });
    } catch (error) {
      return context.json(
        { error: error instanceof ModelSettingsError ? error.code : "provider_unavailable" },
        422,
      );
    }
  });

  app.get("/api/v1/workspace", async (context) => {
    const nodes = dependencies.listNodes();
    const [channels, bots, runs, approvals, artifacts, progress, persistedCounts] =
      await Promise.all([
        dependencies.store.listChannels(),
        dependencies.store.listBots(),
        dependencies.store.listRuns(),
        dependencies.store.listApprovals(),
        dependencies.store.listArtifacts(),
        dependencies.store.listRunProgress(),
        dependencies.store.getCounts(),
      ]);
    const workspace: WorkspaceSnapshot = {
      channels,
      bots,
      nodes,
      runs,
      approvals,
      artifacts,
      progress,
      counts: {
        ...persistedCounts,
        connectedNodes: nodes.length,
      },
    };
    return context.json(workspace);
  });

  app.get("/api/v1/workspace/events", (context) =>
    streamSSE(context, async (stream) => {
      const queued = new RealtimeEventBuffer<WorkspaceRealtimeEvent>(maximumPendingRealtimeEvents);
      let wake: (() => void) | undefined;
      let closed = false;
      const unsubscribe = workspaceRealtime.subscribe((event) => {
        if (!queued.enqueue(event)) {
          closed = true;
          stream.abort();
        }
        wake?.();
        wake = undefined;
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
        wake = undefined;
        unsubscribe();
      });

      await stream.writeSSE({
        event: "workspace.ready",
        retry: 2000,
        data: JSON.stringify({
          type: "workspace.ready",
          nodes: dependencies.listNodes(),
          occurredAt: new Date().toISOString(),
        } satisfies WorkspaceRealtimeEvent),
      });

      try {
        while (!closed && !stream.aborted) {
          if (queued.empty) {
            const timedOut = await waitForEventOrTimeout((resume) => {
              wake = resume;
            });
            wake = undefined;
            if (timedOut && !closed && !stream.aborted) {
              await stream.writeSSE({ event: "heartbeat", data: new Date().toISOString() });
            }
          }

          let event = queued.dequeue();
          while (event !== undefined && !closed && !stream.aborted) {
            await stream.writeSSE({
              event: event.type,
              ...(event.type === "workspace.ready"
                ? {}
                : {
                    id:
                      event.type === "node.upserted"
                        ? event.node.id
                        : event.type === "node.removed"
                          ? event.nodeId
                          : event.type === "approval.updated"
                            ? event.approval.id
                            : event.type === "run.updated"
                              ? event.run.id
                              : event.botId,
                  }),
              data: JSON.stringify(event),
            });
            event = queued.dequeue();
          }
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  app.get("/api/v1/channels", async (context) =>
    context.json({ channels: await dependencies.store.listChannels() }),
  );

  app.post("/api/v1/channels", async (context) => {
    const input = await parseRequest(context.req.raw, createChannelInputSchema);
    const channel = await dependencies.store.createChannel(input);
    return context.json({ channel }, 201);
  });

  app.post("/api/v1/bots/:botId/conversation", async (context) => {
    const channel = await dependencies.store.getOrCreateDirectConversation(
      context.req.param("botId"),
    );
    return context.json({ channel });
  });

  app.post("/api/v1/channels/:channelId/bots", async (context) => {
    const input = await parseRequest(context.req.raw, joinChannelBotInputSchema);
    const channel = await dependencies.store.joinBotToChannel(
      context.req.param("channelId"),
      input.botId,
    );
    return context.json({ channel });
  });

  app.get("/api/v1/channels/:channelId/messages", async (context) =>
    context.json({
      messages: await dependencies.store.listMessages(context.req.param("channelId")),
    }),
  );

  app.get("/api/v1/channels/:channelId/runs", async (context) =>
    context.json({ runs: await dependencies.store.listRuns(context.req.param("channelId")) }),
  );

  app.post("/api/v1/approvals/:approvalId/decision", async (context) => {
    const input = await parseRequest(context.req.raw, approvalDecisionInputSchema);
    const resolution = await dependencies.store.decideApproval(
      context.req.param("approvalId"),
      input.decision,
      "owner",
    );
    realtime.publish({
      type: "run.updated",
      channelId: resolution.run.channelId,
      run: resolution.run,
    });
    workspaceRealtime.publish({ type: "approval.updated", ...resolution });
    await dependencies.resolveApproval?.(resolution);
    if (resolution.approval.status === "expired") {
      return context.json({ error: "Approval expired before it was decided." }, 409);
    }
    return context.json(resolution);
  });

  app.get("/api/v1/artifacts/:artifactId/content", async (context) => {
    const record = await dependencies.store.getArtifact(context.req.param("artifactId"));
    if (record === undefined) throw new StoreNotFoundError("Artifact not found.");
    if (dependencies.artifactStorage === undefined) {
      throw new Error("Artifact storage is not configured.");
    }
    const bytes = await dependencies.artifactStorage.read(record.storageKey);
    if (bytes.byteLength !== record.sizeBytes) {
      throw new Error("Artifact content does not match its authoritative metadata.");
    }
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== record.sha256) {
      throw new Error("Artifact content does not match its authoritative metadata.");
    }
    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": record.mediaType,
        "Content-Disposition":
          record.mediaType === "text/markdown"
            ? `attachment; filename="report.md"; filename*=UTF-8''${encodeURIComponent(record.name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`
            : "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.post("/api/v1/runs/:runId/cancel", async (context) => {
    await parseRequest(context.req.raw, z.object({}).strict(), 128);
    if (!dependencies.cancelNativeRun)
      return context.json({ error: "Native task cancellation is unavailable." }, 503);
    const run = await dependencies.cancelNativeRun(context.req.param("runId"));
    realtime.publish({ type: "run.updated", channelId: run.channelId, run });
    workspaceRealtime.publish({ type: "run.updated", run });
    return context.json({ run });
  });

  app.post("/api/v1/runs/:runId/steer", async (context) => {
    const parsedId = z.string().uuid().safeParse(context.req.param("runId"));
    if (!parsedId.success)
      throw new RequestValidationError("Task id is invalid.", { runId: ["Invalid task id."] });
    const runId = parsedId.data;
    const input = await parseRequest(context.req.raw, steerNativeRunInputSchema, 18000);
    if (taskAttachmentIds(input.instruction).length > 0)
      return context.json(
        { error: "Additional attachments require a new task; steering accepts text only." },
        400,
      );
    if (!dependencies.steerNativeRun)
      return context.json({ error: "Task steering is unavailable." }, 503);
    return context.json(
      { steering: await dependencies.steerNativeRun(runId, input.instruction) },
      202,
    );
  });

  app.get("/api/v1/runs/:runId/output", async (context) => {
    const parsedId = z.string().uuid().safeParse(context.req.param("runId"));
    if (!parsedId.success)
      throw new RequestValidationError("Task id is invalid.", { runId: ["Invalid task id."] });
    const runId = parsedId.data;
    context.header("Cache-Control", "private, no-store");
    return context.json({ output: (await dependencies.nativeRunOutput?.(runId)) ?? null });
  });

  app.get("/api/v1/runs/:runId/frame", (context) => {
    const stored = dependencies.runFrames?.get(context.req.param("runId"));
    if (stored === undefined) throw new StoreNotFoundError("Live frame not found.");
    return new Response(stored.bytes, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(stored.bytes.byteLength),
        "Content-Type": stored.frame.mediaType,
        ETag: `"run-frame-${stored.frame.revision}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/api/v1/channels/:channelId/events", async (context) => {
    const channelId = context.req.param("channelId");
    if (!(await dependencies.store.channelExists(channelId))) {
      throw new StoreNotFoundError("Channel not found.");
    }

    return streamSSE(context, async (stream) => {
      const queued = new RealtimeEventBuffer<ChannelRealtimeEvent>(maximumPendingRealtimeEvents);
      let wake: (() => void) | undefined;
      let closed = false;
      const unsubscribe = realtime.subscribe(channelId, (event) => {
        if (!queued.enqueue(event)) {
          closed = true;
          stream.abort();
        }
        wake?.();
        wake = undefined;
      });
      stream.onAbort(() => {
        closed = true;
        wake?.();
        wake = undefined;
        unsubscribe();
      });

      await stream.writeSSE({
        event: "channel.ready",
        retry: 2000,
        data: JSON.stringify({
          type: "channel.ready",
          channelId,
          occurredAt: new Date().toISOString(),
        } satisfies ChannelRealtimeEvent),
      });

      try {
        while (!closed && !stream.aborted) {
          if (queued.empty) {
            const timedOut = await waitForEventOrTimeout((resume) => {
              wake = resume;
            });
            wake = undefined;
            if (timedOut && !closed && !stream.aborted) {
              await stream.writeSSE({ event: "heartbeat", data: new Date().toISOString() });
            }
          }

          let event = queued.dequeue();
          while (event !== undefined && !closed && !stream.aborted) {
            await stream.writeSSE({
              event: event.type,
              ...(event.type === "message.created"
                ? { id: event.message.id }
                : event.type === "run.created" || event.type === "run.updated"
                  ? { id: event.run.id }
                  : event.type === "run.progress"
                    ? { id: event.progress.id }
                    : event.type === "run.frame"
                      ? { id: `${event.frame.runId}:${event.frame.revision}` }
                      : {}),
              data: JSON.stringify(event),
            });
            event = queued.dequeue();
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/api/v1/channels/:channelId/messages", async (context) => {
    const input = await parseRequest(context.req.raw, createMessageInputSchema);
    const channelId = context.req.param("channelId");
    const result = await taskReferences.withActive(channelId, input.content, () =>
      dependencies.store.submitTask(channelId, input),
    );
    realtime.publish({
      type: "message.created",
      channelId: result.message.channelId,
      message: result.message,
    });
    for (const run of result.runs ?? [result.run]) {
      realtime.publish({ type: "run.created", channelId: run.channelId, run });
      dependencies.dispatchRun?.(run);
    }
    return context.json(result, 201);
  });

  app.use(
    "/api/v1/automations",
    bodyLimit({
      maxSize: 32768,
      onError: (context) => context.json({ error: "Automatic task request is too large." }, 413),
    }),
  );
  app.use(
    "/api/v1/automations/:automationId",
    bodyLimit({
      maxSize: 1024,
      onError: (context) => context.json({ error: "Automatic task request is too large." }, 413),
    }),
  );
  app.get("/api/v1/automations", async (context) => {
    if (!dependencies.automations)
      return context.json({ error: "Automatic tasks are unavailable on this Server." }, 503);
    return context.json({ automations: await dependencies.automations.list() });
  });
  app.post("/api/v1/automations", async (context) => {
    if (!dependencies.automations)
      return context.json({ error: "Automatic tasks are unavailable on this Server." }, 503);
    const input = await parseRequest(context.req.raw, createAutomationInputSchema, 32768);
    return context.json({ automation: await dependencies.automations.create(input) }, 201);
  });
  app.patch("/api/v1/automations/:automationId", async (context) => {
    if (!dependencies.automations)
      return context.json({ error: "Automatic tasks are unavailable on this Server." }, 503);
    const input = await parseRequest(context.req.raw, updateAutomationInputSchema, 1024);
    return context.json({
      automation: await dependencies.automations.setEnabled(
        context.req.param("automationId"),
        input.enabled,
      ),
    });
  });
  app.delete("/api/v1/automations/:automationId", async (context) => {
    if (!dependencies.automations)
      return context.json({ error: "Automatic tasks are unavailable on this Server." }, 503);
    await dependencies.automations.delete(context.req.param("automationId"));
    return context.json({ deleted: true });
  });

  app.get("/api/v1/bots", async (context) =>
    context.json({ bots: await dependencies.store.listBots() }),
  );

  app.get("/api/v1/bots/:botId/profile", async (context) =>
    context.json({
      profile: await dependencies.store.getEmployeeProfile(context.req.param("botId")),
    }),
  );

  app.patch("/api/v1/bots/:botId/profile", async (context) => {
    const input = await parseRequest(context.req.raw, updateEmployeeProfileDetailsInputSchema);
    const botId = context.req.param("botId");
    const result = await dependencies.store.updateEmployeeProfileDetails(botId, input);
    publishEmployeeProfileChanged(workspaceRealtime, botId, [
      "identity",
      "configuration",
      "evolution",
    ]);
    return context.json(result);
  });

  app.post("/api/v1/bots/:botId/skills/import", async (context) => {
    const input = await parseRequest(context.req.raw, importSkillSchema, 32 * 1024);
    const document = parseSkillDocument(input.markdown);
    const botId = context.req.param("botId");
    const result = await dependencies.store.createEmployeeSkill(botId, {
      slug: document.name,
      name: document.name,
      description: document.description,
      version: input.version,
      source: "manual",
      requiredCapabilities: [],
      dependencySkillIds: [],
      evidence: [],
      reason: input.reason,
      skillMarkdown: document.markdown,
    });
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["skills", "evolution"]);
    return context.json(result, 201);
  });

  app.post("/api/v1/bots/:botId/skills", async (context) => {
    const input = await parseRequest(context.req.raw, createEmployeeSkillInputSchema, 32 * 1024);
    const botId = context.req.param("botId");
    const result = await dependencies.store.createEmployeeSkill(botId, input);
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["skills", "evolution"]);
    return context.json(result, 201);
  });

  app.post("/api/v1/bots/:botId/skills/:skillId/state", async (context) => {
    const input = await parseRequest(context.req.raw, updateEmployeeSkillStateInputSchema);
    const botId = context.req.param("botId");
    const result = await dependencies.store.updateEmployeeSkillState(
      botId,
      context.req.param("skillId"),
      input,
    );
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["skills", "evolution"]);
    return context.json(result);
  });

  app.get("/api/v1/bots/:botId/knowledge-proposals", async (context) => {
    if (!dependencies.knowledge)
      return context.json({ error: "Knowledge review is unavailable." }, 503);
    return context.json({
      proposals: await dependencies.knowledge.list(context.req.param("botId")),
    });
  });
  app.post("/api/v1/bots/:botId/knowledge-proposals/:proposalId/review", async (context) => {
    if (!dependencies.knowledge)
      return context.json({ error: "Knowledge review is unavailable." }, 503);
    const input = await parseRequest(context.req.raw, reviewKnowledgeProposalSchema, 16 * 1024);
    const botId = context.req.param("botId");
    const result = await dependencies.knowledge.review(
      botId,
      context.req.param("proposalId"),
      input,
    );
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["memory"]);
    return context.json(result);
  });

  app.post("/api/v1/bots/:botId/memories", async (context) => {
    const input = await parseRequest(context.req.raw, createEmployeeMemoryInputSchema);
    const botId = context.req.param("botId");
    const result = await dependencies.store.createEmployeeMemory(botId, input);
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["memory"]);
    return context.json(result, 201);
  });

  app.patch("/api/v1/bots/:botId/memories/:memoryId", async (context) => {
    const input = await parseRequest(context.req.raw, updateEmployeeMemoryInputSchema);
    const botId = context.req.param("botId");
    const result = await dependencies.store.updateEmployeeMemory(
      botId,
      context.req.param("memoryId"),
      input,
    );
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["memory"]);
    return context.json(result);
  });

  app.delete("/api/v1/bots/:botId/memories/:memoryId", async (context) => {
    const input = await parseRequest(context.req.raw, deleteEmployeeMemoryInputSchema);
    const botId = context.req.param("botId");
    const result = await dependencies.store.deleteEmployeeMemory(
      botId,
      context.req.param("memoryId"),
      input,
    );
    publishEmployeeProfileChanged(workspaceRealtime, botId, ["memory"]);
    return context.json(result);
  });

  app.get("/api/v1/bots/:botId/export/preview", async (context) => {
    const profile = await dependencies.store.getEmployeeProfile(context.req.param("botId"));
    const prepared = prepareEmployeeTemplateExport(profile, {
      ...employeeTemplateExportOptions(dependencies.employeePublisher),
      includeSkillContent: employeeExportContentSelection(context.req.raw),
    });
    return context.json({ preview: prepared.preview });
  });

  app.get("/api/v1/bots/:botId/export", async (context) => {
    const reviewedInstance = parseEmployeeExportDownloadRequest(context.req.raw);
    const profile = await dependencies.store.getEmployeeProfile(context.req.param("botId"));
    const employeeTemplate = prepareEmployeeTemplateExport(profile, {
      ...employeeTemplateExportOptions(dependencies.employeePublisher),
      generatedAt: reviewedInstance.generatedAt,
      packageId: reviewedInstance.packageId,
      includeSkillContent: employeeExportContentSelection(context.req.raw),
    });
    if (employeeTemplate.preview.blocked) {
      throw new StoreValidationError(
        "Employee template export is blocked until the reported findings are resolved.",
      );
    }
    if (employeeTemplate.preview.downloadReviewToken !== reviewedInstance.reviewToken) {
      return context.json(
        {
          error:
            "The Employee export changed after review. Request a new preview and review it before downloading.",
        },
        412,
      );
    }
    context.header("ETag", strongEmployeeExportTag(employeeTemplate.preview.downloadReviewToken));
    context.header(
      "Content-Disposition",
      `attachment; filename="${employeeTemplate.preview.fileName}"`,
    );
    context.header(
      "Content-Type",
      dependencies.employeePublisher === undefined
        ? "application/vnd.openbot.employee+json; charset=utf-8"
        : "application/vnd.openbot.employee.dsse+json; charset=utf-8",
    );
    context.header("X-Content-Type-Options", "nosniff");
    return context.body(employeeTemplate.body);
  });

  app.post("/api/v1/employees/import/preview", async (context) => {
    const employeePackage = await parseEmployeePackageRequest(
      context.req.raw,
      dependencies.employeePublisher,
    );
    return context.json({
      preview: inspectEmployeeTemplate(
        employeePackage.document,
        dependencies.listNodes(),
        employeePackage.trustedKeyId === undefined
          ? {}
          : { trustedKeyId: employeePackage.trustedKeyId },
      ),
    });
  });

  app.post("/api/v1/employees/import/activate", async (context) => {
    const input = await parseRequest(
      context.req.raw,
      activateEmployeeImportInputSchema,
      maxEmployeeActivationRequestBytes,
    );
    const employeePackage = parseEmployeePackageValue(
      input.package,
      dependencies.employeePublisher,
    );
    const preview = inspectEmployeeTemplate(
      employeePackage.document,
      dependencies.listNodes(),
      employeePackage.trustedKeyId === undefined
        ? {}
        : { trustedKeyId: employeePackage.trustedKeyId },
    );
    if (
      preview.packageId !== input.expectedPackageId ||
      preview.integrity.digest !== input.expectedDigest
    ) {
      throw new StoreConflictError(
        "The Employee package changed after preview. Review the current package before activating it.",
      );
    }
    if (preview.blocked || !preview.quarantine.canActivate) {
      throw new StoreValidationError(
        "Employee activation is blocked until every preview issue is resolved.",
      );
    }
    if (preview.signature.status === "unsigned" && !input.allowUnsigned) {
      throw new StoreValidationError(
        "Unsigned Employee activation requires explicit Owner risk acceptance.",
      );
    }

    const result = await dependencies.store.activateEmployeeImport({
      document: employeePackage.document,
      packageDigest: employeeTemplatePackageDigest(employeePackage.document),
      idempotencyKey: input.idempotencyKey,
      ...(input.employeeName === undefined ? {} : { employeeName: input.employeeName }),
      signature:
        employeePackage.trustedKeyId === undefined
          ? { status: "unsigned" }
          : {
              status: "dsse",
              trustedPublisherKeyId: employeePackage.trustedKeyId,
            },
      reviewedBy: "owner",
      reviewedAt: new Date().toISOString(),
    });
    if (!result.replayed) {
      publishEmployeeProfileChanged(workspaceRealtime, result.employee.id, [
        "identity",
        "evolution",
        "skills",
        "configuration",
        "portability",
      ]);
    }
    return context.json(result, result.replayed ? 200 : 201);
  });

  app.post("/api/v1/bots", async (context) => {
    const input = await parseRequest(context.req.raw, createBotInputSchema);
    const bot = await dependencies.store.createBot(input);
    publishEmployeeProfileChanged(workspaceRealtime, bot.id, [
      "identity",
      "evolution",
      "configuration",
    ]);
    return context.json({ bot }, 201);
  });

  app.get("/api/v1/nodes", (context) => context.json({ nodes: dependencies.listNodes() }));

  app.get("/api/v1/node-identities", async (context) => {
    const connectedById = new Map(dependencies.listNodes().map((node) => [node.id, node]));
    const identities: NodeIdentitySummary[] = (
      await requireNodeIdentity(dependencies.nodeIdentity).list()
    ).map((identity) => {
      const node = connectedById.get(identity.nodeId);
      return {
        nodeId: identity.nodeId,
        status: identity.revokedAt === null ? "active" : "revoked",
        connected: node !== undefined,
        enrolledAt: identity.enrolledAt.toISOString(),
        ...(identity.lastAuthenticatedAt === null
          ? {}
          : { lastAuthenticatedAt: identity.lastAuthenticatedAt.toISOString() }),
        ...(identity.revokedAt === null ? {} : { revokedAt: identity.revokedAt.toISOString() }),
        ...(node === undefined ? {} : { node }),
      };
    });
    return context.json({ identities });
  });

  app.post("/api/v1/nodes/enrollment-tokens", async (context) => {
    const identity = requireNodeIdentity(dependencies.nodeIdentity);
    const input = await parseRequest(
      context.req.raw,
      createNodeEnrollmentTokenInputSchema,
      maximumNodeIdentityRequestBytes,
    );
    return context.json(await identity.issueEnrollmentToken(input), 201);
  });

  app.post("/api/v1/nodes/:nodeId/revoke", async (context) => {
    const nodeId = context.req.param("nodeId");
    const parsedNodeId = createNodeEnrollmentTokenInputSchema.shape.nodeId.safeParse(nodeId);
    if (!parsedNodeId.success) {
      throw new RequestValidationError("Node id is invalid.", { nodeId: ["Invalid Node id."] });
    }
    await requireNodeIdentity(dependencies.nodeIdentity).revoke(parsedNodeId.data);
    dependencies.disconnectNode?.(parsedNodeId.data);
    return context.body(null, 204);
  });

  app.onError((error, context) => {
    if (error instanceof StoreConflictError) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof StoreNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof StoreValidationError) {
      return context.json({ error: error.message }, 422);
    }
    if (error instanceof AttachmentError)
      return context.json({ error: error.message }, error.status);
    if (error instanceof RequestValidationError) {
      return context.json({ error: error.message, fields: error.fields }, 422);
    }
    if (error instanceof EmployeeExportReviewRequiredError) {
      return context.json({ error: error.message }, 428);
    }
    if (error instanceof InvalidCredentialsError) {
      return context.json({ error: "Password is incorrect." }, 401);
    }
    if (error instanceof LoginRateLimitedError) {
      context.header("Retry-After", String(error.retryAfterSeconds));
      return context.json({ error: error.message }, 429);
    }
    if (error instanceof ClientIdentityError) {
      return context.json({ error: "Client network identity is unavailable." }, 400);
    }
    if (error instanceof InvalidNodeEnrollmentError) {
      return context.json({ error: "Node enrollment token is invalid or expired." }, 401);
    }
    if (error instanceof NodeIdentityNotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    const requestId = context.get("requestId");
    applicationLogger.error("http.request_failed", "HTTP request failed.", {
      requestId,
      method: context.req.method,
      path: context.req.path,
      code: "internal_error",
      ...diagnosticFields(error),
    });
    return context.json(
      {
        error: "OpenBot Server could not complete the request.",
        code: "internal_error",
        requestId,
      },
      500,
    );
  });

  return app;
}

function resolveRequestClientIdentity(
  context: Context,
  dependencies: Pick<AppDependencies, "getRemoteAddress" | "trustedProxyAddress">,
) {
  return resolveClientIdentity({
    remoteAddress: dependencies.getRemoteAddress(context),
    forwarded: context.req.header("forwarded"),
    trustedProxyAddress: dependencies.trustedProxyAddress,
  });
}

const channelHeartbeatMs = 15_000;

function publishEmployeeProfileChanged(
  realtime: Pick<WorkspaceRealtimeHub, "publish">,
  botId: string,
  sections: readonly [EmployeeProfileSection, ...EmployeeProfileSection[]],
): void {
  realtime.publish({
    type: "employee.profile.changed",
    botId,
    sections: [...sections],
    occurredAt: new Date().toISOString(),
  });
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function isTrustedMutationOrigin(
  origin: string | undefined,
  requestUrl: string,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === "null") return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    const requestOrigin = new URL(requestUrl).origin;
    return requestOrigin !== "null" && origin === requestOrigin;
  } catch {
    return false;
  }
}

function isPublicAuthRoute(path: string): boolean {
  return path === "/api/v1/auth/session" || path === "/api/v1/auth/login";
}

function isPublicNodeEnrollmentRoute(path: string): boolean {
  return path === "/api/v1/nodes/enroll";
}

function waitForEventOrTimeout(setWake: (wake: () => void) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let completed = false;
    const timer = setTimeout(() => {
      completed = true;
      resolve(true);
    }, channelHeartbeatMs);
    setWake(() => {
      if (completed) return;
      clearTimeout(timer);
      completed = true;
      resolve(false);
    });
  });
}

class RequestValidationError extends Error {
  readonly fields: Record<string, string[]>;

  constructor(message: string, fields: Record<string, string[]>) {
    super(message);
    this.fields = fields;
  }
}

class EmployeeExportReviewRequiredError extends Error {}

const maximumApiRequestBytes = 64 * 1024;
const maximumNodeIdentityRequestBytes = 8 * 1024;

function employeeExportContentSelection(request: Request): boolean {
  const values = new URL(request.url).searchParams.getAll("includeSkillContent");
  if (!values.length) return false;
  if (values.length !== 1 || values[0] !== "true")
    throw new RequestValidationError("Invalid skill content selection.", {
      includeSkillContent: ["Use exactly one true value or omit the parameter."],
    });
  return true;
}

function parseEmployeeExportDownloadRequest(request: Request): {
  packageId: string;
  generatedAt: string;
  reviewToken: string;
} {
  const parameters = new URL(request.url).searchParams;
  const ifMatch = request.headers.get("if-match");
  if (ifMatch === null) {
    throw new EmployeeExportReviewRequiredError(
      "Employee export requires a reviewed preview. Request a new preview, then retry with its strong If-Match tag.",
    );
  }
  const tag = /^"([a-f0-9]{64})"$/.exec(ifMatch);
  if (tag?.[1] === undefined) {
    throw new RequestValidationError(
      "Employee export If-Match must contain exactly one strong review tag.",
      { ifMatch: ["Use the quoted strong tag value returned by the export preview."] },
    );
  }

  const unsupportedParameters = Array.from(parameters.keys()).filter(
    (name) => name !== "packageId" && name !== "generatedAt" && name !== "includeSkillContent",
  );
  if (unsupportedParameters.length > 0) {
    throw new RequestValidationError("The reviewed Employee export instance is invalid.", {
      query: [`Unsupported query parameter: ${unsupportedParameters[0]}`],
    });
  }
  const parsed = employeeExportDownloadQuerySchema.safeParse({
    packageId: singleEmployeeExportParameter(parameters, "packageId"),
    generatedAt: singleEmployeeExportParameter(parameters, "generatedAt"),
  });
  if (!parsed.success) {
    throw new RequestValidationError(
      "The reviewed Employee export instance is invalid.",
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  return { ...parsed.data, reviewToken: tag[1] };
}

function singleEmployeeExportParameter(
  parameters: URLSearchParams,
  name: string,
): string | undefined {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function strongEmployeeExportTag(reviewToken: string): string {
  return `"${reviewToken}"`;
}

function employeeTemplateExportOptions(publisher: AppDependencies["employeePublisher"]): {
  publisher?: {
    keyId: string;
    sign(document: EmployeeTemplatePackage): DsseEnvelope;
    verify(input: unknown): EmployeeTemplateEnvelopeVerification;
  };
} {
  if (publisher === undefined) return {};
  return {
    publisher: {
      keyId: publisher.activeKeyId,
      // Keep the class receiver: production keyrings sign with private `this` state.
      sign: (document) => publisher.sign(document),
      verify: (input) => publisher.verify(input),
    },
  };
}

async function parseRequest<T>(
  request: Request,
  schema: ZodType<T>,
  maximumBytes = maximumApiRequestBytes,
): Promise<T> {
  let body: unknown;
  try {
    const source = await readRequestText(
      request,
      maximumBytes,
      `Request body must not exceed ${maximumBytes} bytes.`,
    );
    body = JSON.parse(source);
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError("Request body must be valid JSON.", {});
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new RequestValidationError(
      "Please correct the highlighted fields.",
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }
  return parsed.data;
}

async function readRequestText(
  request: Request,
  maximumBytes: number,
  oversizedMessage: string,
): Promise<string> {
  const reader = request.body?.getReader();
  let complete = false;
  try {
    const declaredSize = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
      throw new RequestValidationError(oversizedMessage, {});
    }
    if (reader === undefined) return "";

    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        return text + decoder.decode();
      }
      // Client length headers are only an early rejection hint, never a byte allowance.
      size += part.value.byteLength;
      if (size > maximumBytes) throw new RequestValidationError(oversizedMessage, {});
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    if (reader !== undefined) {
      // Stop consumption immediately; an underlying source must not delay rejection with cancel().
      if (!complete) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

function requireNodeIdentity(
  identity: AppDependencies["nodeIdentity"],
): NonNullable<AppDependencies["nodeIdentity"]> {
  if (identity === undefined) throw new Error("Node identity is not configured.");
  return identity;
}

const maxEmployeePackageBytes = 2 * 1024 * 1024;
const maxEmployeeActivationRequestBytes = maxEmployeePackageBytes + maximumApiRequestBytes;

async function parseEmployeePackageRequest(
  request: Request,
  publisher: AppDependencies["employeePublisher"],
): Promise<{ document: EmployeeTemplatePackage; trustedKeyId?: string }> {
  const body = await readRequestText(
    request,
    maxEmployeePackageBytes,
    "Employee package must not exceed 2 MiB.",
  );

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RequestValidationError("Employee package must be valid JSON.", {});
  }
  return parseEmployeePackageValue(value, publisher);
}

function parseEmployeePackageValue(
  value: unknown,
  publisher: AppDependencies["employeePublisher"],
): { document: EmployeeTemplatePackage; trustedKeyId?: string } {
  const parsed = unsignedEmployeeTemplatePackageSchema.safeParse(value);
  if (parsed.success) return { document: parsed.data };

  const envelope = dsseEnvelopeSchema.safeParse(value);
  if (publisher !== undefined && envelope.success) {
    const verification = publisher.verify(value);
    if (verification.status === "verified") {
      return { document: verification.document, trustedKeyId: verification.trustedKeyId };
    }
    throw new RequestValidationError("Signed Employee package verification failed.", {
      package: [`${verification.code}: ${verification.message}`],
    });
  }

  if (envelope.success) {
    throw new RequestValidationError(
      "Signed Employee packages require a configured publisher trust store.",
      {},
    );
  }

  const fields = Object.fromEntries(
    parsed.error.issues.map((issue) => [issue.path.join(".") || "package", [issue.message]]),
  );
  throw new RequestValidationError("Employee package does not match a supported format.", fields);
}
