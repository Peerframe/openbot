/** Exercises direct HTTP ingress, asset containment, admission and stream lifecycle. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, it } from "vitest";
import { createEntry, serverOperations } from "./app.js";
import { safeRequestTarget } from "./config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(setup?: (app: FastifyInstance) => unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-http-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<html>entry</html>");
  await writeFile(join(webRoot, "binary.dat"), Buffer.from([0, 255, 13, 10]));
  await writeFile(join(webRoot, ".private"), "private");
  await writeFile(join(root, "outside.txt"), "outside");
  if (process.platform !== "win32") await symlink(join(root, "outside.txt"), join(webRoot, "alias.txt"));
  const app = await createEntry({ webRoot, publicOrigin: "http://entry.test", host: "127.0.0.1", port: 1 });
  cleanups.push(() => app.close());
  setup?.(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  return { app, port: address.port };
}
async function call(port: number, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: Buffer | string;
} = {}) {
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path,
      method: options.method ?? "GET", headers: { Host: "entry.test", ...options.headers }, agent: false,
    }, resolve);
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return { status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) };
}
describe("direct Server entry", () => {
  it("uses the complete shared operation inventory", () => {
    assert.equal(serverOperations.length, 121);
    assert.equal(new Set(serverOperations.map((v) => `${v.method}:${v.path}`)).size, 121);
  });
  it("serves the actual OpenAPI document with Work operation and Owner security metadata", async () => {
    const { port } = await fixture();
    const response = await call(port, "/openapi.json");
    assert.equal(response.status, 200);
    const schema = JSON.parse(response.body.toString());
    assert.equal(schema.paths["/api/v1/tasks"].post.operationId, "createWorkTask");
    assert.deepEqual(schema.paths["/api/v1/tasks/{task_id}"].get.security, [{ OwnerSession: [] }]);
  });
  it("serves exact assets and HEAD, without exposing hidden files, links or an API fallback", async () => {
    const { port } = await fixture();
    const home = await call(port, "/?query=ignored");
    assert.equal(home.status, 200);
    assert.equal(home.body.toString(), "<html>entry</html>");
    assert.equal(home.headers["cache-control"], "no-store");
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.equal(home.headers["x-frame-options"], "DENY");
    const head = await call(port, "/binary.dat", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "4");
    assert.equal(head.body.length, 0);
    assert.deepEqual((await call(port, "/binary.dat")).body, Buffer.from([0, 255, 13, 10]));
    for (const path of ["/missing", "/api/missing", "/ws/nodes", "/.private", "/%2eprivate", "/_openbot/p4/snapshot", "/%5Fopenbot/p4%2Fsnapshot"])
      assert.equal((await call(port, path)).status, 404, path);
    assert.equal((await call(port, "/", { method: "POST", body: "ignored" })).status, 404);
    if (process.platform !== "win32") assert.equal((await call(port, "/alias.txt")).status, 404);
  });
  it.each(["Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "X-OpenBot-Owner", "X-OpenBot-Identity"])("refuses caller metadata %s before dispatch", async (header) => {
    const { port } = await fixture();
    assert.equal((await call(port, "/", { headers: { [header]: "spoof" } })).status, 400);
  });
  it("rejects wrong Host, absolute/network targets, traversal, escapes and controls", async () => {
    const { port } = await fixture();
    for (const path of ["http://external.invalid/", "//external.invalid/", "/x/../", "/x/%2e%2e/", "/x/%00", "/x/%zz"])
      assert.equal((await call(port, path)).status, 400, path);
    assert.equal((await call(port, "/", { headers: { Host: "wrong.test" } })).status, 400);
    assert.equal(safeRequestTarget("/health?spelling=%2f+%20"), true);
  });
  it("bounds CORS preflight to the trusted Origin, existing route, method and headers", async () => {
    const { port } = await fixture();
    const headers = { Origin: "http://entry.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Content-Type, If-Match" };
    const allowed = await call(port, "/health", { method: "OPTIONS", headers });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "http://entry.test");
    assert.equal(allowed.headers["access-control-allow-credentials"], "true");
    for (const override of [{ Origin: "https://foreign.invalid" }, { "Access-Control-Request-Method": "TRACE" }, { "Access-Control-Request-Headers": "X-OpenBot-Owner" }])
      assert.equal((await call(port, "/health", { method: "OPTIONS", headers: { ...headers, ...override } })).status, 400);
    assert.equal((await call(port, "/api/missing", { method: "OPTIONS", headers })).status, 400);
  });
  it("closes an unconfigured Worker upgrade without a tunnel or listener leak", async () => {
    const { port } = await fixture();
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("GET /ws/nodes HTTP/1.1\r\nHost: entry.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await once(socket, "close", { signal: AbortSignal.timeout(1500) });
    assert.equal((await call(port, "/")).status, 200);
  });
  it("caps pending HTTP admissions and releases capacity after abort", async () => {
    let admitted = 0;
    const { port } = await fixture((app) => app.get("/pending", (_request, reply) => {
      admitted++;
      reply.hijack();
    }));
    const clients = Array.from({ length: 128 }, () => {
      const client = request({ hostname: "127.0.0.1", port, path: "/pending", agent: false, headers: { Host: "entry.test" } });
      client.on("error", () => {});
      client.end();
      return client;
    });
    try {
      for (let attempt = 0; admitted < 128 && attempt < 40; attempt++) await delay(25);
      assert.equal(admitted, 128);
      assert.equal((await call(port, "/")).status, 503);
      assert.equal(admitted, 128);
    } finally {
      for (const client of clients) client.destroy();
    }
    await delay(100);
    assert.equal((await call(port, "/")).status, 200);
  });
  it("streams promptly, applies backpressure and releases an aborted response", async () => {
    let sent = 0, blocked = false, closed!: () => void;
    const released = new Promise<void>((resolve) => { closed = resolve; });
    const { port } = await fixture((app) => app.get("/api/v1/workspace/stream", (_request, reply) => {
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write("event: ready\ndata: {}\n\n");
      const payload = Buffer.alloc(65536, 97);
      const produce = () => {
        while (!response.destroyed && sent < 4096) {
          sent++;
          if (!response.write(payload)) { blocked = true; response.once("drain", produce); return; }
        }
      };
      setImmediate(produce);
      response.once("close", closed);
    }));
    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request({ hostname: "127.0.0.1", port, path: "/api/v1/workspace/stream", headers: { Host: "entry.test" } }, resolve);
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(stream.headers["content-type"], "text/event-stream");
    const [first] = await once(stream, "data");
    assert(Buffer.from(first).toString().startsWith("event: ready\n"));
    stream.pause();
    await delay(150);
    assert(blocked && sent < 4096, "A stalled client must not accumulate the complete 256MiB source.");
    stream.destroy();
    await Promise.race([released, delay(1500).then(() => { throw new Error("Source was not released."); })]);
  });
});
