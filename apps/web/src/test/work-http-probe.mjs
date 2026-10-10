/** Owned S2 HTTP/SQL fixture. Worker startup is stubbed exactly as in the old API-only fixture. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDatabase } from "@openbot/db";
import { createEntry } from "../../../server/dist/app.js";
import { WorkService } from "../../../server/dist/work-service.js";
import { allowlistedEnvironment, OwnedDockerFixture, startControlPostgres } from "../../../../scripts/acceptance-fixture.ts";

export async function runWorkHttpProbe(serve = false) {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  assert((await stat(join(root, "apps/web/dist/index.html"))).isFile(), "Build @openbot/web first");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-s2-")));
  const docker = new OwnedDockerFixture(root, allowlistedEnvironment(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]));
  let database                                               , app                                                     ;
  // This test deliberately qualifies HTTP persistence without starting a Workflow or model.
  // Full execution, process death and replay are separately covered by test:work:ts.
  const start = mock.method(WorkService.prototype, "start", async function(                 ) { this.files.verify(); });
  try {
    const dsn = await startControlPostgres(docker, "openbot-s2-" + randomUUID(), randomBytes(24).toString("hex"));
    database = createDatabase(dsn); await database.migrate();
    const port = await new Promise        ((resolve, reject) => {
      const socket = createServer(); socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => { const address = socket.address(); socket.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("Fixture port unavailable"))); });
    });
    const origin = `http://127.0.0.1:${port}`, password = randomBytes(24).toString("hex");
    const fileRoot = join(directory, "files"); await mkdir(fileRoot, { mode: 0o700 });
    app = await createEntry({ publicOrigin: origin, host: "127.0.0.1", port, webRoot: join(root, "apps/web/dist"),
      ownerAuth: { databaseUrl: dsn, password, ownerName: "S2 Test Owner", ttlHours: 1 },
      product: { databaseUrl: dsn, controlReads: true,
        models: { keyPath: join(directory, "model-key"), customBaseUrls: [] },
        modelTransport: async () => { throw new Error("S2 fixture forbids model transport"); },
        work: { address: "127.0.0.1:1", namespace: "synthetic", taskQueue: "openbot-work-ts-v1-s2", executionTimeoutMs: 60000, fileRoot,
          tls: { ca: join(directory, "unused-ca"), certificate: join(directory, "unused-crt"), key: join(directory, "unused-key"), serverName: "synthetic.internal" } },
      },
    });
    await app.listen({ host: "127.0.0.1", port });
    let cookie = "";
    const request = async (path        , body          , options                                                 = {}) => {
      const result = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
        headers: { Origin: options.trusted === false ? "https://untrusted.example" : origin,
          ...(options.authenticated === false ? {} : { Cookie: cookie }), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), redirect: "error" });
      if (path === "/api/v1/auth/login") cookie = result.headers.get("set-cookie")?.split(";")[0] ?? "";
      return { status: result.status, body: result.status === 204 ? null : await result.json() };
    };
    assert.equal((await request("/api/v1/tasks/absent", undefined, { authenticated: false })).status, 401);
    assert.equal((await request("/api/v1/auth/login", { password })).status, 200);
    const bot = await request("/api/v1/bots", { name: "S2 Reviewer", role: "Synthetic test", computerProfile: "none" });
    assert.equal(bot.status, 201);
    const input = { botId: bot.body.bot.id, objective: "S2 real HTTP acceptance", tokenLimit: 1000, requestKey: "s2-exact-retry" };
    assert.equal((await request("/api/v1/tasks", input, { trusted: false })).status, 403);
    assert.equal((await request("/api/v1/tasks", { ...input, authorityActive: true })).status, 422);
    const oversized = { ...input, objective: "中".repeat(7000), requestKey: "s2-oversized" };
    assert(oversized.objective.length < 16384 && Buffer.byteLength(JSON.stringify(oversized)) > 20000);
    assert.equal((await request("/api/v1/tasks", oversized)).status, 413);
    assert.equal(Number((await database.client`SELECT count(*) AS count FROM work_tasks WHERE request_key=${oversized.requestKey}`)[0] .count), 0);
    const task = await request("/api/v1/tasks", input);
    assert.equal(task.status, 202); assert.equal(task.body.status, "queued"); assert.equal(task.body.revision, 1);
    assert.deepEqual(await request("/api/v1/tasks", input), task);
    assert.equal((await request("/api/v1/tasks", { ...input, objective: "different" })).status, 409);
    const path = "/api/v1/tasks/" + task.body.id;
    assert.equal((await request(path, undefined, { authenticated: false })).status, 401);
    assert.equal((await request(path + "/cancel", {}, { trusted: false })).status, 403);
    assert.equal((await request(path)).body.status, "queued");
    assert.equal((await request(path + "/cancel", {})).status, 200);
    const closed = await request(path);
    assert.equal(closed.status, 200); assert.equal(closed.body.cancelRequested, true);
    assert.equal(closed.body.status, "cancelled"); assert.equal(closed.body.authorityActive, false);
    assert.deepEqual((await request(path + "/cancel", {})).body, closed.body);
    const schema = (await request("/openapi.json")).body;
    assert.equal(schema.paths["/api/v1/tasks"].post.operationId, "createWorkTask");
    assert.deepEqual(schema.paths["/api/v1/tasks/{task_id}"].get.security, [{ OwnerSession: [] }]);
    assert.equal((await request("/api/v1/auth/logout", {})).status, 204);
    assert.equal((await request(path)).status, 401);
    console.log("PASS: real HTTP/PG login, Bot, create/read/cancel, exact retry, 401/403/409/413/422, OpenAPI, logout (Worker intentionally absent)");
    if (serve) {
      console.log(`Browser: ${origin}/#/tasks\nDisposable Owner password: ${password}\nCtrl+C removes this synthetic fixture.`);
      await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    }
  } finally {
    try { await app?.close(); await database?.close(); }
    finally { start.mock.restore(); docker.cleanup(); await rm(directory, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--serve"));
  await runWorkHttpProbe(process.argv[2] === "--serve");
}
