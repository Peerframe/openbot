import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createEntry, pythonOperations } from "./app.js";
import { entryOptions, peerForwarded, safeRequestTarget, validateOptions } from "./config.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const privateAddress = upstream.address();
  assert(privateAddress && typeof privateAddress !== "string");
  cleanups.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const app = await createEntry({
    upstream: `http://127.0.0.1:${privateAddress.port}`,
    publicOrigin: "http://entry.test",
    host: "127.0.0.1",
    port: 1,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const publicAddress = app.server.address();
  assert(publicAddress && typeof publicAddress !== "string");
  cleanups.push(async () => {
    await app.close();
  });
  return { port: publicAddress.port, upstream, app };
}

async function call(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  } = {},
) {
  const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Host: "entry.test", ...options.headers },
        agent: false,
      },
      resolve,
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return { status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) };
}

describe("fixed private HTTP entry", () => {
  it("uses the complete shared P1 operation inventory", () => {
    assert.equal(pythonOperations.length, 121);
    assert.equal(
      new Set(pythonOperations.map((operation) => `${operation.method}:${operation.path}`)).size,
      121,
    );
  });

  it("keeps invalid JSON, integer tokens, query spelling, authority headers and peer", async () => {
    let observed: { url?: string; headers?: IncomingMessage["headers"]; body?: Buffer } = {};
    const { port } = await fixture(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = { url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      response.writeHead(422, {
        "Content-Type": "application/json",
        "Set-Cookie": ["a=1; HttpOnly", "b=2; Secure"],
      });
      response.end('{"error":"Invalid request input."}');
    });
    const body = '{"revision":1.0,"broken":';
    const result = await call(port, "/api/v1/tasks?x=one+two&x=one%20two&empty=&bare&case=%2f", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        Origin: "http://entry.test",
        Cookie: "openbot_session=secret",
        "If-Match": "revision",
        "X-OpenBot-Filename": "fixture.pdf",
        Connection: "close, x-remove",
        "X-Remove": "drop",
      },
      body,
    });
    assert.equal(observed.url, "/api/v1/tasks?x=one+two&x=one%20two&empty=&bare&case=%2f");
    assert.equal(observed.body?.toString(), body);
    assert.equal(observed.headers?.host, "entry.test");
    assert.equal(observed.headers?.forwarded, "for=127.0.0.1");
    assert.equal(observed.headers?.origin, "http://entry.test");
    assert.equal(observed.headers?.cookie, "openbot_session=secret");
    assert.equal(observed.headers?.["if-match"], "revision");
    assert.equal(observed.headers?.["x-openbot-filename"], "fixture.pdf");
    assert.equal(observed.headers?.["x-remove"], undefined);
    assert.equal(result.status, 422);
    assert.equal(result.body.toString(), '{"error":"Invalid request input."}');
    assert.deepEqual(result.headers["set-cookie"], ["a=1; HttpOnly", "b=2; Secure"]);
  });

  it("passes raw uploads and encoded responses without decompression or redirect following", async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 1]);
    const zipped = gzipSync(bytes);
    let count = 0;
    const { port } = await fixture(async (request, response) => {
      count++;
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === "POST") assert.deepEqual(Buffer.concat(chunks), bytes);
      response.writeHead(request.url === "/redirect" ? 307 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
        "Content-Length": String(zipped.length),
        Location: "http://entry.test/next",
        "X-OpenBot-Next-Before": "cursor",
      });
      response.end(zipped);
    });
    const result = await call(port, "/api/v1/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    assert.deepEqual(result.body, zipped);
    assert.equal(result.headers["content-encoding"], "gzip");
    assert.equal(result.headers["x-openbot-next-before"], "cursor");
    const redirect = await call(port, "/redirect");
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.location, "http://entry.test/next");
    assert.equal(count, 2);
  });

  it.each([
    "Forwarded",
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "X-Real-IP",
    "X-OpenBot-Owner",
    "X-OpenBot-Identity",
  ])("refuses caller metadata %s before dispatch", async (header) => {
    let calls = 0;
    const { port } = await fixture((_request, response) => {
      calls++;
      response.end("unexpected");
    });
    assert.equal((await call(port, "/health", { headers: { [header]: "spoof" } })).status, 400);
    assert.equal(calls, 0);
  });

  it("rejects wrong Host, absolute/network target and dot-segment normalization", async () => {
    let calls = 0;
    const { port } = await fixture((_request, response) => {
      calls++;
      response.end("unexpected");
    });
    for (const path of [
      "http://external.invalid/health",
      "//external.invalid/health",
      "/x/../health",
      "/x/%2e%2e/health",
      "/x/%00",
    ]) {
      assert.equal((await call(port, path)).status, 400);
    }
    assert.equal((await call(port, "/health", { headers: { Host: "wrong.test" } })).status, 400);
    assert.equal(calls, 0);
  });

  it("never retries 503, socket loss or unknown mutation outcomes", async () => {
    const counts = new Map<string, number>();
    const { port } = await fixture((request, response) => {
      const path = request.url ?? "";
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === "/503") {
        response.writeHead(503, { "Retry-After": "0" });
        response.end("unavailable");
      } else request.socket.destroy();
    });
    assert.equal((await call(port, "/503")).status, 503);
    const lost = await call(port, "/lost");
    assert.equal(lost.status, 503);
    assert.equal(lost.body.toString(), '{"error":"Control-plane upstream is unavailable."}');
    assert.equal((await call(port, "/mutation", { method: "POST" })).status, 503);
    await delay(150);
    assert.deepEqual(
      [...counts],
      [
        ["/503", 1],
        ["/lost", 1],
        ["/mutation", 1],
      ],
    );
  });

  it("cancels upstream before headers when the client disconnects", async () => {
    let accepted!: () => void;
    let closed!: () => void;
    const seen = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { port } = await fixture((incoming) => {
      incoming.socket.once("close", closed);
      accepted();
    });
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      path: "/waiting",
      headers: { Host: "entry.test" },
    });
    outgoing.on("error", () => {});
    outgoing.end();
    await seen;
    outgoing.destroy();
    await Promise.race([
      released,
      delay(1500).then(() => {
        throw new Error("Upstream was not canceled.");
      }),
    ]);
  });

  it("caps pending HTTP admissions and releases capacity after abort", async () => {
    let admitted = 0;
    const { port } = await fixture((incoming, response) => {
      if (incoming.url === "/health") {
        response.end("ready");
        return;
      }
      admitted++;
    });
    const clients = Array.from({ length: 128 }, () => {
      const client = request({
        hostname: "127.0.0.1",
        port,
        path: "/pending",
        agent: false,
        headers: { Host: "entry.test" },
      });
      client.on("error", () => {});
      client.end();
      return client;
    });
    try {
      for (let attempt = 0; admitted < 128 && attempt < 40; attempt++) await delay(25);
      assert.equal(admitted, 128);
      assert.equal((await call(port, "/excess")).status, 503);
      assert.equal(admitted, 128);
    } finally {
      for (const client of clients) client.destroy();
    }
    await delay(100);
    assert.equal((await call(port, "/health")).body.toString(), "ready");
  });

  it("streams SSE promptly, applies backpressure and releases the aborted stream", async () => {
    let sent = 0,
      blocked = false,
      closed!: () => void;
    const released = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { port } = await fixture((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write("event: ready\ndata: {}\n\n");
      const payload = Buffer.alloc(65536, 97);
      const produce = () => {
        while (!response.destroyed && sent < 4096) {
          sent++;
          if (!response.write(payload)) {
            blocked = true;
            response.once("drain", produce);
            return;
          }
        }
      };
      setImmediate(produce);
      response.once("close", closed);
    });
    const stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/v1/workspace/stream",
          headers: { Host: "entry.test" },
        },
        resolve,
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(stream.headers["content-type"], "text/event-stream");
    const [first] = await once(stream, "data");
    assert(Buffer.from(first).toString().startsWith("event: ready\n"));
    stream.pause();
    await delay(150);
    assert(
      blocked && sent < 4096,
      "A stalled client must not accumulate the complete 256MiB source.",
    );
    stream.destroy();
    await Promise.race([
      released,
      delay(1500).then(() => {
        throw new Error("SSE source was not released.");
      }),
    ]);
  });
});

describe("opaque Worker upgrade", () => {
  it.each(["wrong-host", "forged-peer"])(
    "closes refused upgrade %s before upstream admission",
    async (kind) => {
      let calls = 0;
      const { port, upstream } = await fixture((_request, response) => response.end());
      upstream.on("upgrade", () => {
        calls++;
      });
      const client = connect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      await once(client, "connect");
      const host = kind === "wrong-host" ? "wrong.test" : "entry.test";
      const spoof = kind === "forged-peer" ? "Forwarded: for=192.0.2.1\r\n" : "";
      client.write(
        `GET /ws/nodes HTTP/1.1\r\nHost: ${host}\r\n${spoof}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await once(client, "close", { signal: AbortSignal.timeout(1500) });
      assert(Buffer.concat(chunks).toString().startsWith("HTTP/1.1 400"));
      assert.equal(calls, 0);
      assert.equal((await call(port, "/health")).status, 200);
    },
  );

  it("preserves refusal status, headers and bounded body without reconnect", async () => {
    let calls = 0;
    const { port } = await fixture((_request, response) => {
      calls++;
      response.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": ["a=1", "b=2"] });
      response.end('{"error":"refused"}');
    });
    const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/ws/nodes",
          headers: {
            Host: "entry.test",
            Connection: "Upgrade",
            Upgrade: "websocket",
          },
        },
        resolve,
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    assert.equal(incoming.statusCode, 403);
    assert.deepEqual(incoming.headers["set-cookie"], ["a=1", "b=2"]);
    assert.equal(Buffer.concat(chunks).toString(), '{"error":"refused"}');
    assert.equal(calls, 1);
  });

  it("preserves an immediate upstream frame in the upgrade head", async () => {
    const { port, upstream } = await fixture((_request, response) => response.end());
    const worker = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (incoming, socket, head) => {
      worker.handleUpgrade(incoming, socket, head, (connection) => connection.send("immediate"));
    });
    cleanups.push(async () => {
      for (const client of worker.clients) client.terminate();
      await new Promise<void>((resolve) => worker.close(() => resolve()));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/nodes`, {
      headers: { Host: "entry.test" },
    });
    const message = once(client, "message");
    await once(client, "open");
    assert.equal((await message)[0].toString(), "immediate");
    client.close();
    await once(client, "close");
  });

  it("preserves binary, ping/pong, close and direct metadata without reconnect", async () => {
    const { port, upstream } = await fixture((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const worker = new WebSocketServer({ noServer: true });
    let calls = 0;
    upstream.on("upgrade", (incoming, socket, head) => {
      calls++;
      assert.equal(incoming.headers.forwarded, "for=127.0.0.1");
      assert.equal(incoming.url, "/ws/nodes?raw=%2f&raw=+");
      worker.handleUpgrade(incoming, socket, head, (socket) => {
        socket.on("message", (data, binary) => socket.send(data, { binary }));
      });
    });
    cleanups.push(async () => {
      for (const client of worker.clients) client.terminate();
      await new Promise<void>((resolve) => worker.close(() => resolve()));
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/nodes?raw=%2f&raw=+`, {
      headers: { Host: "entry.test" },
    });
    await once(client, "open");
    client.send(Buffer.from([0, 255, 128]));
    const [bytes, binary] = await once(client, "message");
    assert.deepEqual(bytes, Buffer.from([0, 255, 128]));
    assert.equal(binary, true);
    client.ping("alive");
    const [pong] = await once(client, "pong");
    assert.equal(pong.toString(), "alive");
    client.close(1000, "finished");
    const [code, reason] = await once(client, "close");
    assert.equal(code, 1000);
    assert.equal(reason.toString(), "finished");
    await delay(100);
    assert.equal(calls, 1);
  });

  it("destroys a pending handshake on client disconnect and shutdown", async () => {
    let pending = 0,
      released = 0;
    const { port, upstream, app } = await fixture((_request, response) => response.end());
    upstream.on("upgrade", (_request, socket) => {
      pending++;
      socket.once("close", () => {
        released++;
      });
      socket.on("end", () => socket.destroy());
      socket.resume();
    });
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      "GET /ws/nodes HTTP/1.1\r\nHost: entry.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    for (let attempt = 0; pending === 0 && attempt < 20; attempt++) await delay(25);
    assert.equal(pending, 1);
    socket.destroy();
    for (let attempt = 0; released === 0 && attempt < 20; attempt++) await delay(25);
    assert.equal(released, 1);
    await app.close();
  });
});

describe("operator configuration", () => {
  const credentialUpstream = new URL("http://127.0.0.1:3102");
  credentialUpstream.username = "user";
  credentialUpstream.password = "pass";
  it.each([
    "https://127.0.0.1:3102",
    "http://localhost:3102",
    "http://192.0.2.1:3102",
    "http://127.0.0.1:3102/path",
    credentialUpstream.href.slice(0, -1),
  ])("refuses non-private or non-origin upstream %s", (upstream) => {
    assert.throws(() =>
      validateOptions({
        upstream,
        publicOrigin: "http://entry.test",
        host: "127.0.0.1",
        port: 3101,
      }),
    );
  });
  it("requires both explicit origins and a bounded listener", () => {
    assert.throws(() => entryOptions({}));
    assert.throws(() =>
      entryOptions({
        OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:3102",
        OPENBOT_TS_PUBLIC_ORIGIN: "http://entry.test",
        OPENBOT_TS_PORT: "0",
      }),
    );
    assert.equal(peerForwarded("::1"), 'for="[::1]"');
    assert.throws(() => peerForwarded("hostname"));
    assert.equal(safeRequestTarget("/health?spelling=%2f+%20"), true);
  });
});
