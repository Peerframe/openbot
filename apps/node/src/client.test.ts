import { once } from "node:events";
import { createServer } from "node:http";
import { nodeEnvSchema } from "@openbot/config";
import { createSilentLogger } from "@openbot/logging";
import {
  nodeMessageSchema,
  protocolVersion,
  type RunOffer,
  type ServerMessage,
} from "@openbot/protocol";
import type { ComputerProvider } from "@openbot/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { OpenBotNodeClient, runOfferRejectionReason } from "./client.js";
import type { NodeCredentialStore } from "./credential-store.js";

const nodeCredential = `obn_${"a".repeat(43)}`;
const enrollmentToken = `obenr_${"b".repeat(43)}`;

const offer: RunOffer = {
  type: "run.offer",
  protocolVersion,
  offerId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  channelId: "00000000-0000-4000-8000-000000000003",
  botId: "00000000-0000-4000-8000-000000000004",
  title: "打开测试页并截图",
  instruction: "打开 https://example.test 并截图",
  executionProfile: "docker-linux",
  requiredCapabilities: ["browser", "screenshot"],
  requiredCapabilityManifest: [
    { id: "browser.observe", version: 1 },
    { id: "screen.capture", version: 1 },
  ],
  sentAt: "2026-09-03T00:00:00.000Z",
};

const capabilityManifest = [
  { id: "browser.observe" as const, version: 1, providerId: "docker", constraints: {} },
  { id: "screen.capture" as const, version: 1, providerId: "docker", constraints: {} },
];

describe("node run offers", () => {
  it("explains missing enrollment without networking or saving credentials", async () => {
    const logger = createSilentLogger();
    const errorLog = vi.spyOn(logger, "error");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const save = vi.fn();
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({ OPENBOT_NODE_ID: "unenrolled-node" }),
      [],
      { load: async () => undefined, save },
      logger,
    );
    try {
      await expect(client.start()).rejects.toThrow("npm run node:enrollment-token");
      expect(errorLog).toHaveBeenCalledWith(
        "node.identity_setup_failed",
        expect.stringContaining("CONTRIBUTING.md"),
        expect.objectContaining({ code: "node_enrollment_required" }),
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      await client.stop();
    }
  });
  it("keeps unknown identity storage failures content-free", async () => {
    const logger = createSilentLogger();
    const errorLog = vi.spyOn(logger, "error");
    const privateDetail = "fixture-private-path-and-secret";
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({ OPENBOT_NODE_ID: "broken-store-node" }),
      [],
      {
        load: async () => {
          throw new Error(privateDetail);
        },
        save: vi.fn(),
      },
      logger,
    );
    try {
      await expect(client.start()).rejects.toThrow("Node identity setup failed.");
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateDetail);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("node_enrollment_required");
    } finally {
      await client.stop();
    }
  });
  it("refuses programmatic environment overrides before touching storage or connecting", async () => {
    const load = vi.fn();
    const save = vi.fn();
    const env = nodeEnvSchema.parse({ OPENBOT_NODE_ID: "guarded-node" });
    for (const override of [
      { OPENBOT_NODE_CREDENTIAL: nodeCredential },
      {
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "false" as unknown as boolean,
      },
      {
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: true,
        OPENBOT_NODE_CREDENTIAL_STORE: "secret-service" as const,
      },
    ]) {
      const client = new OpenBotNodeClient(
        { ...env, ...override },
        [],
        { load, save },
        createSilentLogger(),
      );
      await expect(client.start()).rejects.toThrow("Node identity setup failed.");
      await client.stop();
    }
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("accepts only offers covered by local capabilities and capacity", () => {
    expect(
      runOfferRejectionReason(offer, ["browser", "screenshot"], capabilityManifest, 0, 1),
    ).toBeUndefined();
    expect(runOfferRejectionReason(offer, ["browser"], capabilityManifest, 0, 1)).toBe(
      "Missing legacy capabilities: screenshot.",
    );
    expect(
      runOfferRejectionReason(offer, ["browser", "screenshot"], capabilityManifest, 1, 1),
    ).toBe("Node is at capacity.");
    expect(
      runOfferRejectionReason(
        offer,
        ["browser", "screenshot"],
        capabilityManifest.map((item) =>
          item.id === "browser.observe" ? { ...item, version: 2 } : item,
        ),
        0,
        1,
      ),
    ).toBe("Unsupported capability version: browser.observe@1; advertised 2.");
  });

  it("executes an assigned run and reports progress and completion", async () => {
    const server = createServer();
    const gateway = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const receivedTypes: string[] = [];
    let advertisedCapabilities: string[] = [];
    let advertisedManifest: string[] = [];
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const provider: ComputerProvider = {
      id: "docker",
      displayName: "Test computer",
      platforms: ["linux", "macos"],
      capabilities: ["browser", "screenshot"],
      capabilityManifest: [
        { id: "browser.observe", version: 1, providerId: "docker", constraints: {} },
        { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
      ],
      async execute(_context, input, reportProgress, reportFrame, requestApproval) {
        expect(input.instruction).toBe(offer.instruction);
        reportProgress({ stage: "navigate", message: "Opening test page" });
        reportFrame?.({
          mediaType: "image/png",
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
            "base64",
          ),
          width: 1280,
          height: 800,
          capturedAt: "2026-09-03T00:00:00.000Z",
        });
        expect(requestApproval).toBeDefined();
        const approval = await requestApproval?.({
          actionId: "prepared-action-1",
          action: "form.submit",
          target: "https://example.test/form#signup",
          summary: "Submit the test form",
          risk: "write",
          beforeState: { fields: 3 },
        });
        expect(approval?.status).toBe("approved");
        return { ok: true, summary: "Page opened and captured", artifacts: [] };
      },
    };
    const logger = createSilentLogger();
    const warn = vi.spyOn(logger, "warn");
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "test-node",
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
      }),
      [provider],
      undefined,
      logger,
    );

    gateway.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const parsed = nodeMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) return;
        const message = parsed.data;
        receivedTypes.push(message.type);

        if (message.type === "node.hello") {
          advertisedCapabilities = message.capabilities;
          advertisedManifest = message.capabilityManifest.map(
            (capability) => `${capability.id}@${capability.version}`,
          );
          send(socket, {
            type: "server.ack",
            protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          });
          send(socket, offer);
        }
        if (message.type === "run.accept") {
          send(socket, {
            type: "run.assigned",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            assignedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.start_request") {
          send(socket, {
            type: "run.start",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            startedAt: new Date().toISOString(),
          });
        }
        if (message.type === "approval.request") {
          send(socket, {
            type: "approval.resolved",
            protocolVersion,
            nodeId: message.nodeId,
            runId: message.runId,
            requestId: message.requestId,
            decision: "approved",
            decidedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.completed") {
          send(socket, {
            type: "run.settled",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            status: "completed",
            settledAt: new Date().toISOString(),
          });
          resolveCompletion?.();
        }
      });
    });

    try {
      client.start();
      await withTimeout(completion);

      expect(advertisedCapabilities).toEqual(["browser", "screenshot"]);
      expect(warn).toHaveBeenCalledWith("node.environment_credential_enabled", expect.any(String), {
        nodeId: "test-node",
        phase: "identity",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(nodeCredential);
      expect(advertisedManifest).toEqual(["browser.observe@1", "screen.capture@1"]);
      expect(receivedTypes).toEqual([
        "node.hello",
        "run.accept",
        "run.start_request",
        "run.progress",
        "run.frame",
        "approval.request",
        "run.completed",
      ]);
    } finally {
      client.stop();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      server.close();
      await once(server, "close");
    }
  });

  it("exchanges a one-time token and persists the credential before connecting", async () => {
    let enrollmentBody: unknown;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      enrollmentBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          format: "openbot.node-identity/v1",
          nodeId: "fresh-node",
          credential: nodeCredential,
          enrolledAt: "2026-09-04T00:00:00.000Z",
        }),
      );
    });
    const gateway = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    let savedCredential: string | undefined;
    const credentialStore: NodeCredentialStore = {
      async load() {
        return undefined;
      },
      async save(identity) {
        savedCredential = identity.credential;
      },
    };
    let resolveHello: (() => void) | undefined;
    const helloReceived = new Promise<void>((resolve) => {
      resolveHello = resolve;
    });
    gateway.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const parsed = nodeMessageSchema.parse(JSON.parse(raw.toString()));
        expect(parsed).toMatchObject({
          type: "node.hello",
          nodeId: "fresh-node",
          credential: nodeCredential,
        });
        expect(savedCredential).toBe(nodeCredential);
        send(socket, {
          type: "server.ack",
          protocolVersion,
          accepted: true,
          receivedAt: new Date().toISOString(),
        });
        resolveHello?.();
      });
    });
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "fresh-node",
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}/ws/nodes`,
        OPENBOT_NODE_ENROLLMENT_TOKEN: enrollmentToken,
      }),
      [],
      credentialStore,
      createSilentLogger(),
    );

    try {
      client.start();
      await withTimeout(helloReceived);
      expect(enrollmentBody).toEqual({ nodeId: "fresh-node", token: enrollmentToken });
    } finally {
      client.stop();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      server.close();
      await once(server, "close");
    }
  });

  it("returns one stop promise that waits for cooperative Provider cleanup", async () => {
    const server = createServer();
    const gateway = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    let resolveExecutionStarted: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      resolveExecutionStarted = resolve;
    });
    let resolveCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    const provider: ComputerProvider = {
      id: "docker",
      displayName: "Draining test computer",
      platforms: ["linux"],
      capabilities: ["browser", "screenshot"],
      capabilityManifest,
      async execute(context) {
        executionSignal = context.signal;
        resolveExecutionStarted?.();
        await cleanupReleased;
        return { ok: true, summary: "cleanup complete", artifacts: [] };
      },
    };
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "test-node",
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
      }),
      [provider],
      undefined,
      createSilentLogger(),
    );

    gateway.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = nodeMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === "node.hello") {
          send(socket, {
            type: "server.ack",
            protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          });
          send(socket, offer);
        }
        if (message.type === "run.accept") {
          send(socket, {
            type: "run.assigned",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            assignedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.start_request") {
          send(socket, {
            type: "run.start",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            startedAt: new Date().toISOString(),
          });
        }
      });
    });

    try {
      void client.start();
      await withTimeout(executionStarted);

      const stop = client.stop();
      expect(client.stop()).toBe(stop);
      let stopped = false;
      void stop.then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(executionSignal?.aborted).toBe(true);
      expect(stopped).toBe(false);

      resolveCleanup?.();
      await withTimeout(stop);
      expect(stopped).toBe(true);
    } finally {
      resolveCleanup?.();
      await client.stop();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      server.close();
      await once(server, "close");
    }
  });

  it("suppresses late Provider progress, approvals and results after Owner cancellation", async () => {
    const server = createServer();
    const gateway = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    let resolveExecutionStarted: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      resolveExecutionStarted = resolve;
    });
    let resolveCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    let executionSignal: AbortSignal | undefined;
    let connected: WebSocket | undefined;
    const received: string[] = [];
    let lateApprovalRejected = false;
    const provider: ComputerProvider = {
      id: "docker",
      displayName: "Draining test computer",
      platforms: ["linux"],
      capabilities: ["browser", "screenshot"],
      capabilityManifest,
      async execute(context, _input, progress, frame, requestApproval) {
        executionSignal = context.signal;
        resolveExecutionStarted?.();
        await cleanupReleased;
        progress({ stage: "late", message: "Late progress" });
        frame?.({
          mediaType: "image/png",
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
            "base64",
          ),
          capturedAt: new Date().toISOString(),
        });
        try {
          await requestApproval?.({
            actionId: "late",
            action: "browser.click",
            target: "https://example.test",
            summary: "Late",
            risk: "privileged",
          });
        } catch {
          lateApprovalRejected = true;
        }
        return { ok: true, summary: "Late result", artifacts: [] };
      },
    };
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "test-node",
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
      }),
      [provider],
      undefined,
      createSilentLogger(),
    );

    gateway.on("connection", (socket) => {
      connected = socket;
      socket.on("message", (raw) => {
        const message = nodeMessageSchema.parse(JSON.parse(raw.toString()));
        received.push(message.type);
        if (message.type === "node.hello") {
          send(socket, {
            type: "server.ack",
            protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          });
          send(socket, offer);
        }
        if (message.type === "run.accept") {
          send(socket, {
            type: "run.assigned",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            assignedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.start_request") {
          send(socket, {
            type: "run.start",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            startedAt: new Date().toISOString(),
          });
        }
      });
    });

    try {
      void client.start();
      await withTimeout(executionStarted);

      if (!connected) throw new Error("Node did not connect.");
      send(connected, {
        type: "run.cancel",
        protocolVersion,
        runId: offer.runId,
        reason: "Owner stopped",
        cancelledAt: new Date().toISOString(),
      });
      await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true));
      resolveCleanup?.();
      await vi.waitFor(() => expect(received).toContain("node.heartbeat"));
      expect(lateApprovalRejected).toBe(true);
      expect(
        received.filter((type) =>
          ["run.progress", "run.frame", "approval.request", "run.completed", "run.failed"].includes(
            type,
          ),
        ),
      ).toEqual([]);
    } finally {
      resolveCleanup?.();
      await client.stop();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      server.close();
      await once(server, "close");
    }
  });

  it("waits for in-flight identity loading without connecting after stop", async () => {
    let resolveLoad: (() => void) | undefined;
    const loadReleased = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const credentialStore: NodeCredentialStore = {
      async load() {
        await loadReleased;
        return {
          format: "openbot.node-identity/v1",
          nodeId: "stopping-node",
          credential: nodeCredential,
          enrolledAt: "2026-09-04T00:00:00.000Z",
        };
      },
      async save() {},
    };
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "stopping-node",
        OPENBOT_NODE_SERVER_URL: "ws://127.0.0.1:1",
      }),
      [],
      credentialStore,
      createSilentLogger(),
    );

    const start = client.start();
    const stop = client.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    resolveLoad?.();
    await withTimeout(Promise.all([start, stop]).then(() => undefined));
    expect(stopped).toBe(true);
  });

  it("reports stable failure codes without forwarding Provider diagnostics", async () => {
    const server = createServer();
    const gateway = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const sensitiveDiagnostic = "token=provider-secret at /Users/alice/private.txt";
    let serializedFailure = "";
    let reportedFailure: Extract<
      ReturnType<typeof nodeMessageSchema.parse>,
      { type: "run.failed" }
    >;
    let resolveFailure: (() => void) | undefined;
    const failureReceived = new Promise<void>((resolve) => {
      resolveFailure = resolve;
    });
    const provider: ComputerProvider = {
      id: "docker",
      displayName: "Failing test computer",
      platforms: ["linux"],
      capabilities: ["browser", "screenshot"],
      capabilityManifest,
      async execute() {
        throw new Error(sensitiveDiagnostic);
      },
    };
    const client = new OpenBotNodeClient(
      nodeEnvSchema.parse({
        OPENBOT_NODE_ID: "test-node",
        OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
        OPENBOT_NODE_CREDENTIAL: nodeCredential,
        OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
      }),
      [provider],
      undefined,
      createSilentLogger(),
    );

    gateway.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const serialized = raw.toString();
        const message = nodeMessageSchema.parse(JSON.parse(serialized));
        if (message.type === "node.hello") {
          send(socket, {
            type: "server.ack",
            protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          });
          send(socket, offer);
        }
        if (message.type === "run.accept") {
          send(socket, {
            type: "run.assigned",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            assignedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.start_request") {
          send(socket, {
            type: "run.start",
            protocolVersion,
            runId: message.runId,
            nodeId: message.nodeId,
            startedAt: new Date().toISOString(),
          });
        }
        if (message.type === "run.failed") {
          serializedFailure = serialized;
          reportedFailure = message;
          resolveFailure?.();
        }
      });
    });

    try {
      client.start();
      await withTimeout(failureReceived);

      expect(reportedFailure).toMatchObject({
        type: "run.failed",
        code: "provider_execution_failed",
        error: "Provider execution failed.",
      });
      expect(serializedFailure).not.toContain("provider-secret");
      expect(serializedFailure).not.toContain("/Users/alice");
    } finally {
      client.stop();
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      server.close();
      await once(server, "close");
    }
  });
});

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

async function withTimeout(promise: Promise<void>, timeoutMs = 1000): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for Node execution.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
