import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  browserHttpOperations,
  browserSessionHttpSchema,
  browserMaintenanceResultSchema,
  browserCommandSchema,
  browserResultSchema,
  nodeHelloSchema,
  serverAckSchema,
  nodeEnrollmentTokenResponseSchema,
  nodeEnrollmentResultSchema,
  botResponseSchema,
  controlHttpErrorSchema,
  auditPageSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  browserScenarioSchema,
  type BrowserScenario,
  type ContractTarget,
} from "./target.ts";

/** Synthetic authenticated peer qualifies HTTP authority/transport, not a running browser Provider. */
export async function runBrowserContracts(input: ContractTarget, fixture: BrowserScenario) {
  const target = contractTargetSchema.parse(input),
    scenario = browserScenarioSchema.parse(fixture),
    { request } = contractClient(target),
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status, `${options.method ?? "GET"} ${path}`);
    controlHttpErrorSchema.parse(result.body);
  };
  for (const operation of browserHttpOperations)
    await check(`browser Owner/Origin ${operation.path}`, async () => {
      const path = operation.path.replaceAll(/\{[^}]+\}/g, randomUUID());
      await error(path, 401, {
        method: operation.method.toUpperCase(),
        cookie: false,
        rawBody: "invalid",
      });
      await error(path, 403, {
        method: operation.method.toUpperCase(),
        origin: "https://foreign.invalid",
        rawBody: "invalid",
      });
    });
  await check(
    "non-browser Employee and unknown identity cannot acquire browser authority",
    async () => {
      await error(`/api/v1/bots/${target.botId}/browser`, 403, { method: "POST" });
      await error(`/api/v1/bots/${randomUUID()}/browser`, 404, { method: "POST" });
      await error("/api/v1/bots/not-a-uuid/browser", 422, { method: "POST" });
    },
  );
  const created = await request("/api/v1/bots", {
    method: "POST",
    body: {
      name: `Browser ${randomUUID()}`,
      role: "Synthetic browser contracts",
      computerProfile: "docker-linux",
    },
  });
  assert.equal(created.response.status, 201);
  const botId = botResponseSchema.parse(created.body).bot.id;
  const base = `/api/v1/bots/${botId}/browser`,
    nodeId = `browser-contract-${randomUUID()}`,
    sockets = new Set<WebSocket>();
  const commands: ReturnType<typeof browserCommandSchema.parse>[] = [];
  let mode: "normal" | "bad-frame" | "hold" = "normal",
    peerFailure: unknown;
  const enroll = async () => {
    const issued = await request("/api/v1/nodes/enrollment-tokens", {
      method: "POST",
      body: { nodeId },
    });
    assert.equal(issued.response.status, 201);
    const token = nodeEnrollmentTokenResponseSchema.parse(issued.body).token;
    const enrolled = await request("/api/v1/nodes/enroll", {
      method: "POST",
      cookie: false,
      body: { nodeId, token },
    });
    assert.equal(enrolled.response.status, 201);
    return nodeEnrollmentResultSchema.parse(enrolled.body).credential;
  };
  const connect = async (credential: string) => {
    const url = new URL("/ws/nodes", target.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    sockets.add(socket);
    let ready: (() => void) | undefined;
    const ack = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.addEventListener("message", (event) => {
      try {
        assert(typeof event.data === "string" && Buffer.byteLength(event.data) <= 65536);
        const raw: unknown = JSON.parse(event.data);
        if (raw && typeof raw === "object" && "type" in raw && raw.type === "server.ack") {
          assert.equal(serverAckSchema.parse(raw).accepted, true);
          ready?.();
          return;
        }
        const command = browserCommandSchema.parse(raw);
        commands.push(command);
        if (mode === "hold") return;
        const result = {
          type: "browser.result",
          protocolVersion: "0.9.0",
          nodeId,
          requestId: command.requestId,
          sessionId: command.sessionId,
          ok: true,
          ...(command.action.kind === "maintenance"
            ? {
                runtime: {
                  running: command.action.operation !== "clear",
                  profileBytes: command.action.operation === "clear" ? 0 : null,
                },
              }
            : {
                frame: {
                  base64: mode === "bad-frame" ? "AAAAAAAAAAAA" : scenario.frameBase64,
                  width: 1,
                  height: 1,
                  capturedAt: new Date().toISOString(),
                  url: "https://fixture.invalid/private-observation",
                },
              }),
        };
        socket.send(JSON.stringify(browserResultSchema.parse(result)));
      } catch (error) {
        peerFailure = error;
        socket.close();
      }
    });
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    socket.send(
      JSON.stringify(
        nodeHelloSchema.parse({
          type: "node.hello",
          protocolVersion: "0.9.0",
          nodeId,
          name: "Synthetic browser Host",
          platform: "linux",
          capabilities: ["browser", "screenshot"],
          capabilityManifest: ["browser.session", "browser.maintenance"].map((id) => ({
            id,
            version: 1,
            providerId: "docker",
            constraints: {},
          })),
          maxConcurrentRuns: 1,
          credential,
          sentAt: new Date().toISOString(),
        }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ack,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Browser peer acknowledgment timed out.")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(peerFailure, undefined);
    return { socket, closed };
  };
  const sessions = new Set<string>();
  const open = async () => {
    const result = await request(base, { method: "POST", rawBody: "unused-invalid-body" });
    assert.equal(result.response.status, 201);
    const view = browserSessionHttpSchema.parse(result.body);
    sessions.add(view.id);
    return view;
  };
  const command = async (id: string, body: unknown) => {
    const result = await request(`/api/v1/browser-sessions/${id}/commands`, {
      method: "POST",
      body,
      maxResponseBytes: 8388608,
    });
    assert.equal(result.response.status, 200);
    assert.equal(peerFailure, undefined);
    return browserSessionHttpSchema.parse(result.body);
  };
  try {
    await check("missing Host and absent original binding fail closed", async () => {
      await error(base, 503, { method: "POST" });
      await error(base + "/maintenance", 503, { method: "POST", body: { operation: "status" } });
    });
    const peer = await connect(await enroll());
    const view = await open();
    await check(
      "browser opening binds an authenticated original Host and reports the execution gate",
      async () => {
        assert.equal(view.botId, botId);
        assert.equal(view.nodeId, nodeId);
        assert.equal(view.control, "available");
        assert.equal(view.controlAvailable, false);
        assert.equal(view.frame, undefined);
      },
    );
    const path = `/api/v1/browser-sessions/${view.id}/commands`;
    await check(
      "command shape/body admission and missing execution integration do not dispatch",
      async () => {
        const before = commands.length;
        for (const body of [
          { kind: "observe", extra: true },
          { kind: "scroll", deltaY: 2000.5 },
          { kind: "type", text: "" },
          { kind: "click", x: true, y: 1 },
          { kind: "agent", operation: { kind: "read" } },
        ])
          await error(path, 422, { method: "POST", body });
        await error(path, 413, { method: "POST", body: { kind: "type", text: "x".repeat(20000) } });
        await error(path, 503, { method: "POST", body: { kind: "take" } });
        assert.equal(commands.length, before);
      },
    );
    await check(
      "real socket observation preserves validated PNG bytes without durable page/frame content",
      async () => {
        const observed = await command(view.id, { kind: "observe" });
        assert.equal(observed.frame?.base64, scenario.frameBase64);
        assert.equal(observed.frame?.width, 1);
        assert.equal(observed.controlAvailable, false);
        const audit = await request("/api/v1/audit?limit=100");
        assert.equal(audit.response.status, 200);
        auditPageSchema.parse(audit.body);
        const text = JSON.stringify(audit.body);
        assert(!text.includes(scenario.frameBase64) && !text.includes("private-observation"));
      },
    );
    await check(
      "invalid screenshot bytes fail after one dispatch and are never automatically retried",
      async () => {
        const before = commands.length;
        mode = "bad-frame";
        try {
          await error(path, 503, { method: "POST", body: { kind: "observe" } });
        } finally {
          mode = "normal";
        }
        assert.equal(commands.length, before + 1);
        await command(view.id, { kind: "observe" });
      },
    );
    await check(
      "client cancellation never retries and the original command deadline releases its wait",
      async () => {
        const before = commands.length;
        mode = "hold";
        const abort = new AbortController();
        const pending = request(path, {
          method: "POST",
          body: { kind: "observe" },
          signal: abort.signal,
        });
        for (let i = 0; i < 100 && commands.length === before; i++) await delay(10);
        assert.equal(commands.length, before + 1);
        abort.abort();
        await assert.rejects(pending);
        mode = "normal";
        // The actual product middleware retains this wait after client abort. Preserve its finite
        // command lifetime instead of claiming immediate disconnect cancellation or retrying an effect.
        await error(path, 409, { method: "POST", body: { kind: "observe" } });
        assert.equal(commands.length, before + 1);
        const held = commands[before];
        assert(held);
        const remaining = Date.parse(held.expiresAt) - Date.now();
        assert(remaining >= 0 && remaining <= 25000, "Browser command lifetime is not bounded.");
        await delay(remaining + 1000);
        await command(view.id, { kind: "observe" });
        assert.equal(commands.length, before + 2);
      },
    );
    await check(
      "maintenance confirmation/body guards retain null profile measurement and pause semantics",
      async () => {
        const before = commands.length;
        for (const body of [
          { operation: "clear" },
          { operation: "status", confirmation: "clear-browser-data" },
          { operation: "status", confirmation: null },
        ])
          await error(base + "/maintenance", 422, { method: "POST", body });
        await error(base + "/maintenance", 413, {
          method: "POST",
          body: { operation: "status", extra: "x".repeat(1024) },
        });
        assert.equal(commands.length, before);
        for (const operation of ["status", "restart", "clear"] as const) {
          const result = await request(base + "/maintenance", {
            method: "POST",
            body: {
              operation,
              ...(operation === "clear" ? { confirmation: "clear-browser-data" } : {}),
            },
          });
          assert.equal(result.response.status, 200);
          const runtime = browserMaintenanceResultSchema.parse(result.body);
          assert.equal(runtime.nodeId, nodeId);
          assert.equal(runtime.running, operation !== "clear");
          assert.equal(runtime.profileBytes, operation === "clear" ? 0 : null);
          assert.equal(runtime.paused, operation !== "status");
        }
        await error(path, 404, { method: "POST", body: { kind: "observe" } });
        sessions.delete(view.id);
      },
    );
    const closing = await open();
    await check("view close is single-use and subsequent commands cannot reuse it", async () => {
      const closed = await request(`/api/v1/browser-sessions/${closing.id}`, { method: "DELETE" });
      assert.equal(closed.response.status, 204);
      assert.equal(closed.body, null);
      sessions.delete(closing.id);
      await error(`/api/v1/browser-sessions/${closing.id}`, 404, { method: "DELETE" });
      await error(`/api/v1/browser-sessions/${closing.id}/commands`, 404, {
        method: "POST",
        body: { kind: "observe" },
      });
    });
    const stale = await open();
    await check(
      "disconnect invalidates views; same-id new enrollment cannot replace bound profile identity",
      async () => {
        peer.socket.close();
        await peer.closed;
        await error(`/api/v1/browser-sessions/${stale.id}/commands`, 404, {
          method: "POST",
          body: { kind: "observe" },
        });
        sessions.delete(stale.id);
        await connect(await enroll());
        await error(base, 409, { method: "POST" });
      },
    );
  } finally {
    for (const id of sessions)
      await request(`/api/v1/browser-sessions/${id}`, { method: "DELETE" });
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
      socket.close();
      await closed;
    }
    await request(`/api/v1/nodes/${nodeId}/revoke`, { method: "POST" });
    await request(`/api/v1/bots/${botId}`, { method: "DELETE" });
  }
  return { count: passed.length, checks: passed };
}
