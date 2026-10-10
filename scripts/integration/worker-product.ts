/** Stateful worker-product contract scenarios used by the serial Vitest integration lane. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  browserCommandSchema,
  type BrowserCommand,
  browserSessionHttpSchema,
  browserMaintenanceResultSchema,
  nodeEnrollmentTokenResponseSchema,
  nodeEnrollmentResultSchema,
  workspaceSnapshotSchema,
  workerNodesResponseSchema,
  nodeIdentitiesResponseSchema,
} from "../../packages/protocol/dist/index.js";

import type { WorkerExercise } from "./browser-work.ts";
/** Actual Owner HTTP/enrollment/PG fences and WS transport; the browser image is a synthetic peer. */
export async function qualifyWorkerProduct(
  origin: string,
  token: string,
  botId: string,
  nodeId: string,
  exercise?: (context: WorkerExercise) => Promise<void>,
) {
  let disconnectNext = false,
    redirectNext = false;
  const sockets: WebSocket[] = [],
    commands: BrowserCommand[] = [];
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const api = async (path: string, method = "GET", body?: unknown, authenticated = true) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        ...(authenticated ? { Cookie: "openbot_session=" + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const value = response.status === 204 ? null : await response.json();
    return { status: response.status, value };
  };
  const issue = async () => {
    const issued = await api("/api/v1/nodes/enrollment-tokens", "POST", { nodeId });
    assert.equal(issued.status, 201);
    const enrolled = await api(
      "/api/v1/nodes/enroll",
      "POST",
      { nodeId, token: nodeEnrollmentTokenResponseSchema.parse(issued.value).token },
      false,
    );
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.value));
    return nodeEnrollmentResultSchema.parse(enrolled.value).credential;
  };
  const connect = async (credential: string) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws/nodes");
    sockets.push(socket);
    let accepted = false,
      observedError: Error | undefined;
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      try {
        const value = JSON.parse(raw.toString());
        if (value.type === "server.ack") {
          assert.equal(value.accepted, true);
          accepted = true;
          return;
        }
        const frame = browserCommandSchema.parse(value);
        commands.push(frame);
        if (disconnectNext) {
          disconnectNext = false;
          socket.terminate();
          return;
        }
        const pageUrl = redirectNext
          ? "https://outside.invalid/refused"
          : "https://fixture.invalid/worker";
        redirectNext = false;
        socket.send(
          JSON.stringify({
            type: "browser.result",
            protocolVersion: "0.9.0",
            nodeId,
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            ok: true,
            ...(frame.action.kind === "maintenance"
              ? { runtime: { running: true, profileBytes: 0 } }
              : {
                  frame: {
                    base64: png.toString("base64"),
                    width: 1,
                    height: 1,
                    capturedAt: new Date().toISOString(),
                    url: pageUrl,
                  },
                  ...(frame.action.kind === "agent"
                    ? {
                        page: {
                          url: pageUrl,
                          title: "Synthetic page",
                          text: "Synthetic observed form",
                          truncated: false,
                          snapshotId: commands.length,
                          elements: [{ ref: "e1", role: "textbox", name: "Fixture input" }],
                        },
                      }
                    : {}),
                }),
          }),
        );
      } catch (error) {
        observedError = error as Error;
      }
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "node.hello",
        protocolVersion: "0.9.0",
        nodeId,
        name: "P4 synthetic browser",
        platform: "linux",
        capabilities: ["browser"],
        capabilityManifest: ["browser.session", "browser.maintenance", "browser.page"].map(
          (id) => ({
            id,
            version: 1,
            providerId: "docker",
            constraints: {},
          }),
        ),
        maxConcurrentRuns: 1,
        credential,
        sentAt: new Date().toISOString(),
      }),
    );
    const deadline = Date.now() + 5000;
    while (!accepted && !observedError && Date.now() < deadline) await delay(10);
    if (observedError) throw observedError;
    assert.equal(accepted, true, "Real Worker enrollment acknowledgement required");
    return socket;
  };
  try {
    assert.equal((await api("/api/v1/nodes", "GET", undefined, false)).status, 401);
    const credential = await issue();
    let socket = await connect(credential);
    const workspace = await api("/api/v1/workspace");
    assert.equal(workspace.status, 200, JSON.stringify(workspace.value));
    assert(
      workspaceSnapshotSchema
        .parse(workspace.value)
        .nodes.some((node: { id: string }) => node.id === nodeId),
    );
    assert(
      !JSON.stringify(workspaceSnapshotSchema.parse(workspace.value).nodes).includes(credential),
    );
    const opened = await api(`/api/v1/bots/${botId}/browser`, "POST");
    assert.equal(opened.status, 201, JSON.stringify(opened.value));
    const session = browserSessionHttpSchema.parse(opened.value).id;
    for (const kind of ["observe", "take", "release"] as const) {
      const response = await api(`/api/v1/browser-sessions/${session}/commands`, "POST", { kind });
      assert.equal(response.status, 200, JSON.stringify(response.value));
      assert.equal(
        browserSessionHttpSchema.parse(response.value).frame?.base64,
        png.toString("base64"),
      );
    }
    assert.deepEqual(
      commands.map((c) => c.action.kind),
      ["observe", "take", "release"],
    );
    const maintenance = await api(`/api/v1/bots/${botId}/browser/maintenance`, "POST", {
      operation: "status",
    });
    assert.equal(maintenance.status, 200, JSON.stringify(maintenance.value));
    assert.equal(browserMaintenanceResultSchema.parse(maintenance.value).running, true);
    if (exercise)
      await exercise({
        api,
        commands,
        humanSession: session,
        download: async (path) => {
          const response = await fetch(origin + path, {
            headers: { Cookie: "openbot_session=" + token },
          });
          assert.equal(response.status, 200);
          return Buffer.from(await response.arrayBuffer());
        },
        disconnectNext: () => {
          disconnectNext = true;
        },
        redirectNext: () => {
          redirectNext = true;
        },
        reconnect: async () => {
          socket.terminate();
          socket = await connect(credential);
        },
      });
    const sentBeforeReenroll = commands.length;
    const closes = once(socket, "close");
    const replacement = await issue();
    await closes;
    assert.notEqual(replacement, credential);
    const replacementPeer = await connect(replacement);
    const stale = await api(`/api/v1/browser-sessions/${session}/commands`, "POST", {
      kind: "observe",
    });
    assert.equal(stale.status, 404, JSON.stringify(stale.value));
    assert.equal(commands.length, sentBeforeReenroll);
    const revoked = once(replacementPeer, "close");
    assert.equal((await api(`/api/v1/nodes/${nodeId}/revoke`, "POST")).status, 204);
    await revoked;
    const nodes = await api("/api/v1/nodes");
    assert.equal(nodes.status, 200);
    assert.equal(workerNodesResponseSchema.parse(nodes.value).nodes.length, 0);
    const identities = await api("/api/v1/node-identities");
    assert.equal(identities.status, 200);
    assert(
      nodeIdentitiesResponseSchema
        .parse(identities.value)
        .identities.some(
          (identity: { nodeId: string; status: string; connected: boolean }) =>
            identity.nodeId === nodeId && identity.status === "revoked" && !identity.connected,
        ),
    );
    console.log(
      "PASS sole TS Worker: actual Owner HTTP/enrollment/PG identity fences, live workspace, browser observe/take/release/maintenance, re-enrollment and revocation with stale-view rejection",
    );
  } finally {
    for (const socket of sockets) socket.terminate();
  }
}
