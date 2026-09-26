import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { protocolVersion, type ServerMessage, serverMessageSchema } from "@openbot/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NodeRegistry, type NodeRunMessage } from "./node-registry.js";

const nodeCredential = `obn_${"a".repeat(43)}`;

describe("node enrollment", () => {
  it("carries assignment and execution lifecycle over the outbound Node socket", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity(), { offerTimeoutMs: 500 });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    const received: ServerMessage[] = [];
    const runtimeMessages: NodeRunMessage[] = [];
    const nodeUpdates: string[][] = [];
    registry.onRunMessage((_node, message) => runtimeMessages.push(message));
    registry.onUpdated((node) => nodeUpdates.push(node.activeRunIds));
    client.on("message", (raw) => {
      const parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      received.push(parsed.data);
      if (parsed.data.type === "run.offer") {
        client.send(
          JSON.stringify({
            type: "run.accept",
            protocolVersion,
            nodeId: "linux-node",
            offerId: parsed.data.offerId,
            runId: parsed.data.runId,
            acceptedAt: new Date().toISOString(),
          }),
        );
      }
      if (parsed.data.type === "run.assigned") {
        client.send(
          JSON.stringify({
            type: "run.start_request",
            protocolVersion,
            nodeId: "linux-node",
            runId: parsed.data.runId,
            requestedAt: new Date().toISOString(),
          }),
        );
      }
      if (parsed.data.type === "run.start") {
        client.send(
          JSON.stringify({
            type: "run.frame",
            protocolVersion,
            nodeId: "linux-node",
            runId: parsed.data.runId,
            mediaType: "image/png",
            base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
              "base64",
            ),
            capturedAt: new Date().toISOString(),
          }),
        );
        client.send(
          JSON.stringify({
            type: "run.completed",
            protocolVersion,
            nodeId: "linux-node",
            runId: parsed.data.runId,
            summary: "已打开页面并截图",
            artifacts: [],
            completedAt: new Date().toISOString(),
          }),
        );
      }
    });

    try {
      await once(client, "open");
      client.send(
        JSON.stringify({
          type: "node.hello",
          protocolVersion,
          nodeId: "linux-node",
          name: "Linux worker",
          platform: "linux",
          osVersion: "6.8.0",
          architecture: "x64",
          deviceClass: "server",
          isolation: "dedicated-host",
          trustTier: "dedicated",
          capabilities: ["browser", "shell", "screenshot"],
          capabilityManifest: [
            { id: "browser.observe", version: 1, providerId: "docker", constraints: {} },
            { id: "screen.capture", version: 1, providerId: "docker", constraints: {} },
          ],
          maxConcurrentRuns: 1,
          credential: nodeCredential,
          sentAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => registry.list().length === 1);
      expect(registry.list()[0]).toMatchObject({
        platform: "linux",
        architecture: "x64",
        deviceClass: "server",
        isolation: "dedicated-host",
        trustTier: "dedicated",
        capabilityManifest: [
          { id: "browser.observe", version: 1, providerId: "docker" },
          { id: "screen.capture", version: 1, providerId: "docker" },
        ],
      });

      const runId = "00000000-0000-4000-8000-000000000001";
      const result = await registry.offerRun("linux-node", {
        runId,
        channelId: "00000000-0000-4000-8000-000000000002",
        botId: "00000000-0000-4000-8000-000000000003",
        title: "打开测试页并截图",
        instruction: "打开 https://example.test 并截图",
        executionProfile: "docker-linux",
        requiredCapabilities: ["browser", "screenshot"],
        requiredCapabilityManifest: [
          { id: "browser.observe", version: 1 },
          { id: "screen.capture", version: 1 },
        ],
      });
      expect(result).toEqual({ status: "accepted" });
      expect(registry.confirmRun("linux-node", runId)).toBe(true);
      await waitFor(() => received.some((message) => message.type === "run.assigned"));
      expect(registry.list()[0]?.activeRunIds).toEqual([runId]);
      expect(nodeUpdates.at(-1)).toEqual([runId]);
      const updateCount = nodeUpdates.length;
      client.send(
        JSON.stringify({
          type: "node.heartbeat",
          protocolVersion,
          nodeId: "linux-node",
          // A Worker Host reports local execution, but it cannot release Server-owned capacity.
          activeRunIds: [],
          sentAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => nodeUpdates.length > updateCount);
      expect(registry.list()[0]?.activeRunIds).toEqual([runId]);
      expect(nodeUpdates.at(-1)).toEqual([runId]);
      await waitFor(() => runtimeMessages.some((message) => message.type === "run.start_request"));
      expect(registry.startRun("linux-node", runId)).toBe(true);
      await waitFor(() => runtimeMessages.some((message) => message.type === "run.completed"));
      expect(runtimeMessages.some((message) => message.type === "run.frame")).toBe(true);
      registry.settleRun("linux-node", runId, "completed");
      await waitFor(() => received.some((message) => message.type === "run.settled"));
      expect(registry.list()[0]?.activeRunIds).toEqual([]);
      expect(nodeUpdates.at(-1)).toEqual([]);
    } finally {
      client.close();
      await once(client, "close");
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("allows a socket to enroll exactly once", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity(), {
      enrollmentTimeoutMs: 500,
      livenessIntervalMs: 1_000,
    });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    try {
      await once(client, "open");
      client.send(JSON.stringify(nodeHello("linux-node")));
      await waitFor(() => registry.list().length === 1);

      const closed = once(client, "close");
      client.send(JSON.stringify(nodeHello("linux-node")));
      const [code, reason] = await closed;
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("already-enrolled");
      await waitFor(() => registry.list().length === 0);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("rejects an invalid per-Node credential", async () => {
    const server = createServer();
    const registry = new NodeRegistry({ authenticate: async () => false });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    try {
      await once(client, "open");
      const closed = once(client, "close");
      client.send(JSON.stringify(nodeHello("untrusted-node")));
      const [code, reason] = await withTimeout(closed);
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("invalid-credential");
      expect(registry.list()).toEqual([]);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("refuses browser receipts without Python browser-session authority", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity());
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    const runtimeMessages: NodeRunMessage[] = [];
    registry.onRunMessage((_node, message) => runtimeMessages.push(message));
    try {
      await once(client, "open");
      client.send(JSON.stringify(nodeHello("linux-node")));
      await waitFor(() => registry.list().length === 1);
      const closed = once(client, "close");
      client.send(
        JSON.stringify({
          type: "browser.result",
          protocolVersion,
          nodeId: "linux-node",
          requestId: randomUUID(),
          sessionId: randomUUID(),
          ok: false,
          error: "unavailable",
        }),
      );
      const [code, reason] = await withTimeout(closed);
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("browser-session-unavailable");
      expect(runtimeMessages).toEqual([]);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("disconnects a live Node immediately after revocation", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity());
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    try {
      await once(client, "open");
      client.send(JSON.stringify(nodeHello("revoked-node")));
      await waitFor(() => registry.list().length === 1);
      const closed = once(client, "close");
      expect(registry.disconnect("revoked-node")).toBe(true);
      const [code, reason] = await withTimeout(closed);
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("credential-revoked");
      expect(registry.list()).toEqual([]);
      expect(registry.disconnect("revoked-node")).toBe(false);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("terminates sockets that do not enroll before the deadline", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity(), {
      enrollmentTimeoutMs: 20,
      livenessIntervalMs: 1_000,
    });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    try {
      await once(client, "open");
      await withTimeout(once(client, "close"));
      expect(registry.list()).toEqual([]);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("terminates an enrolled socket that stops answering ping frames", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity(), {
      enrollmentTimeoutMs: 500,
      livenessIntervalMs: 20,
    });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`, {
      autoPong: false,
    });
    const closed = once(client, "close");
    try {
      await once(client, "open");
      client.send(JSON.stringify(nodeHello("silent-node")));
      await waitFor(() => registry.list().length === 1);
      await withTimeout(closed);
      await waitFor(() => registry.list().length === 0);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });

  it("rejects messages above the configured Node protocol envelope", async () => {
    const server = createServer();
    const registry = new NodeRegistry(nodeIdentity(), {
      enrollmentTimeoutMs: 500,
      livenessIntervalMs: 1_000,
      maxPayloadBytes: 128,
    });
    registry.attach(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nodes`);
    try {
      await once(client, "open");
      const closed = once(client, "close");
      client.send("x".repeat(129));
      const [code] = await withTimeout(closed);
      expect(code).toBe(1009);
      expect(registry.list()).toEqual([]);
    } finally {
      client.terminate();
      registry.close();
      server.close();
      await once(server, "close");
    }
  });
});

function nodeHello(nodeId: string) {
  return {
    type: "node.hello" as const,
    protocolVersion,
    nodeId,
    name: `${nodeId} worker`,
    platform: "linux" as const,
    osVersion: "6.8.0",
    architecture: "x64",
    deviceClass: "server" as const,
    isolation: "dedicated-host" as const,
    trustTier: "dedicated" as const,
    capabilities: ["browser", "shell", "screenshot"] as const,
    capabilityManifest: [
      { id: "browser.observe" as const, version: 1, providerId: "docker", constraints: {} },
      { id: "screen.capture" as const, version: 1, providerId: "docker", constraints: {} },
    ],
    maxConcurrentRuns: 1,
    credential: nodeCredential,
    sentAt: new Date().toISOString(),
  };
}

function nodeIdentity() {
  return {
    async authenticate(_nodeId: string, credential: string) {
      return credential === nodeCredential;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Node gateway state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for Node gateway event.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
