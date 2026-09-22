import { createHash, generateKeyPairSync } from "node:crypto";
import type {
  Approval,
  Bot,
  Channel,
  CreateBotInput,
  CreateChannelInput,
  CreateEmployeeSkillInput,
  CreateMessageInput,
  EmployeeEvolutionEvent,
  EmployeeExportPreview,
  EmployeeImportActivationResult,
  EmployeeMemory,
  EmployeeMemoryEvent,
  EmployeeProfile,
  EmployeeSkill,
  ExecutionNode,
  Message,
  Run,
  RunProgress,
  WorkspaceRealtimeEvent,
} from "@openbot/domain";
import type { OpenBotLogger } from "@openbot/logging";
import {
  dsseEnvelopeSchema,
  employeeTemplatePackageSchema,
  protocolVersion,
} from "@openbot/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  isTrustedMutationOrigin,
  ownerSessionCookie,
  secureOwnerSessionCookie,
} from "./app.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import { ChannelRealtimeHub } from "./channel-realtime-hub.js";
import {
  type ArtifactRecord,
  type ControlPlaneStore,
  StoreConflictError,
  StoreNotFoundError,
  StoreValidationError,
} from "./control-plane-store.js";
import {
  buildEmployeeTemplate,
  signEmployeeTemplateEnvelope,
  verifyEmployeeTemplateChecksum,
  verifyEmployeeTemplateEnvelope,
} from "./employee-package.js";
import { NodeIdentityService, type NodeIdentityStore } from "./node-identity.js";
import { OwnerAuthService } from "./owner-auth.js";
import type { PluginService } from "./plugin-service.js";
import { RequestThrottle, type RequestThrottleStore } from "./request-throttle.js";
import { RunFrameStore } from "./run-frame-store.js";
import type {
  CreateOwnerSessionInput,
  OwnerSessionStore,
  StoredOwnerSession,
} from "./session-store.js";
import { selectChannelAssignees } from "./task-routing.js";
import { WorkspaceRealtimeHub } from "./workspace-realtime-hub.js";

const testOrigin = "http://localhost:5173";

describe("server app", () => {
  it("requires Owner authentication for durable plugin receipt lookups", async () => {
    const plugins = {
      receiptsForRun: vi.fn(async () => []),
      receipt: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
    };
    const app = createTestApp({
      store: createTestStore(),
      plugins: plugins as unknown as PluginService,
    });
    const paths = [
      "/api/v1/runs/receipt-run/plugin-calls",
      "/api/v1/plugin-calls/11111111-1111-4111-8111-111111111111",
    ];
    for (const path of paths) expect((await app.request(path)).status).toBe(401);
    expect(plugins.receiptsForRun).not.toHaveBeenCalled();
    expect(plugins.receipt).not.toHaveBeenCalled();
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    for (const path of paths) {
      const response = await app.request(path, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(plugins.receiptsForRun).toHaveBeenCalledExactlyOnceWith("receipt-run");
    expect(plugins.receipt).toHaveBeenCalledExactlyOnceWith("11111111-1111-4111-8111-111111111111");
  });

  it("authenticates bounded single-file skill import and rejects malformed or extra content", async () => {
    const store = createTestStore();
    const imported = vi.spyOn(store, "createEmployeeSkill");
    const app = createTestApp({ store });
    const endpoint = "/api/v1/bots/bot/skills/import";
    expect(
      (await app.request(endpoint, { method: "POST", headers: { Origin: testOrigin } })).status,
    ).toBe(401);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const post = (body: unknown, origin = testOrigin) =>
      app.request(endpoint, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const valid = {
      markdown:
        "---\nname: bounded-report\ndescription: Prepare a report\n---\nUse available tools.",
      version: "1.0.0",
      reason: "Import",
    };
    expect((await post(valid, "https://other.example")).status).toBe(403);
    expect((await post({ ...valid, markdown: "not a skill" })).status).toBe(422);
    expect((await post({ ...valid, scripts: [] })).status).toBe(422);
    expect((await post({ ...valid, markdown: "x".repeat(40000) })).status).toBe(422);
    expect(imported).not.toHaveBeenCalled();
  });

  it("requires Owner authentication, origin and explicit bounded review for knowledge proposals", async () => {
    const knowledge = {
      list: vi.fn(async () => []),
      review: vi.fn(async () => ({ proposalId: "proposal", decision: "reject", memoryId: null })),
    };
    const app = createTestApp({ store: createTestStore(), knowledge });
    const endpoint = "/api/v1/bots/bot/knowledge-proposals";
    expect((await app.request(endpoint)).status).toBe(401);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await app.request(endpoint, { headers: { Cookie: cookie } })).status).toBe(200);
    const post = (body: unknown, origin = testOrigin) =>
      app.request(`${endpoint}/proposal/review`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ decision: "reject", ownerReviewed: false })).status).toBe(422);
    expect(
      (await post({ decision: "reject", ownerReviewed: true }, "https://other.example")).status,
    ).toBe(403);
    expect(
      (await post({ decision: "accept", ownerReviewed: true, title: "Fact", content: "Fact" }))
        .status,
    ).toBe(422);
    expect(knowledge.review).not.toHaveBeenCalled();
    expect((await post({ decision: "reject", ownerReviewed: true })).status).toBe(200);
    expect(knowledge.review).toHaveBeenCalledExactlyOnceWith("bot", "proposal", {
      decision: "reject",
      ownerReviewed: true,
    });
    knowledge.review.mockRejectedValueOnce(new StoreConflictError("Already reviewed."));
    expect((await post({ decision: "reject", ownerReviewed: true })).status).toBe(409);
    knowledge.review.mockRejectedValueOnce(new StoreNotFoundError("Not found."));
    expect((await post({ decision: "reject", ownerReviewed: true })).status).toBe(404);
  });

  it("authenticates a strict task cancel command and maps conflicts without leaking errors", async () => {
    const cancelNativeRun = vi.fn(
      async (_id: string) => ({ id: "run-1", channelId: "channel-1", status: "cancelled" }) as Run,
    );
    const app = createTestApp({ store: createTestStore(), cancelRun: cancelNativeRun });
    const post = (cookie?: string, body: unknown = {}, origin = testOrigin) =>
      app.request("/api/v1/runs/run-1/cancel", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post()).status).toBe(401);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect((await post(cookie, { force: true })).status).toBe(422);
    expect((await post(cookie, {}, "https://other.example")).status).toBe(403);
    expect(cancelNativeRun).not.toHaveBeenCalled();
    expect((await post(cookie)).status).toBe(200);
    expect(cancelNativeRun).toHaveBeenCalledExactlyOnceWith("run-1");
    cancelNativeRun.mockRejectedValueOnce(new StoreConflictError("Task ended."));
    expect((await post(cookie)).status).toBe(409);
    cancelNativeRun.mockRejectedValueOnce(new StoreNotFoundError("Task not found."));
    expect((await post(cookie)).status).toBe(404);
    cancelNativeRun.mockRejectedValueOnce(new Error("PRIVATE PROVIDER BODY"));
    const failed = await post(cookie);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("PRIVATE");
  });
  it("authenticates and origin-checks automatic task creation, then validates a bounded command", async () => {
    const create = vi.fn().mockResolvedValue({ id: "schedule-1" });
    const automations = {
      create,
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn(),
      delete: vi.fn(),
      submitDue: vi.fn(),
    };
    const app = createTestApp({ store: createTestStore(), automations });
    const command = {
      name: "Daily check",
      channelId: "channel-1",
      botId: "bot-1",
      prompt: "Check the channel",
      intervalMinutes: 1440,
      firstRunAt: "2027-01-01T00:00:00.000Z",
    };
    const post = (cookie?: string, origin = testOrigin, body: unknown = command) =>
      app.request("/api/v1/automations", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    expect((await post()).status).toBe(401);
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeDefined();
    expect((await post(cookie, "https://untrusted.example")).status).toBe(403);
    expect((await post(cookie, testOrigin, { ...command, approveAll: true })).status).toBe(422);
    expect((await post(cookie, testOrigin, { ...command, intervalMinutes: 1 })).status).toBe(422);
    expect(
      (await post(cookie, testOrigin, { ...command, prompt: "x".repeat(40_000) })).status,
    ).toBe(413);
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000));
        controller.close();
      },
    });
    const streamed = await app.request(
      new Request("http://localhost/api/v1/automations", {
        method: "POST",
        headers: { Origin: testOrigin, "Content-Type": "application/json", Cookie: cookie ?? "" },
        body: streamBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(streamed.status).toBe(413);
    expect(create).not.toHaveBeenCalled();
    expect((await post(cookie)).status).toBe(201);
    expect(create).toHaveBeenCalledExactlyOnceWith(command);
    expect(
      (await app.request("/api/v1/automations", { headers: { Cookie: cookie ?? "" } })).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/v1/automations/schedule-1", {
          method: "PATCH",
          headers: { Origin: testOrigin, "Content-Type": "application/json", Cookie: cookie ?? "" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    expect(automations.setEnabled).toHaveBeenCalledWith("schedule-1", false);
    expect(
      (
        await app.request("/api/v1/automations/schedule-1", {
          method: "DELETE",
          headers: { Origin: testOrigin, Cookie: cookie ?? "" },
        })
      ).status,
    ).toBe(200);
    expect(automations.delete).toHaveBeenCalledWith("schedule-1");
  });

  it("accepts configured Web origins and an exact same-origin Desktop proxy request", () => {
    expect(
      isTrustedMutationOrigin(testOrigin, "https://server.example/api/v1/auth/login", [testOrigin]),
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        "https://server.example",
        "https://server.example/api/v1/auth/login",
        [testOrigin],
      ),
    ).toBe(true);
    for (const origin of [undefined, "null", "https://attacker.example"]) {
      expect(
        isTrustedMutationOrigin(origin, "https://server.example/api/v1/auth/login", [testOrigin]),
      ).toBe(false);
    }
    expect(isTrustedMutationOrigin("https://server.example", "not a URL", [testOrigin])).toBe(
      false,
    );
  });

  it("permits an exact same-origin login while retaining cross-site rejection", async () => {
    const app = createTestApp({ store: createTestStore() });
    const sameOrigin = await app.request("http://localhost/api/v1/auth/login", {
      body: JSON.stringify({ password: "correct-owner-password" }),
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      method: "POST",
    });
    expect(sameOrigin.status).toBe(200);

    const crossSite = await app.request("http://localhost/api/v1/auth/login", {
      body: JSON.stringify({ password: "correct-owner-password" }),
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      method: "POST",
    });
    expect(crossSite.status).toBe(403);
  });

  it.each([undefined, "1", "65536"])(
    "stops oversized login streams even with Content-Length %s",
    async (contentLength) => {
      const { app, loginAttempt } = createObservedLoginApp();
      const fixture = requestBodyChunks(32, 8192);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Origin: testOrigin,
      };
      if (contentLength !== undefined) headers["Content-Length"] = contentLength;
      const request = streamedRequest("/api/v1/auth/login", fixture.body, headers);
      const response = await app.request(request);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "Request body must not exceed 65536 bytes.",
        fields: {},
      });
      expect(fixture.pulls).toHaveBeenCalledTimes(9);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(request.body?.locked).toBe(false);
      expect(loginAttempt).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "rejected"])(
    "rejects oversized declared bodies without waiting for %s cancellation",
    async (cancellation) => {
      const { app, loginAttempt } = createObservedLoginApp();
      const fixture = requestBodyChunks(32, 8192);
      fixture.cancel.mockImplementation(() =>
        cancellation === "pending"
          ? new Promise<void>(() => undefined)
          : Promise.reject(new Error("source cancellation failed")),
      );
      const request = streamedRequest("/api/v1/auth/login", fixture.body, {
        "Content-Length": "65537",
        Origin: testOrigin,
      });
      const response = await app.request(request);

      expect(response.status).toBe(422);
      expect(fixture.pulls).not.toHaveBeenCalled();
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(request.body?.locked).toBe(false);
      expect(loginAttempt).not.toHaveBeenCalled();
    },
  );

  it("counts UTF-8 bytes and preserves a split BOM and multibyte login at the exact limit", async () => {
    const password = "测试-owner-password";
    const { app, loginAttempt } = createObservedLoginApp(password);
    const json = `\uFEFF${JSON.stringify({ password })}`;
    const encoded = new TextEncoder().encode(json);
    const remaining = 65536 - encoded.byteLength;
    const chunks = [encoded.subarray(0, 1), encoded.subarray(1, 17), encoded.subarray(17)];
    chunks.push(new Uint8Array(remaining).fill(32));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = streamedRequest("/api/v1/auth/login", body, { Origin: testOrigin });

    const response = await app.request(request);

    expect(response.status).toBe(200);
    expect(loginAttempt).toHaveBeenCalledWith(password, expect.any(String));
    expect(request.body?.locked).toBe(false);

    const oversized = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin },
      body: json + " ".repeat(remaining + 1),
    });
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toMatchObject({
      error: "Request body must not exceed 65536 bytes.",
    });
    expect(loginAttempt).toHaveBeenCalledOnce();
  });

  it.each(["empty", "malformed", "read failure"])(
    "keeps login validation fail-closed for %s bodies",
    async (failure) => {
      const { app, loginAttempt } = createObservedLoginApp();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (failure === "read failure") controller.error(new Error("private source error"));
          else {
            if (failure === "malformed") controller.enqueue(new TextEncoder().encode("{"));
            controller.close();
          }
        },
      });
      const request = streamedRequest("/api/v1/auth/login", body, { Origin: testOrigin });
      const response = await app.request(request);

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "Request body must be valid JSON.",
        fields: {},
      });
      expect(request.body?.locked).toBe(false);
      expect(loginAttempt).not.toHaveBeenCalled();
    },
  );

  it("enforces a smaller per-route JSON limit while streaming", async () => {
    const cancelNativeRun = vi.fn();
    const app = createTestApp({ cancelNativeRun, store: createTestStore() });
    const cookie = await login(app);
    const fixture = requestBodyChunks(8, 64);
    const response = await app.request(
      streamedRequest(
        "/api/v1/runs/00000000-0000-4000-8000-000000000001/cancel",
        fixture.body,
        authenticatedHeaders(cookie),
      ),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "Request body must not exceed 128 bytes.",
    });
    expect(fixture.pulls).toHaveBeenCalledTimes(3);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(cancelNativeRun).not.toHaveBeenCalled();
  });

  it("protects model settings with Owner authentication and mutation origin checks", async () => {
    const app = createTestApp({ store: createTestStore() });
    expect((await app.request("/api/v1/settings/model")).status).toBe(401);
    expect(
      (
        await app.request("/api/v1/settings/model", {
          method: "POST",
          headers: { Origin: testOrigin },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/v1/settings/model", {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    const response = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { Origin: testOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const settings = await app.request("/api/v1/settings/model", { headers: { Cookie: cookie } });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({ status: "unavailable" });
  });

  it("reports M1 health", async () => {
    const app = createTestApp({ store: createTestStore() });
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, phase: "m1" });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("emits a Server-generated request id and logs the path without its query", async () => {
    const logs: CapturedLog[] = [];
    const app = createTestApp({ logger: createCaptureLogger(logs), store: createTestStore() });
    const response = await app.request("/health?token=request-secret");

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(logs).toMatchObject([
      {
        event: "http.request_completed",
        fields: { method: "GET", path: "/health", status: 200 },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("request-secret");
  });

  it("returns and logs a stable internal error without exception diagnostics", async () => {
    const logs: CapturedLog[] = [];
    const store = createTestStore();
    store.getCounts = async () => {
      throw new TypeError("token=database-secret at /Users/alice/private.txt");
    };
    const app = createTestApp({ logger: createCaptureLogger(logs), store });
    const cookie = await login(app);
    logs.length = 0;

    const response = await app.request("/api/v1/bootstrap", { headers: { Cookie: cookie } });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: "OpenBot Server could not complete the request.",
      code: "internal_error",
      requestId: response.headers.get("x-request-id"),
    });
    expect(logs).toMatchObject([
      {
        event: "http.request_failed",
        fields: { code: "internal_error", errorName: "TypeError" },
      },
      {
        event: "http.request_completed",
        fields: { path: "/api/v1/bootstrap", status: 500 },
      },
    ]);
    expect(JSON.stringify({ body, logs })).not.toContain("database-secret");
    expect(JSON.stringify({ body, logs })).not.toContain("/Users/alice");
  });

  it("reports an anonymous session and protects control-plane data", async () => {
    const app = createTestApp({ store: createTestStore() });

    const session = await app.request("/api/v1/auth/session");
    expect(await session.json()).toEqual({ authenticated: false });

    const workspace = await app.request("/api/v1/workspace");
    expect(workspace.status).toBe(401);
    expect(await workspace.json()).toEqual({ error: "Authentication required." });
  });

  it("creates and revokes an HttpOnly owner session", async () => {
    const app = createTestApp({ store: createTestStore() });

    const rejected = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({ password: "incorrect-password" }),
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const cookie = await login(app);
    expect(cookie).toContain(`${ownerSessionCookie}=`);

    const active = await app.request("/api/v1/auth/session", {
      headers: { Cookie: cookie },
    });
    expect(await active.json()).toMatchObject({
      authenticated: true,
      owner: { id: "owner", name: "Test Owner" },
    });

    const logout = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: testOrigin },
    });
    expect(logout.status).toBe(204);

    const revoked = await app.request("/api/v1/auth/session", {
      headers: { Cookie: cookie },
    });
    expect(await revoked.json()).toEqual({ authenticated: false });
  });

  it("uses an HTTPS-bound host cookie and HSTS for remote deployments", async () => {
    const app = createTestApp({ secureCookies: true, store: createTestStore() });
    const response = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${secureOwnerSessionCookie}=`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");

    const active = await app.request("/api/v1/auth/session", {
      headers: { Cookie: cookie?.split(";", 1)[0] ?? "" },
    });
    expect(await active.json()).toMatchObject({ authenticated: true });
  });

  it("fails closed when the trusted proxy omits its single-hop client identity", async () => {
    const app = createTestApp({
      store: createTestStore(),
      remoteAddress: "192.0.2.11",
      trustedProxyAddress: "192.0.2.11",
    });
    const response = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Client network identity is unavailable." });
  });

  it("issues, exchanges, and revokes a per-Node credential", async () => {
    const nodeIdentity = new NodeIdentityService(createMemoryNodeIdentityStore());
    const disconnectNode = vi.fn(() => true);
    const app = createTestApp({
      disconnectNode,
      nodeIdentity,
      store: createTestStore(),
    });

    const anonymousIssue = await app.request("/api/v1/nodes/enrollment-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({ nodeId: "linux-node" }),
    });
    expect(anonymousIssue.status).toBe(401);
    const anonymousList = await app.request("/api/v1/node-identities");
    expect(anonymousList.status).toBe(401);

    const cookie = await login(app);
    const issued = await app.request("/api/v1/nodes/enrollment-tokens", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ nodeId: "linux-node", expiresInSeconds: 600 }),
    });
    expect(issued.status).toBe(201);
    const enrollment = (await issued.json()) as { token: string };
    expect(enrollment.token).toMatch(/^obenr_/);

    const exchange = await app.request("/api/v1/nodes/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "linux-node", token: enrollment.token }),
    });
    expect(exchange.status).toBe(201);
    expect(await exchange.json()).toMatchObject({
      format: "openbot.node-identity/v1",
      nodeId: "linux-node",
      credential: expect.stringMatching(/^obn_/),
    });
    expect(disconnectNode).toHaveBeenCalledWith("linux-node");
    disconnectNode.mockClear();

    const identities = await app.request("/api/v1/node-identities", {
      headers: { Cookie: cookie },
    });
    expect(identities.status).toBe(200);
    const identityBody = await identities.json();
    expect(identityBody).toEqual({
      identities: [
        expect.objectContaining({
          nodeId: "linux-node",
          status: "active",
          connected: false,
        }),
      ],
    });
    expect(JSON.stringify(identityBody)).not.toMatch(/credential|digest|token/i);

    const replay = await app.request("/api/v1/nodes/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "linux-node", token: enrollment.token }),
    });
    expect(replay.status).toBe(401);

    const oversized = await app.request("/api/v1/nodes/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "linux-node", token: `obenr_${"x".repeat(9_000)}` }),
    });
    expect(oversized.status).toBe(413);

    const revoked = await app.request("/api/v1/nodes/linux-node/revoke", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
    });
    expect(revoked.status).toBe(204);
    expect(disconnectNode).toHaveBeenCalledWith("linux-node");

    const revokedIdentities = await app.request("/api/v1/node-identities", {
      headers: { Cookie: cookie },
    });
    expect(await revokedIdentities.json()).toEqual({
      identities: [
        expect.objectContaining({
          nodeId: "linux-node",
          status: "revoked",
          connected: false,
        }),
      ],
    });
  });

  it("rate limits repeated invalid enrollment exchanges by client identity", async () => {
    const app = createTestApp({
      nodeIdentity: new NodeIdentityService(createMemoryNodeIdentityStore()),
      store: createTestStore(),
    });
    const request = () =>
      app.request("/api/v1/nodes/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: "linux-node", token: `obenr_${"x".repeat(43)}` }),
      });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await request()).status).toBe(401);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("300");
  });

  it("rejects mutations without a trusted Origin", async () => {
    const app = createTestApp({ store: createTestStore() });
    const response = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-owner-password" }),
    });
    expect(response.status).toBe(403);
  });

  it("projects persisted and connected counts into workspace", async () => {
    const store = createTestStore();
    await store.createBot({ name: "Ops", role: "Operations", computerProfile: "docker-linux" });
    const app = createTestApp({
      listNodes: () => [
        {
          id: "node-1",
          name: "Linux worker",
          platform: "linux",
          osVersion: "6.8.0",
          architecture: "x64",
          deviceClass: "server",
          isolation: "unknown",
          trustTier: "development",
          capabilities: ["browser"],
          capabilityManifest: [],
          activeRunIds: [],
          maxConcurrentRuns: 1,
          connectedAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      store,
    });
    const cookie = await login(app);
    const response = await app.request("/api/v1/workspace", { headers: { Cookie: cookie } });

    expect(await response.json()).toMatchObject({
      counts: { bots: 1, channels: 0, connectedNodes: 1 },
      progress: [],
    });
  });

  it("uses the coherent store read instead of independently sampled workspace fields", async () => {
    const store = createTestStore();
    const read = vi.spyOn(store, "readWorkspaceSnapshot");
    const legacy = vi.spyOn(store, "getCounts").mockRejectedValue(new Error("incoherent read"));
    const app = createTestApp({ store });
    const cookie = await login(app);
    const response = await app.request("/api/v1/workspace", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("authenticates snapshot streams and reconnects with full replacement despite Last-Event-ID", async () => {
    const app = createTestApp({ store: createTestStore() });
    const path = "/api/v1/workspace/snapshots";
    expect((await app.request(path)).status).toBe(401);
    const cookie = await login(app);
    const connect = () =>
      app.request(path, { headers: { Cookie: cookie, "Last-Event-ID": "old:99" } });
    const first = await connect();
    const reader = first.body!.getReader();
    const text = new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: workspace.snapshot");
    expect(text).toContain('"version":1');
    expect(text).toContain('"sequence":1');
    expect(text).not.toContain("old:99");
    await reader.cancel();
    const second = await connect();
    const secondReader = second.body!.getReader();
    const next = new TextDecoder().decode((await secondReader.read()).value);
    expect(next).toContain('"sequence":1');
    expect(next).not.toBe(text);
    await secondReader.cancel();
  });

  it("bounds snapshot subscriptions and recovers capacity after cancellation", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const connect = () =>
      app.request("/api/v1/workspace/snapshots", { headers: { Cookie: cookie } });
    const readers = [];
    for (let i = 0; i < 16; i++) {
      const response = await connect();
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      readers.push(reader);
    }
    const rejected = await connect();
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("5");
    await Promise.all(readers.map((reader) => reader.cancel()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovered = await connect();
    expect(recovered.status).toBe(200);
    const reader = recovered.body!.getReader();
    await reader.read();
    await reader.cancel();
  });

  it("streams the authoritative Node snapshot and later workspace changes", async () => {
    const node: ExecutionNode = {
      id: "node-1",
      name: "Linux worker",
      platform: "linux",
      osVersion: "6.8.0",
      architecture: "x64",
      deviceClass: "server",
      isolation: "unknown",
      trustTier: "development",
      capabilities: ["browser"],
      capabilityManifest: [],
      activeRunIds: [],
      maxConcurrentRuns: 1,
      connectedAt: "2026-09-04T00:00:00.000Z",
      lastSeenAt: "2026-09-04T00:00:00.000Z",
    };
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const app = createTestApp({
      listNodes: () => [node],
      store: createTestStore(),
      workspaceRealtime,
    });
    const cookie = await login(app);
    const controller = new AbortController();
    const response = await app.request("/api/v1/workspace/events", {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const ready = new TextDecoder().decode((await reader?.read())?.value);
    expect(ready).toContain("event: workspace.ready");
    expect(ready).toContain('"id":"node-1"');

    workspaceRealtime.publish({
      type: "node.removed",
      nodeId: node.id,
      occurredAt: "2026-09-04T00:01:00.000Z",
    });
    const removed = new TextDecoder().decode((await reader?.read())?.value);
    expect(removed).toContain("event: node.removed");
    expect(removed).toContain('"nodeId":"node-1"');

    const run: Run = {
      id: "00000000-0000-4000-8000-000000000020",
      channelId: "00000000-0000-4000-8000-000000000021",
      botId: "00000000-0000-4000-8000-000000000022",
      executionProfile: "docker-linux",
      instruction: "打开测试页",
      title: "打开测试页",
      status: "completed",
      resultSummary: "完成",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:02:00.000Z",
    };
    workspaceRealtime.publish({ type: "run.updated", run });
    const updated = new TextDecoder().decode((await reader?.read())?.value);
    expect(updated).toContain("event: run.updated");
    expect(updated).toContain(`id: ${run.id}`);
    expect(updated).toContain('"status":"completed"');

    workspaceRealtime.publish({
      type: "employee.profile.changed",
      botId: run.botId,
      sections: ["memory"],
      occurredAt: "2026-09-04T00:03:00.000Z",
    });
    const employeeChanged = new TextDecoder().decode((await reader?.read())?.value);
    expect(employeeChanged).toContain("event: employee.profile.changed");
    expect(employeeChanged).toContain(`id: ${run.botId}`);
    expect(employeeChanged).not.toContain("content");

    await reader?.cancel();
    controller.abort();
  });

  it("serves an authenticated artifact as non-cacheable inline content", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let storedBytes = bytes;
    const artifact: ArtifactRecord = {
      id: "00000000-0000-4000-8000-000000000010",
      runId: "00000000-0000-4000-8000-000000000011",
      name: "result.png",
      mediaType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      createdAt: "2026-09-03T00:00:00.000Z",
      storageKey:
        "runs/00000000-0000-4000-8000-000000000011/00000000-0000-4000-8000-000000000010.png",
      metadata: {},
    };
    const store = createTestStore();
    store.getArtifact = async (artifactId) => (artifactId === artifact.id ? artifact : undefined);
    const app = createTestApp({
      artifactStorage: {
        read: async (storageKey) => {
          expect(storageKey).toBe(artifact.storageKey);
          return storedBytes;
        },
      },
      store,
    });

    const anonymous = await app.request(`/api/v1/artifacts/${artifact.id}/content`);
    expect(anonymous.status).toBe(401);

    const cookie = await login(app);
    const response = await app.request(`/api/v1/artifacts/${artifact.id}/content`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    storedBytes = Buffer.concat([bytes, Buffer.from([0x00])]);
    const wrongSize = await app.request(`/api/v1/artifacts/${artifact.id}/content`, {
      headers: { Cookie: cookie },
    });
    expect(wrongSize.status).toBe(500);

    storedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x46]);
    const corrupted = await app.request(`/api/v1/artifacts/${artifact.id}/content`, {
      headers: { Cookie: cookie },
    });
    expect(corrupted.status).toBe(500);
  });

  it("serves reports only to the Owner with named attachment disposition and verified bytes", async () => {
    const bytes = Buffer.from("# 研究报告\n\nA useful finding.");
    const artifact: ArtifactRecord = {
      id: "00000000-0000-4000-8000-000000000010",
      runId: "00000000-0000-4000-8000-000000000011",
      name: "研究报告.md",
      mediaType: "text/markdown",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      createdAt: "2026-09-08T00:00:00.000Z",
      storageKey:
        "runs/00000000-0000-4000-8000-000000000011/00000000-0000-4000-8000-000000000010.md",
      metadata: {},
    };
    const store = createTestStore();
    store.getArtifact = async () => artifact;
    const app = createTestApp({ store, artifactStorage: { read: async () => bytes } });
    expect((await app.request(`/api/v1/artifacts/${artifact.id}/content`)).status).toBe(401);
    const response = await app.request(`/api/v1/artifacts/${artifact.id}/content`, {
      headers: { Cookie: await login(app) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown");
    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    );
    expect(response.headers.get("content-disposition")).toMatch(/^attachment/u);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(bytes.toString("utf8"));
  });

  it("serves the latest authenticated live frame without persistence", async () => {
    const runFrames = new RunFrameStore();
    const runId = "00000000-0000-4000-8000-000000000011";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    runFrames.publish("channel-1", {
      type: "run.frame",
      protocolVersion,
      nodeId: "linux-node",
      runId,
      mediaType: "image/png",
      base64: bytes.toString("base64"),
      capturedAt: "2026-09-04T00:00:00.000Z",
    });
    const app = createTestApp({ runFrames, store: createTestStore() });

    expect((await app.request(`/api/v1/runs/${runId}/frame`)).status).toBe(401);
    const cookie = await login(app);
    const response = await app.request(`/api/v1/runs/${runId}/frame`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("etag")).toBe('"run-frame-1"');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("creates a Bot through the validated API", async () => {
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const events: WorkspaceRealtimeEvent[] = [];
    workspaceRealtime.subscribe((event) => events.push(event));
    const app = createTestApp({ store: createTestStore(), workspaceRealtime });
    const cookie = await login(app);
    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        name: "Ops",
        role: "Browser and operations",
        computerProfile: "docker-linux",
        appearance: {
          head: "cat",
          body: "cape",
          mobility: "hover",
          accessory: "headphones",
          accent: "green",
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      bot: {
        name: "Ops",
        status: "idle",
        computerProfile: "docker-linux",
        appearance: { head: "cat", body: "cape", mobility: "hover" },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "employee.profile.changed",
        sections: ["identity", "evolution", "configuration"],
      }),
    ]);
  });

  it("returns an authenticated, evidence-oriented employee profile", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Ops",
      role: "Browser and operations",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: "Operations",
      description: "Daily work",
      botIds: [bot.id],
    });
    const submitted = await store.submitTask(channel.id, { content: "Open the test page" });
    await store.assignRun(submitted.run.id, "node-1");
    await store.startRun(submitted.run.id, "node-1");
    await store.appendRunProgress(
      submitted.run.id,
      "node-1",
      "observing",
      "Reading the page before acting.",
    );

    const app = createTestApp({ store });
    expect((await app.request(`/api/v1/bots/${bot.id}/profile`)).status).toBe(401);

    const cookie = await login(app);
    const response = await app.request(`/api/v1/bots/${bot.id}/profile`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: {
        employee: { id: bot.id, name: "Ops" },
        evolution: [{ type: "created", source: "manual" }],
        skills: [],
        memories: [],
        records: {
          runs: [{ id: submitted.run.id, status: "running" }],
          decisions: [
            {
              stage: "observing",
              summary: "Reading the page before acting.",
            },
          ],
        },
        statistics: { totalRuns: 1, verifiedSkills: 0 },
        configuration: { portabilityFormat: "openbot.employee/v1" },
      },
    });

    const missing = await app.request("/api/v1/bots/missing/profile", {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("manages bounded Employee memory with revision conflicts and content-free audit", async () => {
    const store = createTestStore();
    const employee = await store.createBot({
      name: "Memory Worker",
      role: "Retain reviewed operating preferences",
      computerProfile: "none",
    });
    const otherEmployee = await store.createBot({
      name: "Other Worker",
      role: "Prove memory ownership isolation",
      computerProfile: "none",
    });
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const events: WorkspaceRealtimeEvent[] = [];
    workspaceRealtime.subscribe((event) => events.push(event));
    const app = createTestApp({ store, workspaceRealtime });

    const unauthenticated = await app.request(`/api/v1/bots/${employee.id}/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({}),
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(app);
    const created = await app.request(`/api/v1/bots/${employee.id}/memories`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        kind: "semantic",
        title: "Report preference",
        content: "Lead with a concise summary.",
        sensitivity: "internal",
        portability: "owner-selectable",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      memory: EmployeeMemory;
      event: EmployeeMemoryEvent;
    };
    expect(createdBody).toMatchObject({
      memory: { botId: employee.id, revision: 1, title: "Report preference" },
      event: { action: "created", revision: 1, actor: "owner" },
    });
    expect(JSON.stringify(createdBody.event)).not.toContain("Lead with a concise summary.");

    const crossEmployee = await app.request(
      `/api/v1/bots/${otherEmployee.id}/memories/${createdBody.memory.id}`,
      {
        method: "PATCH",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 1, content: "Cross-employee overwrite" }),
      },
    );
    expect(crossEmployee.status).toBe(404);

    const updated = await app.request(
      `/api/v1/bots/${employee.id}/memories/${createdBody.memory.id}`,
      {
        method: "PATCH",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 1, content: "Lead with the outcome." }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      memory: { revision: 2, content: "Lead with the outcome." },
      event: { action: "updated", revision: 2, changedFields: ["content"] },
    });

    const staleUpdate = await app.request(
      `/api/v1/bots/${employee.id}/memories/${createdBody.memory.id}`,
      {
        method: "PATCH",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 1, content: "Overwrite stale state" }),
      },
    );
    expect(staleUpdate.status).toBe(409);

    const unreviewedDelete = await app.request(
      `/api/v1/bots/${employee.id}/memories/${createdBody.memory.id}`,
      {
        method: "DELETE",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 2, ownerReviewed: false }),
      },
    );
    expect(unreviewedDelete.status).toBe(422);

    const deleted = await app.request(
      `/api/v1/bots/${employee.id}/memories/${createdBody.memory.id}`,
      {
        method: "DELETE",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({ expectedRevision: 2, ownerReviewed: true }),
      },
    );
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as { event: EmployeeMemoryEvent };
    expect(deletedBody.event).toMatchObject({ action: "deleted", revision: 3 });
    expect(JSON.stringify(deletedBody.event)).not.toContain("Lead with the outcome.");
    expect(JSON.stringify(deletedBody.event)).not.toContain("Report preference");

    const profile = await store.getEmployeeProfile(employee.id);
    expect(profile.memories).toEqual([]);
    expect(profile.memoryEvents.map((event) => event.action)).toEqual([
      "deleted",
      "updated",
      "created",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: employee.id,
        sections: ["memory"],
      }),
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: employee.id,
        sections: ["memory"],
      }),
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: employee.id,
        sections: ["memory"],
      }),
    ]);
  });

  it("updates descriptive Employee profile fields with revision conflicts", async () => {
    const store = createTestStore();
    const employee = await store.createBot({
      name: "Profile Worker",
      role: "General operations",
      computerProfile: "docker-linux",
    });
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const events: WorkspaceRealtimeEvent[] = [];
    workspaceRealtime.subscribe((event) => events.push(event));
    const app = createTestApp({ store, workspaceRealtime });

    const unauthenticated = await app.request(`/api/v1/bots/${employee.id}/profile`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({
        role: "Evidence reviewer",
        description: "Review evidence without changing host authority.",
        expectedRevision: 1,
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(app);
    const updated = await app.request(`/api/v1/bots/${employee.id}/profile`, {
      method: "PATCH",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        role: "Evidence reviewer",
        description: "Review evidence without changing host authority.",
        expectedRevision: 1,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      employee: { id: employee.id, role: "Evidence reviewer" },
      details: {
        description: "Review evidence without changing host authority.",
        revision: 2,
      },
      evolution: {
        type: "role_changed",
        summary: "Owner updated: role, description.",
        evidence: [],
      },
    });

    const stale = await app.request(`/api/v1/bots/${employee.id}/profile`, {
      method: "PATCH",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        role: "Stale writer",
        description: "Should not win.",
        expectedRevision: 1,
      }),
    });
    expect(stale.status).toBe(409);

    const unchanged = await app.request(`/api/v1/bots/${employee.id}/profile`, {
      method: "PATCH",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        role: "Evidence reviewer",
        description: "Review evidence without changing host authority.",
        expectedRevision: 2,
      }),
    });
    expect(unchanged.status).toBe(422);

    const authoritySmuggling = await app.request(`/api/v1/bots/${employee.id}/profile`, {
      method: "PATCH",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        role: "Evidence reviewer",
        description: "Review evidence without changing host authority.",
        expectedRevision: 2,
        computerProfile: "macos-cua",
      }),
    });
    expect(authoritySmuggling.status).toBe(422);

    const profile = await store.getEmployeeProfile(employee.id);
    expect(profile.employee.role).toBe("Evidence reviewer");
    expect(profile.details).toMatchObject({ revision: 2 });
    expect(profile.evolution.at(-1)).toMatchObject({
      summary: "Owner updated: role, description.",
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: employee.id,
        sections: ["identity", "configuration", "evolution"],
      }),
    ]);
    expect(events[0]).not.toHaveProperty("description");
  });

  it("keeps learned skills pending until the Owner reviews an auditable transition", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Researcher",
      role: "Evidence-backed research",
      computerProfile: "docker-linux",
    });
    const node: ExecutionNode = {
      id: "linux-worker",
      name: "Linux worker",
      platform: "linux",
      osVersion: "6.8",
      architecture: "x64",
      deviceClass: "server",
      isolation: "container",
      trustTier: "dedicated",
      capabilities: ["browser"],
      capabilityManifest: [],
      maxConcurrentRuns: 1,
      activeRunIds: [],
      status: "online",
      connectedAt: "2026-09-04T00:00:00.000Z",
      lastSeenAt: "2026-09-04T00:00:00.000Z",
    };
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const events: WorkspaceRealtimeEvent[] = [];
    workspaceRealtime.subscribe((event) => events.push(event));
    const app = createTestApp({ store, listNodes: () => [node], workspaceRealtime });

    const unauthenticated = await app.request(`/api/v1/bots/${bot.id}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: testOrigin },
      body: JSON.stringify({}),
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(app);
    const created = await app.request(`/api/v1/bots/${bot.id}/skills`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        slug: "source-triangulation",
        name: "Source triangulation",
        description: "Compare independent primary sources before reporting a conclusion.",
        version: "1.0.0",
        source: "learned",
        requiredCapabilities: ["browser.observe", "browser.observe"],
        reason: "Repeated research Runs produced a reusable procedure.",
        evidence: [{ kind: "run", id: "research-run-42", label: "Evaluation fixture" }],
      }),
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as {
      skill: EmployeeSkill;
      evolution: EmployeeEvolutionEvent;
    };
    expect(createdPayload).toMatchObject({
      skill: {
        state: "candidate",
        confidence: 0,
        requiredCapabilities: ["browser.observe"],
      },
      evolution: {
        type: "skill_discovered",
        summary: "Repeated research Runs produced a reusable procedure.",
      },
    });

    const unreviewed = await app.request(
      `/api/v1/bots/${bot.id}/skills/${createdPayload.skill.id}/state`,
      {
        method: "POST",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({
          state: "verified",
          confidence: 88,
          reason: "The fixture passed, but review was not asserted.",
        }),
      },
    );
    expect(unreviewed.status).toBe(422);

    const verified = await app.request(
      `/api/v1/bots/${bot.id}/skills/${createdPayload.skill.id}/state`,
      {
        method: "POST",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({
          state: "verified",
          confidence: 88,
          reason: "The Owner reviewed the procedure and its evidence.",
          ownerReviewed: true,
          evidence: [{ kind: "manual", id: "owner-review-1" }],
        }),
      },
    );
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      skill: { state: "verified", confidence: 88 },
      evolution: { type: "skill_verified" },
    });

    const profile = await app.request(`/api/v1/bots/${bot.id}/profile`, {
      headers: { Cookie: cookie },
    });
    expect(await profile.json()).toMatchObject({
      profile: {
        skills: [{ id: createdPayload.skill.id, state: "verified" }],
        evolution: [{ type: "created" }, { type: "skill_discovered" }, { type: "skill_verified" }],
        statistics: { verifiedSkills: 1 },
      },
    });

    const nodes = await app.request("/api/v1/nodes", { headers: { Cookie: cookie } });
    expect(await nodes.json()).toEqual({ nodes: [node] });

    const revoked = await app.request(
      `/api/v1/bots/${bot.id}/skills/${createdPayload.skill.id}/state`,
      {
        method: "POST",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({
          state: "revoked",
          reason: "The procedure is no longer safe for current sources.",
          ownerReviewed: true,
        }),
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ skill: { state: "revoked" } });

    const restoreRevoked = await app.request(
      `/api/v1/bots/${bot.id}/skills/${createdPayload.skill.id}/state`,
      {
        method: "POST",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify({
          state: "verified",
          confidence: 90,
          reason: "Attempt to restore a terminal skill.",
          ownerReviewed: true,
        }),
      },
    );
    expect(restoreRevoked.status).toBe(409);
    expect(events).toEqual([
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: bot.id,
        sections: ["skills", "evolution"],
      }),
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: bot.id,
        sections: ["skills", "evolution"],
      }),
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: bot.id,
        sections: ["skills", "evolution"],
      }),
    ]);
  });

  it("previews and downloads an identity-free employee template", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Ops",
      role: "Browser and operations",
      computerProfile: "docker-linux",
    });
    const app = createTestApp({ store });
    expect((await app.request(`/api/v1/bots/${bot.id}/export/preview`)).status).toBe(401);

    const cookie = await login(app);
    const previewResponse = await app.request(`/api/v1/bots/${bot.id}/export/preview`, {
      headers: { Cookie: cookie },
    });
    expect(previewResponse.status).toBe(200);
    const previewBody = (await previewResponse.json()) as { preview: EmployeeExportPreview };
    const previewEtag = `"${previewBody.preview.downloadReviewToken}"`;
    expect(previewResponse.headers.get("etag")).toBeNull();
    expect(previewBody).toMatchObject({
      preview: {
        blocked: false,
        employeeName: "Ops",
        fileName: "ops.openbot-employee.json",
        hostAuthority: "none",
        identityOnImport: "new",
        includedMemoryCount: 0,
        signatureStatus: "unsigned",
      },
    });

    const downloadUrl = employeeExportDownloadUrl(bot.id, previewBody.preview);
    const missingReview = await app.request(downloadUrl, {
      headers: { Cookie: cookie },
    });
    expect(missingReview.status).toBe(428);
    expect(await missingReview.json()).toMatchObject({
      error: expect.stringContaining("requires a reviewed preview"),
    });

    const legacyUnreviewedDownload = await app.request(`/api/v1/bots/${bot.id}/export`, {
      headers: { Cookie: cookie },
    });
    expect(legacyUnreviewedDownload.status).toBe(428);

    const unknownParameter = await app.request(`${downloadUrl}&unexpected=true`, {
      headers: { Cookie: cookie, "If-Match": previewEtag },
    });
    expect(unknownParameter.status).toBe(422);

    const weakReview = await app.request(downloadUrl, {
      headers: { Cookie: cookie, "If-Match": `W/${previewEtag}` },
    });
    expect(weakReview.status).toBe(422);

    const staleReview = await app.request(downloadUrl, {
      headers: { Cookie: cookie, "If-Match": `"${"0".repeat(64)}"` },
    });
    expect(staleReview.status).toBe(412);

    const downloadResponse = await app.request(downloadUrl, {
      headers: { Cookie: cookie, "If-Match": previewEtag },
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("etag")).toBe(previewEtag);
    expect(downloadResponse.headers.get("content-type")).toContain(
      "application/vnd.openbot.employee+json",
    );
    expect(downloadResponse.headers.get("content-disposition")).toBe(
      'attachment; filename="ops.openbot-employee.json"',
    );
    const downloadedBody = await downloadResponse.text();
    expect(createHash("sha256").update(downloadedBody).digest("hex")).toBe(
      previewBody.preview.downloadReviewToken,
    );
    const employeePackage = employeeTemplatePackageSchema.parse(JSON.parse(downloadedBody));
    expect(employeePackage.payload.packageId).toBe(previewBody.preview.packageId);
    expect(employeePackage.payload.generatedAt).toBe(previewBody.preview.generatedAt);
    expect(employeePackage.integrity.digest).toBe(previewBody.preview.checksum);
    expect(employeePackage.payload.employee).not.toHaveProperty("id");
    expect(employeePackage.payload.portability.authority).toBe("none");
    expect(verifyEmployeeTemplateChecksum(employeePackage)).toBe(true);

    const importPreviewResponse = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify(employeePackage),
    });
    expect(importPreviewResponse.status).toBe(200);
    expect(await importPreviewResponse.json()).toMatchObject({
      preview: {
        employee: { name: "Ops" },
        integrity: { valid: true },
        signature: { status: "unsigned", trusted: false },
        quarantine: {
          active: true,
          createsNewIdentity: true,
          hostAuthority: "none",
          canActivate: false,
        },
      },
    });

    await store.updateEmployeeProfileDetails(bot.id, {
      role: "Changed after export review",
      description: "",
      expectedRevision: 1,
    });
    const changedAfterReview = await app.request(downloadUrl, {
      headers: { Cookie: cookie, "If-Match": previewEtag },
    });
    expect(changedAfterReview.status).toBe(412);

    const unknownFieldResponse = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ ...employeePackage, credentials: { token: "hidden" } }),
    });
    expect(unknownFieldResponse.status).toBe(422);
    expect(await unknownFieldResponse.json()).toMatchObject({
      error: "Employee package does not match a supported format.",
    });

    const unverifiedSignedDocumentResponse = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        ...employeePackage,
        payload: {
          ...employeePackage.payload,
          signature: { status: "dsse", algorithm: "ed25519", keyid: "unverified-key" },
        },
      }),
    });
    expect(unverifiedSignedDocumentResponse.status).toBe(422);
    expect(await unverifiedSignedDocumentResponse.json()).toMatchObject({
      error: "Employee package does not match a supported format.",
    });
  });

  it("rejects invalid Bot input before reaching storage", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ name: "", role: "", computerProfile: "root-shell" }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "Please correct the highlighted fields.",
    });
  });

  it("rejects oversized employee packages before parsing", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const response = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Employee package must not exceed 2 MiB.",
      fields: {},
    });
  });

  it("stops an oversized Employee stream at its separate 2 MiB limit", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const fixture = requestBodyChunks(64, 65536);
    const request = streamedRequest(
      "/api/v1/employees/import/preview",
      fixture.body,
      authenticatedHeaders(cookie),
    );
    const response = await app.request(request);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Employee package must not exceed 2 MiB.",
      fields: {},
    });
    expect(fixture.pulls).toHaveBeenCalledTimes(33);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(request.body?.locked).toBe(false);
  });

  it("activates an Owner-reviewed package once with a fresh identity and safe replay", async () => {
    const store = createTestStore();
    const source = await store.createBot({
      name: "Portable Analyst",
      role: "Read-only analysis",
      computerProfile: "none",
    });
    const workspaceRealtime = new WorkspaceRealtimeHub();
    const events: WorkspaceRealtimeEvent[] = [];
    workspaceRealtime.subscribe((event) => events.push(event));
    const app = createTestApp({ store, workspaceRealtime });
    const cookie = await login(app);
    const { response: downloaded } = await reviewAndDownloadEmployee(app, source.id, cookie);
    const employeePackage = employeeTemplatePackageSchema.parse(await downloaded.json());
    const previewed = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify(employeePackage).padEnd(128 * 1024, " "),
    });
    const previewBody = (await previewed.json()) as {
      preview: {
        packageId: string;
        integrity: { digest: string };
        quarantine: { canActivate: boolean };
      };
    };
    expect(previewBody.preview.quarantine.canActivate).toBe(true);

    const idempotencyKey = "00000000-0000-4000-8000-000000000701";
    const activationBody = {
      package: employeePackage,
      expectedPackageId: previewBody.preview.packageId,
      expectedDigest: previewBody.preview.integrity.digest,
      ownerReviewed: true,
      allowUnsigned: true,
      idempotencyKey,
      employeeName: "Portable Analyst Copy",
    };

    const unsignedNotAccepted = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ ...activationBody, allowUnsigned: false }),
    });
    expect(unsignedNotAccepted.status).toBe(422);

    const changedDigest = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ ...activationBody, expectedDigest: "0".repeat(64) }),
    });
    expect(changedDigest.status).toBe(409);

    const activated = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify(activationBody).padEnd(128 * 1024, " "),
    });
    expect(activated.status).toBe(201);
    const activation = (await activated.json()) as EmployeeImportActivationResult;
    expect(activation).toMatchObject({
      employee: {
        name: "Portable Analyst Copy",
        role: "Read-only analysis",
        computerProfile: "none",
      },
      receipt: {
        packageId: employeePackage.payload.packageId,
        packageDigest: previewBody.preview.integrity.digest,
        signatureStatus: "unsigned",
        reviewedBy: "owner",
        importedSkillCount: 0,
      },
      replayed: false,
    });
    expect(activation.employee.id).not.toBe(source.id);

    const replayed = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify(activationBody),
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({
      employee: { id: activation.employee.id },
      receipt: { id: activation.receipt.id },
      replayed: true,
    });

    const changedReplay = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ ...activationBody, employeeName: "Different Copy" }),
    });
    expect(changedReplay.status).toBe(409);

    const duplicatePackage = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        ...activationBody,
        idempotencyKey: "00000000-0000-4000-8000-000000000702",
      }),
    });
    expect(duplicatePackage.status).toBe(409);

    const importedProfile = await store.getEmployeeProfile(activation.employee.id);
    expect(importedProfile.memories).toEqual([]);
    expect(importedProfile.skills).toEqual([]);
    expect(importedProfile.evolution).toEqual([
      expect.objectContaining({ type: "imported", source: "import" }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "employee.profile.changed",
        botId: activation.employee.id,
        sections: ["identity", "evolution", "skills", "configuration", "portability"],
      }),
    ]);
  });

  it("exports DSSE and accepts only a signature from configured publisher trust", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Portable Ops",
      role: "Browser and operations",
      computerProfile: "docker-linux",
    });
    const candidate = await store.createEmployeeSkill(bot.id, {
      slug: "browse-web",
      name: "Browse the web",
      description: "Navigate public pages and collect read-only evidence.",
      version: "1.0.0",
      source: "installed",
      requiredCapabilities: ["browser"],
      dependencySkillIds: [],
      evidence: [],
      reason: "Installed for portability test.",
    });
    await store.updateEmployeeSkillState(bot.id, candidate.skill.id, {
      state: "verified",
      confidence: 90,
      reason: "Reviewed for portability test.",
      evidence: [],
      ownerReviewed: true,
    });
    const publisherOne = generateKeyPairSync("ed25519");
    const publisherTwo = generateKeyPairSync("ed25519");
    const employeePublisher = {
      activeKeyId: "owner-key-1",
      sign(document: Parameters<typeof signEmployeeTemplateEnvelope>[0]) {
        return signEmployeeTemplateEnvelope(document, {
          keyid: this.activeKeyId,
          privateKey: publisherOne.privateKey,
        });
      },
      verify(input: unknown) {
        return verifyEmployeeTemplateEnvelope(input, [
          { keyid: this.activeKeyId, publicKey: publisherOne.publicKey },
          { keyid: "owner-key-2", publicKey: publisherTwo.publicKey },
        ]);
      },
    };
    const app = createTestApp({
      store,
      employeePublisher,
      listNodes: () => [createCompatibleBrowserNode()],
    });
    const cookie = await login(app);

    const previewResponse = await app.request(`/api/v1/bots/${bot.id}/export/preview`, {
      headers: { Cookie: cookie },
    });
    const previewBody = (await previewResponse.json()) as { preview: EmployeeExportPreview };
    const previewEtag = `"${previewBody.preview.downloadReviewToken}"`;
    expect(previewBody).toMatchObject({
      preview: {
        fileName: "portable-ops.openbot-employee.dsse.json",
        signatureStatus: "dsse",
        publisherKeyId: "owner-key-1",
      },
    });

    const downloadResponse = await app.request(
      employeeExportDownloadUrl(bot.id, previewBody.preview),
      {
        headers: { Cookie: cookie, "If-Match": previewEtag },
      },
    );
    expect(downloadResponse.headers.get("content-type")).toContain(
      "application/vnd.openbot.employee.dsse+json",
    );
    const signedBody = await downloadResponse.text();
    expect(createHash("sha256").update(signedBody).digest("hex")).toBe(
      previewBody.preview.downloadReviewToken,
    );
    const envelope = dsseEnvelopeSchema.parse(JSON.parse(signedBody));
    const verifiedDownload = employeePublisher.verify(envelope);
    expect(verifiedDownload.status).toBe("verified");
    if (verifiedDownload.status !== "verified") throw new Error("Expected a verified export.");
    expect(verifiedDownload.document.payload.packageId).toBe(previewBody.preview.packageId);
    expect(verifiedDownload.document.payload.generatedAt).toBe(previewBody.preview.generatedAt);
    expect(verifiedDownload.document.integrity.digest).toBe(previewBody.preview.checksum);
    const importResponse = await app.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify(envelope),
    });
    expect(importResponse.status).toBe(200);
    const signedPreview = (await importResponse.json()) as {
      preview: {
        packageId: string;
        integrity: { digest: string };
        signature: { status: "dsse"; trusted: true; keyid: string };
      };
    };
    expect(signedPreview).toMatchObject({
      preview: { signature: { status: "dsse", trusted: true, keyid: "owner-key-1" } },
    });

    const alternateDocument = buildEmployeeTemplate(await store.getEmployeeProfile(bot.id), {
      packageId: verifiedDownload.document.payload.packageId,
      generatedAt: verifiedDownload.document.payload.generatedAt,
    }).document;
    const alternatePublisherEnvelope = signEmployeeTemplateEnvelope(alternateDocument, {
      keyid: "owner-key-2",
      privateKey: publisherTwo.privateKey,
    });
    const changedPublisher = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        package: alternatePublisherEnvelope,
        expectedPackageId: signedPreview.preview.packageId,
        expectedDigest: signedPreview.preview.integrity.digest,
        ownerReviewed: true,
        allowUnsigned: false,
        idempotencyKey: "00000000-0000-4000-8000-000000000704",
        employeeName: "Publisher Changed",
      }),
    });
    expect(changedPublisher.status).toBe(409);
    expect(await changedPublisher.json()).toMatchObject({
      error: expect.stringContaining("changed after preview"),
    });

    const activated = await app.request("/api/v1/employees/import/activate", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        package: envelope,
        expectedPackageId: signedPreview.preview.packageId,
        expectedDigest: signedPreview.preview.integrity.digest,
        ownerReviewed: true,
        allowUnsigned: false,
        idempotencyKey: "00000000-0000-4000-8000-000000000703",
        employeeName: "Portable Ops Copy",
      }),
    });
    expect(activated.status).toBe(201);
    const signedActivation = (await activated.json()) as EmployeeImportActivationResult;
    expect(signedActivation).toMatchObject({
      employee: { name: "Portable Ops Copy" },
      receipt: {
        signatureStatus: "dsse",
        publisherKeyId: "owner-key-1",
        importedSkillCount: 1,
      },
    });
    const importedProfile = await store.getEmployeeProfile(signedActivation.employee.id);
    expect(importedProfile.skills).toEqual([
      expect.objectContaining({
        slug: "browse-web",
        source: "imported",
        state: "candidate",
        confidence: 0,
      }),
    ]);

    const untrustedApp = createTestApp({
      store,
      employeePublisher: {
        ...employeePublisher,
        verify: (input: unknown) => verifyEmployeeTemplateEnvelope(input, []),
      },
    });
    const untrustedCookie = await login(untrustedApp);
    const rejected = await untrustedApp.request("/api/v1/employees/import/preview", {
      method: "POST",
      headers: authenticatedHeaders(untrustedCookie),
      body: JSON.stringify(envelope),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: "Signed Employee package verification failed.",
      fields: { package: [expect.stringContaining("no-trusted-signature")] },
    });
  });

  it("authenticates direct conversations and retains fixed per-Bot identity", async () => {
    const store = createTestStore();
    const bot = await store.createBot({ name: "Ops", role: "Assistant", computerProfile: "none" });
    const other = await store.createBot({
      name: "Coder",
      role: "Assistant",
      computerProfile: "none",
    });
    const app = createTestApp({ store });
    const path = `/api/v1/bots/${bot.id}/conversation`;
    expect(
      (await app.request(path, { method: "POST", headers: { Origin: testOrigin } })).status,
    ).toBe(401);
    const cookie = await login(app);
    const headers = authenticatedHeaders(cookie);
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const first = await app.request(path, { method: "POST", headers });
    expect(first.status).toBe(200);
    const { channel } = (await first.json()) as { channel: Channel };
    expect(channel).toMatchObject({ directBotId: bot.id, botIds: [bot.id] });
    expect(await (await app.request(path, { method: "POST", headers })).json()).toEqual({
      channel,
    });
    expect(
      (await app.request("/api/v1/bots/missing/conversation", { method: "POST", headers })).status,
    ).toBe(404);
    for (const botId of [bot.id, other.id]) {
      expect(
        (
          await app.request(`/api/v1/channels/${channel.id}/bots`, {
            method: "POST",
            headers,
            body: JSON.stringify({ botId }),
          })
        ).status,
      ).toBe(422);
    }
    const sent = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "Prepare a report" }),
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ run: { botId: bot.id } });
    expect(
      (
        await app.request(`/api/v1/channels/${channel.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "Redirect", botId: other.id }),
        })
      ).status,
    ).toBe(422);
  });

  it("creates a channel with a selected Bot", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Chief",
      role: "Coordinator",
      computerProfile: "none",
    });
    const app = createTestApp({ store });
    const cookie = await login(app);
    const response = await app.request("/api/v1/channels", {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({
        name: "运营中心",
        description: "日常运营工作",
        botIds: [bot.id],
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      channel: { name: "运营中心", botIds: [bot.id] },
    });
  });

  it("dispatches every exact recipient from one human message and rejects invalid sets atomically", async () => {
    const store = createTestStore();
    const members = await Promise.all(
      ["Research", "Review"].map((name) =>
        store.createBot({ name, role: name, computerProfile: "none" }),
      ),
    );
    const channel = await store.createChannel({
      name: "Group",
      description: "",
      botIds: members.map((bot) => bot.id),
    });
    const dispatchRun = vi.fn();
    const app = createTestApp({ store, dispatchRun });
    const cookie = await login(app);
    const post = (input: unknown) =>
      app.request(`/api/v1/channels/${channel.id}/messages`, {
        method: "POST",
        headers: authenticatedHeaders(cookie),
        body: JSON.stringify(input),
      });
    const response = await post({ content: "Work together", botIds: members.map((bot) => bot.id) });
    expect(response.status).toBe(201);
    const result = (await response.json()) as { message: Message; run: Run; runs: Run[] };
    expect(result.runs.map((run) => run.botId)).toEqual(members.map((bot) => bot.id));
    expect(result.runs.every((run) => run.sourceMessageId === result.message.id)).toBe(true);
    expect(result.run).toEqual(result.runs[0]);
    expect(dispatchRun).toHaveBeenCalledTimes(2);
    expect(await store.listMessages(channel.id)).toHaveLength(1);
    for (const input of [
      { botIds: [members[0]?.id, "00000000-0000-4000-8000-000000000099"] },
      { botIds: [members[0]?.id, members[0]?.id] },
      { botIds: [members[0]?.id], botId: members[1]?.id },
      { botIds: [] },
    ])
      expect([400, 422]).toContain((await post({ content: "Invalid", ...input })).status);
    expect(await store.listMessages(channel.id)).toHaveLength(1);
    expect(await store.listRuns(channel.id)).toHaveLength(2);
    expect(dispatchRun).toHaveBeenCalledTimes(2);
  });

  it("stores and lists a local channel message", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Ops",
      role: "日常运营",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: "运营中心",
      description: "日常任务",
      botIds: [bot.id],
    });
    const dispatchRun = vi.fn();
    const app = createTestApp({ dispatchRun, store });
    const cookie = await login(app);

    const created = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ content: "  打开测试页并截图  " }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      message: { channelId: channel.id, authorType: "human", content: "打开测试页并截图" },
      run: {
        channelId: channel.id,
        botId: bot.id,
        title: "打开测试页并截图",
        status: "queued",
      },
    });
    expect(dispatchRun).toHaveBeenCalledWith(
      expect.objectContaining({ botId: bot.id, executionProfile: "docker-linux" }),
    );

    const listed = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      headers: { Cookie: cookie },
    });
    expect(await listed.json()).toMatchObject({
      messages: [{ content: "打开测试页并截图" }],
    });

    const listedRuns = await app.request(`/api/v1/channels/${channel.id}/runs`, {
      headers: { Cookie: cookie },
    });
    expect(await listedRuns.json()).toMatchObject({
      runs: [{ botId: bot.id, status: "queued", title: "打开测试页并截图" }],
    });
  });

  it("lets the authenticated Owner resolve a pending approval exactly once", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Ops",
      role: "日常运营",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: "审批测试",
      description: "验证敏感动作",
      botIds: [bot.id],
    });
    const submitted = await store.submitTask(channel.id, { content: "提交测试表单" });
    await store.assignRun(submitted.run.id, "node-1");
    await store.startRun(submitted.run.id, "node-1");
    const requested = await store.requestApproval(submitted.run.id, "node-1", {
      requestId: "00000000-0000-4000-8000-000000000099",
      action: "form.submit",
      target: "https://example.test/form#signup",
      summary: "提交注册表单",
      risk: "write",
      beforeState: { fields: 3 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(requested?.run.status).toBe("waiting_approval");
    if (requested === undefined) throw new Error("Approval was not requested.");

    const resolveApproval = vi.fn();
    const app = createTestApp({ resolveApproval, store });
    const cookie = await login(app);
    const workspace = await app.request("/api/v1/workspace", { headers: { Cookie: cookie } });
    expect(await workspace.json()).toMatchObject({
      approvals: [{ id: requested.approval.id, status: "pending" }],
    });

    const approved = await app.request(`/api/v1/approvals/${requested.approval.id}/decision`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      approval: { status: "approved", decidedBy: "owner" },
      run: { status: "running" },
    });
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approval: expect.objectContaining({ status: "approved" }) }),
    );

    const replayed = await app.request(`/api/v1/approvals/${requested.approval.id}/decision`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(replayed.status).toBe(409);
  });

  it("rejects a task when the channel has no Bot", async () => {
    const store = createTestStore();
    const channel = await store.createChannel({
      name: "空频道",
      description: "还没有成员",
      botIds: [],
    });
    const app = createTestApp({ store });
    const cookie = await login(app);

    const response = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ content: "现在执行任务" }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Add a Bot to this channel before assigning a task.",
    });
  });

  it("prefers Chief and rejects an explicit Bot outside the channel", async () => {
    const store = createTestStore();
    const ops = await store.createBot({
      name: "Ops",
      role: "日常运营",
      computerProfile: "docker-linux",
    });
    const chief = await store.createBot({
      name: "Chief",
      role: "任务协调",
      computerProfile: "none",
    });
    const outsider = await store.createBot({
      name: "Coder",
      role: "代码开发",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: "运营中心",
      description: "日常任务",
      botIds: [ops.id, chief.id],
    });
    const app = createTestApp({ store });
    const cookie = await login(app);

    const routed = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ content: "汇总今日任务" }),
    });
    expect(routed.status).toBe(201);
    expect(await routed.json()).toMatchObject({ run: { botId: chief.id } });

    const rejected = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ content: "绕过频道分派", botId: outsider.id }),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({
      error: "The selected Bot is not a member of this channel.",
    });
  });

  it("returns 404 when reading messages from an unknown channel", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const response = await app.request(
      "/api/v1/channels/00000000-0000-4000-8000-000000000099/messages",
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(404);
  });

  it("opens a channel event stream and publishes persisted messages", async () => {
    const store = createTestStore();
    const bot = await store.createBot({
      name: "Ops",
      role: "日常运营",
      computerProfile: "docker-linux",
    });
    const channel = await store.createChannel({
      name: "实时频道",
      description: "多设备同步",
      botIds: [bot.id],
    });
    const realtime = new ChannelRealtimeHub();
    const published: Message[] = [];
    const publishedRuns: Run[] = [];
    const unsubscribe = realtime.subscribe(channel.id, (event) => {
      if (event.type === "message.created") published.push(event.message);
      if (event.type === "run.created") publishedRuns.push(event.run);
    });
    const app = createTestApp({ realtime, store });
    const cookie = await login(app);
    const controller = new AbortController();
    const response = await app.request(`/api/v1/channels/${channel.id}/events`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader?.read();
    expect(new TextDecoder().decode(firstChunk?.value)).toContain("event: channel.ready");

    const created = await app.request(`/api/v1/channels/${channel.id}/messages`, {
      method: "POST",
      headers: authenticatedHeaders(cookie),
      body: JSON.stringify({ content: "同步给其他设备" }),
    });
    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as { run: Run };
    expect(published).toMatchObject([{ channelId: channel.id, content: "同步给其他设备" }]);
    expect(publishedRuns).toMatchObject([
      { channelId: channel.id, botId: bot.id, status: "queued" },
    ]);
    const messageChunk = await reader?.read();
    const messageEvent = new TextDecoder().decode(messageChunk?.value);
    expect(messageEvent).toContain("event: message.created");
    expect(messageEvent).toContain("同步给其他设备");
    const runEvent = messageEvent.includes("event: run.created")
      ? messageEvent
      : new TextDecoder().decode((await reader?.read())?.value);
    expect(runEvent).toContain("event: run.created");
    expect(runEvent).toContain('"status":"queued"');

    realtime.publish({
      type: "run.progress",
      channelId: channel.id,
      progress: {
        id: "00000000-0000-4000-8000-000000000090",
        runId: createdPayload.run.id,
        channelId: channel.id,
        nodeId: "linux-node",
        stage: "navigate",
        message: "正在打开测试页",
        createdAt: "2026-09-04T00:01:00.000Z",
      },
    });
    const progressEvent = new TextDecoder().decode((await reader?.read())?.value);
    expect(progressEvent).toContain("event: run.progress");
    expect(progressEvent).toContain("正在打开测试页");

    realtime.publish({
      type: "run.frame",
      channelId: channel.id,
      frame: {
        runId: createdPayload.run.id,
        channelId: channel.id,
        nodeId: "linux-node",
        revision: 1,
        mediaType: "image/png",
        sizeBytes: 128,
        width: 1280,
        height: 800,
        capturedAt: "2026-09-04T00:01:01.000Z",
      },
    });
    const frameEvent = new TextDecoder().decode((await reader?.read())?.value);
    expect(frameEvent).toContain("event: run.frame");
    expect(frameEvent).toContain('"revision":1');

    await reader?.cancel();
    controller.abort();
    unsubscribe();
  });

  it("rejects an event stream for an unknown channel", async () => {
    const app = createTestApp({ store: createTestStore() });
    const cookie = await login(app);
    const response = await app.request(
      "/api/v1/channels/00000000-0000-4000-8000-000000000099/events",
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(404);
  });
});

function createCompatibleBrowserNode(): ExecutionNode {
  const now = new Date().toISOString();
  return {
    id: "browser-node",
    name: "Browser worker",
    platform: "linux",
    osVersion: "test",
    architecture: "x64",
    deviceClass: "server",
    isolation: "container",
    trustTier: "development",
    capabilities: ["browser", "screenshot"],
    capabilityManifest: [
      { id: "browser.observe", version: 1, providerId: "test", constraints: {} },
      { id: "screen.capture", version: 1, providerId: "test", constraints: {} },
    ],
    activeRunIds: [],
    maxConcurrentRuns: 1,
    connectedAt: now,
    lastSeenAt: now,
  };
}

function createTestApp({
  auth: configuredAuth,
  plugins,
  knowledge,
  cancelNativeRun,
  cancelRun,
  automations,
  store,
  dispatchRun,
  disconnectNode,
  nodeIdentity,
  resolveApproval,
  listNodes = () => [],
  realtime,
  artifactStorage,
  employeePublisher,
  runFrames,
  workspaceRealtime,
  logger,
  secureCookies = false,
  remoteAddress = "127.0.0.1",
  trustedProxyAddress,
}: {
  auth?: OwnerAuthService;
  plugins?: PluginService;
  knowledge?: Parameters<typeof createApp>[0]["knowledge"];
  cancelRun?: Parameters<typeof createApp>[0]["cancelRun"];
  cancelNativeRun?: Parameters<typeof createApp>[0]["cancelNativeRun"];
  automations?: Parameters<typeof createApp>[0]["automations"];
  store: ControlPlaneStore;
  dispatchRun?: (run: Run) => void;
  disconnectNode?: (nodeId: string) => boolean;
  nodeIdentity?: NodeIdentityService;
  resolveApproval?: Parameters<typeof createApp>[0]["resolveApproval"];
  listNodes?: () => ExecutionNode[];
  realtime?: ChannelRealtimeHub;
  artifactStorage?: Pick<ArtifactStorage, "read">;
  employeePublisher?: Parameters<typeof createApp>[0]["employeePublisher"];
  runFrames?: Pick<RunFrameStore, "get">;
  workspaceRealtime?: WorkspaceRealtimeHub;
  logger?: OpenBotLogger;
  secureCookies?: boolean;
  remoteAddress?: string | undefined;
  trustedProxyAddress?: string | undefined;
}) {
  const requestThrottle = new RequestThrottle(createMemoryThrottleStore());
  const auth =
    configuredAuth ??
    new OwnerAuthService(
      createMemorySessionStore(),
      {
        ownerName: "Test Owner",
        ownerPassword: "correct-owner-password",
        sessionTtlMs: 60_000,
      },
      requestThrottle,
    );
  return createApp({
    ...(plugins === undefined ? {} : { plugins }),
    ...(knowledge === undefined ? {} : { knowledge }),
    ...(cancelRun === undefined ? {} : { cancelRun }),
    ...(cancelNativeRun === undefined ? {} : { cancelNativeRun }),
    ...(automations === undefined ? {} : { automations }),
    allowedOrigins: [testOrigin],
    auth,
    ...(dispatchRun === undefined ? {} : { dispatchRun }),
    ...(disconnectNode === undefined ? {} : { disconnectNode }),
    ...(resolveApproval === undefined ? {} : { resolveApproval }),
    ...(artifactStorage === undefined ? {} : { artifactStorage }),
    ...(employeePublisher === undefined ? {} : { employeePublisher }),
    getRemoteAddress: () => remoteAddress,
    listNodes,
    ...(logger === undefined ? {} : { logger }),
    ...(nodeIdentity === undefined ? {} : { nodeIdentity }),
    ...(realtime === undefined ? {} : { realtime }),
    requestThrottle,
    ...(runFrames === undefined ? {} : { runFrames }),
    ...(workspaceRealtime === undefined ? {} : { workspaceRealtime }),
    secureCookies,
    store,
    ...(trustedProxyAddress === undefined ? {} : { trustedProxyAddress }),
  });
}

interface CapturedLog {
  event: string;
  message: string;
  fields?: object | undefined;
}

function createCaptureLogger(records: CapturedLog[]): OpenBotLogger {
  const logger: OpenBotLogger = {
    debug: (event, message, fields) => records.push({ event, message, fields }),
    info: (event, message, fields) => records.push({ event, message, fields }),
    warn: (event, message, fields) => records.push({ event, message, fields }),
    error: (event, message, fields) => records.push({ event, message, fields }),
    child: () => logger,
  };
  return logger;
}

function createMemoryNodeIdentityStore(): NodeIdentityStore {
  const enrollments = new Map<
    string,
    { nodeId: string; tokenDigest: string; expiresAt: Date; consumedAt?: Date }
  >();
  const credentials = new Map<
    string,
    { digest: string; enrolledAt: Date; lastAuthenticatedAt?: Date; revokedAt?: Date }
  >();
  return {
    async replaceEnrollmentToken(record) {
      for (const enrollment of enrollments.values()) {
        if (enrollment.nodeId === record.nodeId && enrollment.consumedAt === undefined) {
          enrollment.consumedAt = record.createdAt;
        }
      }
      enrollments.set(record.tokenDigest, { ...record });
    },
    async exchangeEnrollmentToken(record) {
      const enrollment = enrollments.get(record.tokenDigest);
      if (
        enrollment === undefined ||
        enrollment.nodeId !== record.nodeId ||
        enrollment.consumedAt !== undefined ||
        enrollment.expiresAt <= record.enrolledAt
      ) {
        return false;
      }
      enrollment.consumedAt = record.enrolledAt;
      credentials.set(record.nodeId, {
        digest: record.credentialDigest,
        enrolledAt: record.enrolledAt,
      });
      return true;
    },
    async authenticateCredential(nodeId, credentialDigest, now) {
      const credential = credentials.get(nodeId);
      if (credential?.revokedAt !== undefined || credential?.digest !== credentialDigest) {
        return false;
      }
      credential.lastAuthenticatedAt = now;
      return true;
    },
    async revokeCredential(nodeId, now) {
      const credential = credentials.get(nodeId);
      if (credential === undefined || credential.revokedAt !== undefined) return false;
      credential.revokedAt = now;
      return true;
    },
    async listCredentials() {
      return Array.from(credentials, ([nodeId, credential]) => ({
        nodeId,
        enrolledAt: credential.enrolledAt,
        lastAuthenticatedAt: credential.lastAuthenticatedAt ?? null,
        revokedAt: credential.revokedAt ?? null,
      }));
    },
  };
}

function employeeExportDownloadUrl(botId: string, preview: EmployeeExportPreview): string {
  const parameters = new URLSearchParams({
    packageId: preview.packageId,
    generatedAt: preview.generatedAt,
  });
  return `/api/v1/bots/${encodeURIComponent(botId)}/export?${parameters.toString()}`;
}

async function reviewAndDownloadEmployee(
  app: ReturnType<typeof createApp>,
  botId: string,
  cookie: string,
): Promise<{ preview: EmployeeExportPreview; response: Response }> {
  const previewResponse = await app.request(`/api/v1/bots/${botId}/export/preview`, {
    headers: { Cookie: cookie },
  });
  expect(previewResponse.status).toBe(200);
  const { preview } = (await previewResponse.json()) as { preview: EmployeeExportPreview };
  const response = await app.request(employeeExportDownloadUrl(botId, preview), {
    headers: {
      Cookie: cookie,
      "If-Match": `"${preview.downloadReviewToken}"`,
    },
  });
  expect(response.status).toBe(200);
  return { preview, response };
}

async function login(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: testOrigin },
    body: JSON.stringify({ password: "correct-owner-password" }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).not.toContain("Secure");
  if (setCookie === null) throw new Error("Login did not set an owner session cookie.");
  return setCookie.split(";", 1)[0] ?? "";
}

function authenticatedHeaders(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: testOrigin,
  };
}

function createObservedLoginApp(password = "correct-owner-password") {
  const auth = new OwnerAuthService(
    createMemorySessionStore(),
    { ownerName: "Test Owner", ownerPassword: password, sessionTtlMs: 60_000 },
    new RequestThrottle(createMemoryThrottleStore()),
  );
  return {
    app: createTestApp({ auth, store: createTestStore() }),
    loginAttempt: vi.spyOn(auth, "login"),
  };
}

function streamedRequest(
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body,
    duplex: "half",
  };
  return new Request(`http://localhost${path}`, init);
}

function requestBodyChunks(count: number, chunkBytes: number) {
  let offered = 0;
  const cancel = vi.fn<() => void | Promise<void>>();
  const pulls = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offered++ === count) controller.close();
    else controller.enqueue(new Uint8Array(chunkBytes).fill(32));
  });
  return {
    body: new ReadableStream<Uint8Array>({ pull: pulls, cancel }, { highWaterMark: 0 }),
    pulls,
    cancel,
  };
}

function createMemorySessionStore(): OwnerSessionStore {
  const sessions: Array<StoredOwnerSession & { revokedAt?: Date }> = [];
  return {
    async createSession(input: CreateOwnerSessionInput) {
      const session = { ...input };
      sessions.push(session);
      return session;
    },
    async findActiveSession(tokenDigest: string, now: Date) {
      return sessions.find(
        (session) =>
          session.tokenDigest === tokenDigest &&
          session.revokedAt === undefined &&
          session.expiresAt > now,
      );
    },
    async revokeSession(tokenDigest: string, now: Date) {
      const session = sessions.find((item) => item.tokenDigest === tokenDigest);
      if (session !== undefined) session.revokedAt = now;
    },
  };
}

function createMemoryThrottleStore(): RequestThrottleStore {
  const buckets = new Map<
    string,
    { attemptCount: number; windowStartedAt: Date; blockedUntil?: Date }
  >();
  return {
    async reserveAttempt(input) {
      const key = `${input.scope}:${input.clientDigest}`;
      const current = buckets.get(key);
      if (current?.blockedUntil !== undefined && current.blockedUntil > input.now) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(
            (current.blockedUntil.getTime() - input.now.getTime()) / 1000,
          ),
        };
      }
      const expired =
        current === undefined ||
        input.now.getTime() - current.windowStartedAt.getTime() >= input.windowMs;
      const attemptCount = expired ? 1 : current.attemptCount + 1;
      buckets.set(key, {
        attemptCount,
        windowStartedAt: expired ? input.now : current.windowStartedAt,
        ...(attemptCount >= input.maximumAttempts
          ? { blockedUntil: new Date(input.now.getTime() + input.blockMs) }
          : {}),
      });
      return { allowed: true };
    },
    async clearAttempts(scope, clientDigest) {
      buckets.delete(`${scope}:${clientDigest}`);
    },
  };
}

function createTestStore(): ControlPlaneStore {
  const bots: Bot[] = [];
  const channels: Channel[] = [];
  const messages: Message[] = [];
  const runs: Run[] = [];
  const approvals: Approval[] = [];
  const evolution: EmployeeEvolutionEvent[] = [];
  const skillAssignments: EmployeeSkill[] = [];
  const skillOwners = new Map<string, string>();
  const memories: EmployeeMemory[] = [];
  const memoryEvents: EmployeeMemoryEvent[] = [];
  const profileDetails = new Map<
    string,
    { description: string; revision: number; updatedAt: string }
  >();
  const progress: RunProgress[] = [];
  const importReceipts = new Map<
    string,
    { fingerprint: string; result: EmployeeImportActivationResult }
  >();
  const activatedPackageIds = new Set<string>();
  let nextId = 0;
  const id = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;

  return {
    async readWorkspaceSnapshot() {
      return structuredClone({
        channels,
        bots,
        runs,
        approvals,
        artifacts: [],
        progress,
        counts: {
          channels: channels.length,
          bots: bots.length,
          activeRuns: runs.filter((run) =>
            ["queued", "assigned", "running", "waiting_approval", "blocked"].includes(run.status),
          ).length,
        },
      });
    },
    async channelExists(channelId: string) {
      return channels.some((channel) => channel.id === channelId);
    },
    async listBots() {
      return bots;
    },
    async getEmployeeProfile(botId: string): Promise<EmployeeProfile> {
      const bot = bots.find((item) => item.id === botId);
      if (bot === undefined) throw new StoreNotFoundError("Bot not found.");
      const employeeRuns = runs.filter((run) => run.botId === botId);
      const details = profileDetails.get(botId);
      if (details === undefined) throw new Error("Employee profile details were not initialized.");
      return {
        employee: bot,
        details,
        evolution: evolution.filter((event) => event.botId === botId),
        skills: skillAssignments.filter((skill) => skillOwners.get(skill.id) === botId),
        memories: memories.filter((memory) => memory.botId === botId),
        memoryEvents: memoryEvents.filter((event) => event.botId === botId).toReversed(),
        records: {
          runs: employeeRuns,
          approvals: approvals.filter((approval) => approval.botId === botId),
          artifacts: [],
          decisions: progress
            .filter((item) => employeeRuns.some((run) => run.id === item.runId))
            .map((item) => ({ ...item, summary: item.message })),
        },
        statistics: {
          totalRuns: employeeRuns.length,
          completedRuns: employeeRuns.filter((run) => run.status === "completed").length,
          failedRuns: employeeRuns.filter((run) => run.status === "failed").length,
          verifiedSkills: skillAssignments.filter(
            (skill) => skillOwners.get(skill.id) === botId && skill.state === "verified",
          ).length,
        },
        configuration: {
          executionProfile: bot.computerProfile,
          portabilityFormat: "openbot.employee/v1",
        },
      };
    },
    async listChannels() {
      return channels;
    },
    async listMessages(channelId: string) {
      if (!channels.some((channel) => channel.id === channelId)) {
        throw new StoreNotFoundError("Channel not found.");
      }
      return messages.filter((message) => message.channelId === channelId);
    },
    async listRuns(channelId?: string) {
      if (channelId !== undefined && !channels.some((channel) => channel.id === channelId)) {
        throw new StoreNotFoundError("Channel not found.");
      }
      return channelId === undefined ? runs : runs.filter((run) => run.channelId === channelId);
    },
    async listApprovals() {
      return approvals;
    },
    async listRunProgress(channelId?: string) {
      return channelId === undefined
        ? progress
        : progress.filter((item) => item.channelId === channelId);
    },
    async listDispatchableRuns(limit = 50) {
      return runs
        .filter(
          (run) =>
            run.status === "queued" && run.nodeId === undefined && run.executionProfile !== "none",
        )
        .slice(0, limit);
    },
    async getRunningRunForNode(runId: string, nodeId: string) {
      return runs.find(
        (run) => run.id === runId && run.nodeId === nodeId && run.status === "running",
      );
    },
    async getCounts() {
      return { bots: bots.length, channels: channels.length, activeRuns: runs.length };
    },
    async createBot(input: CreateBotInput) {
      const bot: Bot = {
        id: id(),
        ...input,
        status: "idle",
        createdAt: new Date().toISOString(),
      };
      bots.push(bot);
      profileDetails.set(bot.id, {
        description: "",
        revision: 1,
        updatedAt: bot.createdAt,
      });
      evolution.push({
        id: id(),
        botId: bot.id,
        type: "created",
        title: "Employee created",
        summary: `${bot.name} was created with the ${bot.role} role.`,
        source: "manual",
        evidence: [],
        createdAt: bot.createdAt,
      });
      return bot;
    },
    async activateEmployeeImport(input) {
      const employeeName = input.employeeName ?? input.document.payload.employee.name;
      const fingerprint = JSON.stringify({
        packageId: input.document.payload.packageId,
        packageDigest: input.packageDigest,
        employeeName,
        signature: input.signature,
      });
      const replay = importReceipts.get(input.idempotencyKey);
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint) {
          throw new StoreConflictError(
            "This idempotency key was already used for a different Employee import.",
          );
        }
        return { ...replay.result, replayed: true };
      }
      if (activatedPackageIds.has(input.document.payload.packageId)) {
        throw new StoreConflictError("This Employee package was already activated.");
      }
      if (bots.some((bot) => bot.name === employeeName)) {
        throw new StoreConflictError("The Employee name already exists.");
      }
      const now = new Date().toISOString();
      const bot: Bot = {
        id: id(),
        name: employeeName,
        role: input.document.payload.employee.role,
        status: "idle",
        computerProfile: input.document.payload.configuration.recommendedExecutionProfile,
        ...(input.document.payload.employee.appearance === undefined
          ? {}
          : { appearance: input.document.payload.employee.appearance }),
        createdAt: now,
      };
      bots.push(bot);
      profileDetails.set(bot.id, {
        description: input.document.payload.employee.description ?? "",
        revision: 1,
        updatedAt: now,
      });
      const importedSkills = new Map<string, EmployeeSkill>();
      for (const portableSkill of input.document.payload.skills) {
        const skill: EmployeeSkill = {
          id: id(),
          slug: portableSkill.slug,
          name: portableSkill.name,
          description: portableSkill.description,
          version: portableSkill.version,
          source: "imported",
          state: "candidate",
          confidence: 0,
          requiredCapabilities: portableSkill.requiredCapabilities,
          dependencyIds: [],
          evidence: [{ kind: "import", id: input.document.payload.packageId }],
          acquiredAt: now,
          updatedAt: now,
        };
        importedSkills.set(skill.slug, skill);
        skillAssignments.push(skill);
        skillOwners.set(skill.id, bot.id);
      }
      for (const portableSkill of input.document.payload.skills) {
        const skill = importedSkills.get(portableSkill.slug);
        if (skill === undefined) throw new Error("Imported skill was not resolved.");
        skill.dependencyIds = portableSkill.dependencySlugs.map((slug) => {
          const dependency = importedSkills.get(slug);
          if (dependency === undefined) throw new Error("Imported dependency was not resolved.");
          return dependency.id;
        });
      }
      evolution.push({
        id: id(),
        botId: bot.id,
        type: "imported",
        title: "Employee imported",
        summary: `${bot.name} was activated from an Owner-reviewed portable package.`,
        source: "import",
        sourceId: input.document.payload.packageId,
        evidence: [{ kind: "import", id: input.document.payload.packageId }],
        createdAt: now,
      });
      const result: EmployeeImportActivationResult = {
        employee: bot,
        receipt: {
          id: id(),
          packageId: input.document.payload.packageId,
          packageDigest: input.packageDigest,
          employeeId: bot.id,
          signatureStatus: input.signature.status,
          ...(input.signature.status === "dsse"
            ? { publisherKeyId: input.signature.trustedPublisherKeyId }
            : {}),
          reviewedBy: "owner",
          reviewedAt: input.reviewedAt,
          importedSkillCount: input.document.payload.skills.length,
          createdAt: now,
        },
        replayed: false,
      };
      activatedPackageIds.add(input.document.payload.packageId);
      importReceipts.set(input.idempotencyKey, { fingerprint, result });
      return result;
    },
    async createEmployeeSkill(botId: string, input: CreateEmployeeSkillInput) {
      if (!bots.some((bot) => bot.id === botId)) {
        throw new StoreNotFoundError("Bot not found.");
      }
      const duplicate = skillAssignments.find(
        (skill) =>
          skillOwners.get(skill.id) === botId &&
          skill.slug === input.slug &&
          skill.version === input.version,
      );
      if (duplicate !== undefined) {
        throw new StoreConflictError("This skill is already assigned to the employee.");
      }
      const dependencies = input.dependencySkillIds.map((dependencyId) =>
        skillAssignments.find(
          (skill) => skill.id === dependencyId && skillOwners.get(skill.id) === botId,
        ),
      );
      if (dependencies.some((dependency) => dependency === undefined)) {
        throw new StoreValidationError(
          "Every dependency must already be assigned to this employee.",
        );
      }
      if (dependencies.some((dependency) => dependency?.state !== "verified")) {
        throw new StoreValidationError(
          "Every dependency must be verified before this candidate can be added.",
        );
      }
      const now = new Date().toISOString();
      const skill: EmployeeSkill = {
        id: id(),
        slug: input.slug,
        name: input.name,
        description: input.description,
        version: input.version,
        source: input.source,
        state: "candidate",
        confidence: 0,
        requiredCapabilities: input.requiredCapabilities,
        dependencyIds: input.dependencySkillIds,
        evidence: input.evidence,
        acquiredAt: now,
        updatedAt: now,
      };
      const event: EmployeeEvolutionEvent = {
        id: id(),
        botId,
        type: "skill_discovered",
        title: "Candidate skill added",
        summary: input.reason,
        source: input.source === "imported" ? "import" : "manual",
        sourceId: skill.id,
        evidence: input.evidence,
        createdAt: now,
      };
      skillAssignments.push(skill);
      skillOwners.set(skill.id, botId);
      evolution.push(event);
      return { skill, evolution: event };
    },
    async updateEmployeeProfileDetails(botId, input) {
      const bot = bots.find((candidate) => candidate.id === botId);
      const details = profileDetails.get(botId);
      if (bot === undefined || details === undefined) {
        throw new StoreNotFoundError("Bot not found.");
      }
      if (details.revision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The Employee profile changed while it was being edited. Reload and review the current values.",
        );
      }
      const role = input.role.trim();
      const description = input.description.trim();
      const changedFields: Array<"role" | "description"> = [];
      if (role !== bot.role) changedFields.push("role");
      if (description !== details.description) changedFields.push("description");
      if (changedFields.length === 0) {
        throw new StoreValidationError("At least one Employee profile field must change.");
      }
      bot.role = role;
      details.description = description;
      details.revision += 1;
      details.updatedAt = new Date().toISOString();
      const event: EmployeeEvolutionEvent = {
        id: id(),
        botId,
        type: changedFields.includes("role") ? "role_changed" : "configuration_changed",
        title: changedFields.includes("role") ? "Employee role updated" : "Profile updated",
        summary: `Owner updated: ${changedFields.join(", ")}.`,
        source: "manual",
        evidence: [],
        createdAt: details.updatedAt,
      };
      evolution.push(event);
      return { employee: bot, details: { ...details }, evolution: event };
    },
    async updateEmployeeSkillState(botId, skillId, input) {
      if (!bots.some((bot) => bot.id === botId)) {
        throw new StoreNotFoundError("Bot not found.");
      }
      const skill = skillAssignments.find(
        (candidate) => candidate.id === skillId && skillOwners.get(candidate.id) === botId,
      );
      if (skill === undefined) throw new StoreNotFoundError("Employee skill not found.");
      const transitionAllowed =
        skill.state !== "revoked" &&
        skill.state !== input.state &&
        (skill.state === "candidate" ||
          (skill.state === "verified" && ["suspended", "revoked"].includes(input.state)) ||
          (skill.state === "suspended" && ["verified", "revoked"].includes(input.state)));
      if (!transitionAllowed) {
        throw new StoreConflictError(`A ${skill.state} skill cannot transition to ${input.state}.`);
      }
      if (input.state === "verified") {
        const dependencies = skill.dependencyIds.map((dependencyId) =>
          skillAssignments.find(
            (candidate) => candidate.id === dependencyId && skillOwners.get(candidate.id) === botId,
          ),
        );
        if (dependencies.some((dependency) => dependency?.state !== "verified")) {
          throw new StoreValidationError(
            "Every dependency must be verified before this skill can be verified.",
          );
        }
        skill.confidence = input.confidence;
      }
      skill.state = input.state;
      skill.evidence = [...skill.evidence, ...input.evidence].filter(
        (reference, index, references) =>
          references.findIndex(
            (candidate) => candidate.kind === reference.kind && candidate.id === reference.id,
          ) === index,
      );
      skill.updatedAt = new Date().toISOString();
      const event: EmployeeEvolutionEvent = {
        id: id(),
        botId,
        type: `skill_${input.state}`,
        title:
          input.state === "verified"
            ? "Skill verified"
            : input.state === "suspended"
              ? "Skill suspended"
              : "Skill revoked",
        summary: input.reason,
        source: "manual",
        sourceId: skill.id,
        evidence: input.evidence,
        createdAt: skill.updatedAt,
      };
      evolution.push(event);
      return { skill, evolution: event };
    },
    async createEmployeeMemory(botId, input) {
      if (!bots.some((bot) => bot.id === botId)) {
        throw new StoreNotFoundError("Bot not found.");
      }
      const now = new Date().toISOString();
      const memory: EmployeeMemory = {
        id: id(),
        botId,
        ...input,
        provenance: { source: "owner", actor: "owner" },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const event: EmployeeMemoryEvent = {
        id: id(),
        botId,
        memoryId: memory.id,
        action: "created",
        revision: 1,
        changedFields: ["kind", "title", "content", "sensitivity", "portability"],
        actor: "owner",
        createdAt: now,
      };
      memories.push(memory);
      memoryEvents.push(event);
      return { memory, event };
    },
    async updateEmployeeMemory(botId, memoryId, input) {
      const memory = memories.find(
        (candidate) => candidate.botId === botId && candidate.id === memoryId,
      );
      if (memory === undefined) throw new StoreNotFoundError("Employee memory not found.");
      if (memory.revision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The memory changed while it was being edited. Reload and review the current value.",
        );
      }
      const changedFields: EmployeeMemoryEvent["changedFields"] = [];
      for (const field of ["kind", "title", "content", "sensitivity", "portability"] as const) {
        const value = input[field];
        if (value !== undefined && value !== memory[field]) {
          changedFields.push(field);
          (memory as Record<typeof field, unknown>)[field] = value;
        }
      }
      if (changedFields.length === 0) {
        throw new StoreValidationError("At least one memory field must change.");
      }
      memory.revision += 1;
      memory.updatedAt = new Date().toISOString();
      const event: EmployeeMemoryEvent = {
        id: id(),
        botId,
        memoryId,
        action: "updated",
        revision: memory.revision,
        changedFields,
        actor: "owner",
        createdAt: memory.updatedAt,
      };
      memoryEvents.push(event);
      return { memory, event };
    },
    async deleteEmployeeMemory(botId, memoryId, input) {
      const index = memories.findIndex(
        (candidate) => candidate.botId === botId && candidate.id === memoryId,
      );
      const memory = memories[index];
      if (memory === undefined) throw new StoreNotFoundError("Employee memory not found.");
      if (memory.revision !== input.expectedRevision) {
        throw new StoreConflictError(
          "The memory changed before deletion. Reload and review the current value.",
        );
      }
      memories.splice(index, 1);
      const event: EmployeeMemoryEvent = {
        id: id(),
        botId,
        memoryId,
        action: "deleted",
        revision: memory.revision + 1,
        changedFields: [],
        actor: "owner",
        createdAt: new Date().toISOString(),
      };
      memoryEvents.push(event);
      return { memoryId, event };
    },
    async createChannel(input: CreateChannelInput) {
      const channel: Channel = {
        id: id(),
        ...input,
        createdAt: new Date().toISOString(),
      };
      channels.push(channel);
      return channel;
    },
    async getOrCreateDirectConversation(botId: string) {
      const bot = bots.find((item) => item.id === botId);
      if (bot === undefined) throw new StoreNotFoundError("Bot not found.");
      const existing = channels.find((item) => item.directBotId === botId);
      if (existing !== undefined) return existing;
      const channel: Channel = {
        id: id(),
        name: bot.name,
        description: "",
        directBotId: botId,
        botIds: [botId],
        createdAt: new Date().toISOString(),
      };
      channels.push(channel);
      return channel;
    },
    async submitTask(channelId: string, input: CreateMessageInput) {
      const channel = channels.find((item) => item.id === channelId);
      if (channel === undefined) {
        throw new StoreNotFoundError("Channel not found.");
      }
      const candidates = channel.botIds
        .map((botId) => bots.find((bot) => bot.id === botId))
        .filter((bot): bot is Bot => bot !== undefined);
      const assignees = selectChannelAssignees(candidates, input, channel.directBotId);
      if (
        input.replyToMessageId !== undefined &&
        !messages.some(
          (message) => message.id === input.replyToMessageId && message.channelId === channelId,
        )
      )
        throw new StoreValidationError("The replied message does not belong to this channel.");
      const runId = id();
      const message: Message = {
        id: id(),
        channelId,
        authorType: "human",
        runId,
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: input.replyToMessageId }),
        content: input.content,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      const createdRuns: Run[] = assignees.map((assignee, index) => ({
        id: index === 0 ? runId : id(),
        channelId,
        botId: assignee.id,
        sourceMessageId: message.id,
        executionProfile: assignee.computerProfile,
        instruction: input.content,
        title: input.content,
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      runs.push(...createdRuns);
      const run = createdRuns[0];
      if (!run) throw new StoreValidationError("A task requires a Bot recipient.");
      return { message, run, ...(input.botIds === undefined ? {} : { runs: createdRuns }) };
    },
    async assignRun(runId: string, nodeId: string) {
      const run = runs.find((item) => item.id === runId);
      if (run === undefined || run.status !== "queued" || run.nodeId !== undefined) {
        return undefined;
      }
      run.nodeId = nodeId;
      run.status = "assigned";
      run.updatedAt = new Date().toISOString();
      return run;
    },
    async startRun(runId: string, nodeId: string) {
      const run = runs.find((item) => item.id === runId);
      if (run === undefined || run.status !== "assigned" || run.nodeId !== nodeId) return undefined;
      run.status = "running";
      run.updatedAt = new Date().toISOString();
      return run;
    },
    async requestApproval(runId, nodeId, input) {
      const run = runs.find(
        (item) => item.id === runId && item.nodeId === nodeId && item.status === "running",
      );
      if (run === undefined) return undefined;
      run.status = "waiting_approval";
      run.updatedAt = new Date().toISOString();
      const approval: Approval = {
        id: input.requestId,
        runId,
        channelId: run.channelId,
        botId: run.botId,
        nodeId,
        action: input.action,
        target: input.target,
        summary: input.summary,
        risk: input.risk,
        targetFingerprint: "0".repeat(64),
        beforeState: input.beforeState,
        status: "pending",
        expiresAt: input.expiresAt,
        createdAt: new Date().toISOString(),
      };
      approvals.push(approval);
      return { approval, run };
    },
    async decideApproval(approvalId, decision, decidedBy) {
      const approval = approvals.find((item) => item.id === approvalId);
      if (approval === undefined) throw new StoreNotFoundError("Approval not found.");
      if (approval.status !== "pending") {
        throw new StoreConflictError("Approval has already been resolved.");
      }
      const run = runs.find((item) => item.id === approval.runId);
      if (run === undefined || run.status !== "waiting_approval") {
        throw new StoreConflictError("The run is no longer waiting for this approval.");
      }
      approval.status = decision === "approve" ? "approved" : "rejected";
      approval.decidedBy = decidedBy;
      approval.decidedAt = new Date().toISOString();
      run.status = decision === "approve" ? "running" : "blocked";
      run.updatedAt = approval.decidedAt;
      return { approval, run };
    },
    async appendRunProgress(runId: string, nodeId: string, stage: string, message: string) {
      const run = runs.find(
        (item) => item.id === runId && item.nodeId === nodeId && item.status === "running",
      );
      if (run === undefined) return undefined;
      const entry: RunProgress = {
        id: id(),
        runId,
        channelId: run.channelId,
        nodeId,
        stage,
        message,
        createdAt: new Date().toISOString(),
      };
      progress.push(entry);
      return entry;
    },
    async completeRun(runId: string, nodeId: string, summary: string) {
      const run = runs.find((item) => item.id === runId);
      if (run === undefined || run.status !== "running" || run.nodeId !== nodeId) return undefined;
      run.status = "completed";
      run.resultSummary = summary;
      run.updatedAt = new Date().toISOString();
      const message: Message = {
        id: id(),
        channelId: run.channelId,
        authorType: "bot",
        authorId: run.botId,
        runId: run.id,
        ...(run.sourceMessageId === undefined ? {} : { replyToMessageId: run.sourceMessageId }),
        content: summary,
        createdAt: new Date().toISOString(),
      };
      messages.push(message);
      return { run, artifacts: [], message };
    },
    async failRun(runId: string, nodeId: string, error: string) {
      const run = runs.find((item) => item.id === runId);
      if (run === undefined || run.status !== "running" || run.nodeId !== nodeId) return undefined;
      run.status = "failed";
      run.errorMessage = error;
      run.updatedAt = new Date().toISOString();
      return run;
    },
    async failRunningRuns(nodeId?: string) {
      const failed = runs.filter(
        (run) => run.status === "running" && (nodeId === undefined || run.nodeId === nodeId),
      );
      for (const run of failed) {
        run.status = "failed";
        run.errorMessage = "Execution interrupted.";
      }
      return failed;
    },
    async requeueAssignedRuns(nodeId?: string) {
      const requeued = runs.filter(
        (run) => run.status === "assigned" && (nodeId === undefined || run.nodeId === nodeId),
      );
      for (const run of requeued) {
        delete run.nodeId;
        run.status = "queued";
        run.updatedAt = new Date().toISOString();
      }
      return requeued;
    },
    async listArtifacts() {
      return [];
    },
    async getArtifact() {
      return undefined;
    },
    async upsertNode() {},
    async markNodeOffline() {},
    async joinBotToChannel(channelId: string, botId: string) {
      const channel = channels.find((item) => item.id === channelId);
      if (channel === undefined) {
        throw new Error("Channel not found.");
      }
      if (channel.directBotId !== undefined) {
        throw new StoreValidationError("Direct conversation membership cannot be changed.");
      }
      if (!channel.botIds.includes(botId)) {
        channel.botIds.push(botId);
      }
      return channel;
    },
  };
}
