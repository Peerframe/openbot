import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { nodeEnvSchema } from "@openbot/config";
import { createDatabase } from "@openbot/db";
import { createSilentLogger } from "@openbot/logging";
import { OpenBotNodeClient } from "../../../apps/node/dist/client.js";
import { createApp } from "../../../apps/server/dist/app.js";
import { FileArtifactStorage } from "../../../apps/server/dist/artifact-storage.js";
import { ChannelRealtimeHub } from "../../../apps/server/dist/channel-realtime-hub.js";
import { closeHttpServer } from "../../../apps/server/dist/http-shutdown.js";
import { NodeIdentityService } from "../../../apps/server/dist/node-identity.js";
import { NodeRegistry } from "../../../apps/server/dist/node-registry.js";
import { OwnerAuthService } from "../../../apps/server/dist/owner-auth.js";
import { PostgresNodeIdentityStore } from "../../../apps/server/dist/postgres-node-identity-store.js";
import { PostgresRequestThrottleStore } from "../../../apps/server/dist/postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "../../../apps/server/dist/postgres-session-store.js";
import { PostgresControlPlaneStore } from "../../../apps/server/dist/postgres-store.js";
import { RequestThrottle } from "../../../apps/server/dist/request-throttle.js";
import { RunDispatcher } from "../../../apps/server/dist/run-dispatcher.js";
import { RunFrameStore } from "../../../apps/server/dist/run-frame-store.js";
import { WorkspaceRealtimeHub } from "../../../apps/server/dist/workspace-realtime-hub.js";
import { createDockerProvider } from "../dist/index.js";
import { createCleanupGate, SyntheticComputer } from "./computer.mjs";

export async function eventually(read, predicate, signal, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    const value = await read();
    if (predicate(value)) return value;
    assert(Date.now() < deadline, label);
    await delay(25, undefined, { signal });
  }
}

export class BrowserFixture {
  database;
  computer;
  node;
  registry;
  dispatcher;
  frames;
  bot;
  channel;
  nodeId = `conformance-${randomUUID()}`;
  settled = new Set();
  active = new Set();
  cleanupGate;
  #directory;
  #server;
  #origin;
  #cookie;
  #signal;
  #closed = false;

  async start(databaseUrl, signal, { gateCleanup = false, maxConcurrentRuns = 2 } = {}) {
    this.#signal = signal;
    this.#directory = await mkdtemp(join(tmpdir(), "openbot-browser-conformance-"));
    this.database = createDatabase(databaseUrl);
    await this.database.migrate();
    signal.throwIfAborted();
    this.computer = new SyntheticComputer(randomBytes(24).toString("hex"));
    await this.computer.start();
    if (gateCleanup) {
      this.cleanupGate = createCleanupGate();
      this.computer.mode = "cleanup-gate";
    }
    const provider = createDockerProvider({
      computerUrl: this.computer.origin,
      computerToken: this.computer.token,
      allowPrivateHosts: true,
      inputOrigins: [this.computer.origin],
      ...(this.cleanupGate ? { fetcher: this.cleanupGate.fetcher } : {}),
    });
    const execute = provider.execute;
    provider.execute = async (context, input, ...args) => {
      this.active.add(input.runId);
      try {
        return await execute(context, input, ...args);
      } finally {
        this.active.delete(input.runId);
        this.settled.add(input.runId);
      }
    };
    const logger = createSilentLogger();
    const store = new PostgresControlPlaneStore(this.database.db);
    const nodeIdentity = new NodeIdentityService(new PostgresNodeIdentityStore(this.database.db));
    this.registry = new NodeRegistry(nodeIdentity);
    const realtime = new ChannelRealtimeHub();
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const artifacts = new FileArtifactStorage(join(this.#directory, "artifacts"));
    this.frames = new RunFrameStore();
    this.dispatcher = new RunDispatcher(
      store,
      this.registry,
      realtime,
      artifacts,
      this.frames,
      workspaceRealtime,
      undefined,
      logger,
    );
    await this.dispatcher.start();
    const throttle = new RequestThrottle(new PostgresRequestThrottleStore(this.database.db));
    const password = randomBytes(24).toString("hex");
    const auth = new OwnerAuthService(
      new PostgresOwnerSessionStore(this.database.db),
      { ownerName: "Conformance Owner", ownerPassword: password, sessionTtlMs: 60_000 },
      throttle,
    );
    const allowedOrigins = [];
    const app = createApp({
      allowedOrigins,
      artifactStorage: artifacts,
      auth,
      dispatchRun: (run) => this.dispatcher.enqueue(run),
      disconnectNode: (id) => this.registry.disconnect(id),
      getRemoteAddress: () => "127.0.0.1",
      listNodes: () => this.registry.list(),
      logger,
      nodeIdentity,
      realtime,
      requestThrottle: throttle,
      cancelRun: (runId) => this.dispatcher.cancelWorkerRun(runId),
      decideWorkerApproval: (id, decision) => this.dispatcher.decideApproval(id, decision),
      runFrames: this.frames,
      secureCookies: false,
      store,
      workspaceRealtime,
    });
    const listening = new Promise((resolve, reject) => {
      this.#server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, resolve);
      this.#server.once("error", reject);
    });
    this.registry.attach(this.#server);
    const address = await listening;
    this.#origin = `http://127.0.0.1:${address.port}`;
    allowedOrigins.push(this.#origin);
    const login = await this.request("/api/v1/auth/login", { password }, 200, false);
    this.#cookie = login.headers.get("set-cookie")?.split(";")[0];
    await login.body?.cancel();
    assert(this.#cookie, "Owner login did not return a session cookie.");
    this.bot = (
      await this.json(
        "/api/v1/bots",
        {
          name: `Conformance ${randomUUID()}`,
          role: "Controlled browser",
          computerProfile: "docker-linux",
        },
        201,
      )
    ).bot;
    this.computer.botId = this.bot.id;
    this.channel = (
      await this.json(
        "/api/v1/channels",
        {
          name: `Conformance ${randomUUID()}`,
          description: "Synthetic fixture",
          botIds: [this.bot.id],
        },
        201,
      )
    ).channel;
    const enrollment = await this.json(
      "/api/v1/nodes/enrollment-tokens",
      { nodeId: this.nodeId },
      201,
    );
    const env = nodeEnvSchema.parse({
      OPENBOT_NODE_ID: this.nodeId,
      OPENBOT_NODE_SERVER_URL: `${this.#origin.replace("http:", "ws:")}/ws/nodes`,
      OPENBOT_NODE_ENROLLMENT_TOKEN: enrollment.token,
      OPENBOT_NODE_CREDENTIAL_PATH: join(this.#directory, "identity.json"),
      OPENBOT_NODE_WORK_DIRECTORY: join(this.#directory, "node"),
      OPENBOT_NODE_MAX_CONCURRENT_RUNS: maxConcurrentRuns,
      OPENBOT_LOG_LEVEL: "error",
    });
    this.node = new OpenBotNodeClient(env, [provider], undefined, logger);
    await this.node.start();
    await eventually(
      () => this.registry.list(),
      (nodes) => nodes.some((node) => node.id === this.nodeId),
      signal,
      "Enrolled Node did not become available.",
    );
  }
  async request(path, body, status = 200, authenticated = true) {
    const response = await fetch(`${this.#origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: this.#origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(authenticated ? { cookie: this.#cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.#signal, AbortSignal.timeout(5000)]),
    });
    if (response.status !== status) {
      await response.body?.cancel();
      assert.fail(
        `${path.replace(/[0-9a-f]{8}-[0-9a-f-]+/g, ":id")} expected ${status}, received ${response.status}.`,
      );
    }
    return response;
  }
  async json(path, body, status) {
    return (await this.request(path, body, status)).json();
  }
  async submit() {
    return (
      await this.json(
        `/api/v1/channels/${this.channel.id}/messages`,
        { content: `Open ${this.computer.target} and click button "Preview"`, botId: this.bot.id },
        201,
      )
    ).run;
  }
  async workspace() {
    return this.json("/api/v1/workspace");
  }
  async waitApproval(run) {
    return eventually(
      async () => (await this.workspace()).approvals.find((approval) => approval.runId === run.id),
      (value) => value?.status === "pending",
      this.#signal,
      "Run did not reach pending approval.",
    );
  }
  async waitRun(run, status, timeoutMs) {
    return eventually(
      async () =>
        (await this.json(`/api/v1/channels/${this.channel.id}/runs`)).runs.find(
          (value) => value.id === run.id,
        ),
      (value) => value?.status === status,
      this.#signal,
      `Run did not reach ${status}.`,
      timeoutMs,
    );
  }
  async waitSettled(run) {
    await eventually(
      () => this.settled.has(run.id),
      Boolean,
      this.#signal,
      "Provider cleanup did not complete.",
    );
  }
  async cancel(run, status = 200) {
    return this.json(`/api/v1/runs/${run.id}/cancel`, {}, status);
  }
  async decide(approval, decision, status = 200) {
    return this.json(`/api/v1/approvals/${approval.id}/decision`, { decision }, status);
  }
  async assertNoResult(run) {
    await this.waitSettled(run);
    const workspace = await this.workspace();
    assert.deepEqual(
      workspace.artifacts.filter((artifact) => artifact.runId === run.id),
      [],
    );
    assert.equal(this.computer.commits.length, 0);
    assert.deepEqual(this.computer.errors, []);
  }
  async close() {
    if (this.#closed) return;
    this.cleanupGate?.release();
    const errors = [];
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => this.node?.stop());
    await attempt(() => this.registry?.close());
    await attempt(() => this.dispatcher?.stop());
    if (this.#server?.listening) await attempt(() => closeHttpServer(this.#server, 250));
    await attempt(() => this.computer?.stop());
    await attempt(() => this.database?.client.end({ timeout: 1 }));
    if (this.#directory) await attempt(() => rm(this.#directory, { recursive: true, force: true }));
    assert.equal(this.active.size, 0, "Provider executions remain after cleanup.");
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed.");
    this.#closed = true;
  }
}
