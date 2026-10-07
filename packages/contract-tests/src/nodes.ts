import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  auditPageSchema,
  controlHttpErrorSchema,
  nodeEnrollmentResultSchema,
  nodeEnrollmentTokenResponseSchema,
  nodeHelloSchema,
  nodeHeartbeatSchema,
  nodeIdentitiesResponseSchema,
  serverAckSchema,
  workerNodesResponseSchema,
  workspaceSnapshotSchema,
} from "@openbot/protocol";
import { contractClient, type RequestOptions } from "./client.ts";
import {
  contractTargetSchema,
  nodeScenarioSchema,
  type ContractTarget,
  type NodeScenario,
} from "./target.ts";

/** Real HTTP and protocol sockets on the supplied disposable target; no execution Provider. */
export async function runNodeContracts(input: ContractTarget, scenario: NodeScenario) {
  const target = contractTargetSchema.parse(input),
    seeded = nodeScenarioSchema.parse(scenario);
  const { request } = contractClient(target),
    passed: string[] = [];
  const check = async (name: string, action: () => Promise<void>) => {
    await action();
    passed.push(name);
  };
  const error = async (path: string, status: number, options: RequestOptions = {}) => {
    const result = await request(path, options);
    assert.equal(result.response.status, status);
    controlHttpErrorSchema.parse(result.body);
    return result;
  };
  const suffix = randomUUID(),
    nodeId = `contract-${suffix}`;
  const issue = async (id = nodeId, extra: Record<string, unknown> = {}) => {
    const result = await request("/api/v1/nodes/enrollment-tokens", {
      method: "POST",
      body: { nodeId: id, ...extra },
    });
    assert.equal(result.response.status, 201);
    return nodeEnrollmentTokenResponseSchema.parse(result.body);
  };
  const exchange = (token: string, id = nodeId, options: RequestOptions = {}) =>
    request("/api/v1/nodes/enroll", {
      method: "POST",
      cookie: false,
      body: { nodeId: id, token },
      ...options,
    });
  const identities = async () => {
    const result = await request("/api/v1/node-identities");
    assert.equal(result.response.status, 200);
    return nodeIdentitiesResponseSchema.parse(result.body).identities;
  };
  const sockets = new Set<WebSocket>();
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker socket deadline exceeded.")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const connect = async (credential: string) => {
    const url = new URL("/ws/nodes", target.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    sockets.add(socket);
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    const next = async () => {
      const [event] = await once(socket, "message", { signal: AbortSignal.timeout(5000) });
      assert(typeof event.data === "string" && Buffer.byteLength(event.data) <= 65536);
      return serverAckSchema.parse(JSON.parse(event.data));
    };
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    const ack = next();
    socket.send(
      JSON.stringify(
        nodeHelloSchema.parse({
          type: "node.hello",
          protocolVersion: "0.9.0",
          nodeId,
          name: "Synthetic contract Host",
          platform: "linux",
          capabilities: [],
          maxConcurrentRuns: 1,
          credential,
          sentAt: new Date().toISOString(),
        }),
      ),
    );
    return { socket, closed, next, ack: await ack };
  };
  try {
    for (const [path, method] of [
      ["/api/v1/nodes", "GET"],
      ["/api/v1/node-identities", "GET"],
      ["/api/v1/nodes/enrollment-tokens", "POST"],
      [`/api/v1/nodes/${nodeId}/revoke`, "POST"],
    ] as const)
      await check(`Owner authorization before parsing ${path}`, () =>
        error(path, 401, {
          method,
          cookie: false,
          ...(method === "POST" ? { rawBody: "{" } : {}),
        }).then(() => {}),
      );
    await check("Owner write Origin refusal precedes body parsing", async () => {
      for (const path of ["/api/v1/nodes/enrollment-tokens", `/api/v1/nodes/${nodeId}/revoke`])
        await error(path, 403, {
          method: "POST",
          rawBody: "{",
          cookie: false,
          origin: "https://untrusted.invalid",
        });
    });
    await check("enrollment shape, MIME and byte admission", async () => {
      for (const body of [
        { nodeId, extra: true },
        { nodeId: "../private" },
        { nodeId: "a".repeat(129) },
        { nodeId, expiresInSeconds: true },
        { nodeId, expiresInSeconds: "600" },
        { nodeId, expiresInSeconds: 59 },
        { nodeId, expiresInSeconds: 3601 },
        { nodeId, expiresInSeconds: 60.5 },
      ])
        await error("/api/v1/nodes/enrollment-tokens", 422, { method: "POST", body });
      await error("/api/v1/nodes/enrollment-tokens", 413, {
        method: "POST",
        rawBody: " ".repeat(8193),
      });
      await error("/api/v1/nodes/enroll", 413, {
        method: "POST",
        cookie: false,
        rawBody: " ".repeat(8193),
      });
      await error("/api/v1/nodes/enroll", 422, {
        method: "POST",
        cookie: false,
        rawBody: "{}",
        contentType: "text/plain",
      });
      await error("/api/v1/nodes/enroll", 422, {
        method: "POST",
        cookie: false,
        body: { nodeId, token: `obn_${"a".repeat(43)}` },
      });
    });
    await check("expired bootstrap is refused without creating an identity", async () => {
      await error("/api/v1/nodes/enroll", 401, {
        method: "POST",
        cookie: false,
        body: { nodeId: seeded.expiredNodeId, token: seeded.expiredToken },
      });
      assert(!(await identities()).some((row) => row.nodeId === seeded.expiredNodeId));
    });
    let token = "",
      credential = "";
    await check(
      "token issuance normalizes Node ID and integral expiry without creating a credential",
      async () => {
        const issued = await issue(` \ufeff${nodeId}\ufeff `, { expiresInSeconds: 60.0 });
        assert.equal(issued.nodeId, nodeId);
        token = issued.token;
        const expires = Date.parse(issued.expiresAt) - Date.now();
        assert(expires > 50000 && expires <= 60500);
        assert(!(await identities()).some((row) => row.nodeId === nodeId));
      },
    );
    await check("fresh token supersedes all earlier unconsumed tokens", async () => {
      const replacement = await issue();
      assert.notEqual(replacement.token, token);
      assert.equal((await exchange(token)).response.status, 401);
      token = replacement.token;
    });
    await check("wrong Node binding does not consume a valid token", async () => {
      assert.equal((await exchange(token, `wrong-${suffix}`)).response.status, 401);
    });
    await check(
      "anonymous exchange is independent of Owner Origin and returns one local credential",
      async () => {
        const result = await exchange(token, nodeId, { origin: "https://worker.invalid" });
        assert.equal(result.response.status, 201);
        const enrolled = nodeEnrollmentResultSchema.parse(result.body);
        assert.equal(enrolled.nodeId, nodeId);
        credential = enrolled.credential;
        assert.notEqual(credential, token);
        const row = (await identities()).find((row) => row.nodeId === nodeId);
        assert(row);
        assert.equal(row.connected, false);
        assert.equal(row.status, "active");
        assert.equal(row.enrolledAt, enrolled.enrolledAt);
        assert(!("lastAuthenticatedAt" in row) && !("revokedAt" in row) && !("node" in row));
        assert.equal((await exchange(token)).response.status, 401);
      },
    );
    await check(
      "socket authentication exposes public metadata across Node and workspace reads",
      async () => {
        const host = await connect(credential);
        assert.equal(host.ack.accepted, true);
        const result = await request("/api/v1/nodes");
        assert.equal(result.response.status, 200);
        const listed = workerNodesResponseSchema
          .parse(result.body)
          .nodes.find((row) => row.id === nodeId);
        assert(listed);
        assert.deepEqual(listed.capabilities, []);
        assert.deepEqual(listed.activeRunIds, []);
        assert.equal(listed.osVersion, "unknown");
        const row = (await identities()).find((row) => row.nodeId === nodeId);
        assert(row);
        assert.equal(row.connected, true);
        assert(row.lastAuthenticatedAt);
        assert.deepEqual(row.node, listed);
        const workspace = workspaceSnapshotSchema.parse((await request("/api/v1/workspace")).body);
        assert.deepEqual(
          workspace.nodes.find((node) => node.id === nodeId),
          listed,
        );
        const ack = host.next();
        host.socket.send(
          JSON.stringify(
            nodeHeartbeatSchema.parse({
              type: "node.heartbeat",
              protocolVersion: "0.9.0",
              nodeId,
              activeRunIds: [randomUUID()],
              sentAt: new Date().toISOString(),
            }),
          ),
        );
        assert.equal((await ack).accepted, true);
        const after = workerNodesResponseSchema
          .parse((await request("/api/v1/nodes")).body)
          .nodes.find((row) => row.id === nodeId);
        assert(after);
        assert.deepEqual(after.activeRunIds, []);
        host.socket.close(1000);
        assert.equal(await bounded(host.closed), 1000);
      },
    );
    await check("concurrent token exchange has one transaction winner", async () => {
      token = (await issue()).token;
      const results = await Promise.all([exchange(token), exchange(token)]);
      assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 401]);
      const accepted = results.find((r) => r.response.status === 201);
      assert(accepted);
      credential = nodeEnrollmentResultSchema.parse(accepted.body).credential;
      const row = (await identities()).find((row) => row.nodeId === nodeId);
      assert(row);
      assert.equal(row.connected, false);
      assert(!("lastAuthenticatedAt" in row));
    });
    await check(
      "reenrollment rotates credentials and disconnects the previous authenticated socket",
      async () => {
        const host = await connect(credential);
        assert.equal(host.ack.accepted, true);
        const previous = credential;
        const result = await exchange((await issue()).token);
        assert.equal(result.response.status, 201);
        credential = nodeEnrollmentResultSchema.parse(result.body).credential;
        assert.notEqual(credential, previous);
        assert.equal(await bounded(host.closed), 1008);
        const rejected = await connect(previous);
        assert.equal(rejected.ack.accepted, false);
        assert.equal(await bounded(rejected.closed), 1008);
      },
    );
    await check(
      "Owner revoke disconnects live transport and rejects reuse and repeat revocation",
      async () => {
        const host = await connect(credential);
        assert.equal(host.ack.accepted, true);
        const result = await request(`/api/v1/nodes/${nodeId}/revoke`, { method: "POST" });
        assert.equal(result.response.status, 204);
        assert.equal(result.body, null);
        assert.equal(await bounded(host.closed), 1008);
        const row = (await identities()).find((row) => row.nodeId === nodeId);
        assert(row);
        assert.equal(row.status, "revoked");
        assert.equal(row.connected, false);
        assert(row.revokedAt);
        assert(!("node" in row));
        const rejected = await connect(credential);
        assert.equal(rejected.ack.accepted, false);
        assert.equal(await bounded(rejected.closed), 1008);
        await error(`/api/v1/nodes/${nodeId}/revoke`, 404, { method: "POST" });
        await error(`/api/v1/nodes/missing-${suffix}/revoke`, 404, { method: "POST" });
        await error("/api/v1/nodes/-invalid/revoke", 422, { method: "POST" });
      },
    );
    await check(
      "explicit reenrollment revives a revoked identity and resets optional timestamps",
      async () => {
        const result = await exchange((await issue()).token);
        assert.equal(result.response.status, 201);
        credential = nodeEnrollmentResultSchema.parse(result.body).credential;
        const row = (await identities()).find((row) => row.nodeId === nodeId);
        assert(row);
        assert.equal(row.status, "active");
        assert.equal(row.connected, false);
        assert(!("revokedAt" in row) && !("lastAuthenticatedAt" in row));
      },
    );
    await check(
      "credential and bootstrap material never enter public lists or Owner audit",
      async () => {
        const audit = auditPageSchema.parse((await request("/api/v1/audit?limit=100")).body);
        const text = JSON.stringify({
          audit,
          identities: await identities(),
          nodes: (await request("/api/v1/nodes")).body,
        });
        for (const privateValue of [
          token,
          credential,
          seeded.expiredToken,
          "credentialDigest",
          "clientIdentityDigest",
        ])
          assert(!text.includes(privateValue));
        const events = audit.events.filter((event) => event.details.nodeId === nodeId);
        for (const type of [
          "WORKER_HOST_ENROLLMENT_CREATED",
          "WORKER_HOST_ENROLLED",
          "WORKER_HOST_REVOKED",
          "WORKER_HOST_CONNECTED",
          "WORKER_HOST_DISCONNECTED",
        ])
          assert(events.some((event) => event.type === type));
      },
    );
    await check(
      "failed exchange throttle uses a bounded Retry-After and refuses valid tokens while blocked",
      async () => {
        const valid = (await issue()).token,
          invalid = `obenr_${"a".repeat(43)}`;
        for (let index = 0; index < 30; index++)
          assert.equal((await exchange(invalid)).response.status, 401);
        const refused = await exchange(valid);
        assert.equal(refused.response.status, 429);
        controlHttpErrorSchema.parse(refused.body);
        const seconds = Number(refused.response.headers.get("retry-after"));
        assert(Number.isInteger(seconds) && seconds > 0 && seconds <= 300);
        assert.equal(
          (await request(`/api/v1/nodes/${nodeId}/revoke`, { method: "POST" })).response.status,
          204,
        );
      },
    );
  } finally {
    for (const socket of sockets) socket.close();
  }
  return { count: passed.length, passed };
}
