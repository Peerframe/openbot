import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

// Synthetic one-pixel PNGs: no browser profile, user image, or external network is involved.
export const beforePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
export const afterPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export class SyntheticComputer {
  token;
  botId;
  origin;
  target;
  mode = "normal";
  holder = "bot";
  changed = false;
  requests = [];
  commits = [];
  errors = [];
  snapshotId = 40;
  ref = "f2e7";
  #server;
  #sockets = new Set();

  constructor(token) {
    this.token = token;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (this.errors.length < 16) this.errors.push("computer-handler-failed");
        response.destroy();
      });
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }
  async start() {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.origin = `http://127.0.0.1:${this.#server.address().port}`;
    this.target = `${this.origin}/page`;
  }
  async stop() {
    if (!this.#server.listening) return;
    const socketsClosed = [...this.#sockets].map((socket) => once(socket, "close"));
    const closed = new Promise((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
    this.#server.closeAllConnections();
    await closed;
    // close() observes HTTP completion before every socket close callback has necessarily run.
    await Promise.all(socketsClosed);
    assert.equal(this.#sockets.size, 0, "Synthetic computer sockets remain open.");
  }
  async #handle(request, response) {
    const json = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (
      request.headers["x-openbot-computer-token"] !== this.token ||
      !this.botId ||
      request.headers["x-openbot-bot-id"] !== this.botId
    ) {
      request.resume();
      json({ error: "fixture-unauthorized" }, 401);
      return;
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4096) {
        json({ error: "fixture-body-limit" }, 413);
        return;
      }
      chunks.push(chunk);
    }
    const body = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    assert(this.requests.length < 128, "Synthetic computer request limit reached.");
    this.requests.push({ path: request.url, method: request.method, body });
    switch (request.url) {
      case "/navigate":
        assert.equal(request.method, "POST");
        assert.deepEqual(body, { url: this.target });
        if (this.mode === "cleanup-gate") {
          response.writeHead(503, { "Content-Type": "application/json" });
          response.write("{");
          return;
        }
        json({ url: this.target, title: "Synthetic controlled page" });
        return;
      case "/screenshot":
        assert.equal(request.method, "GET");
        json({
          url: this.target,
          base64: this.changed ? afterPng : beforePng,
          width: 1,
          height: 1,
          capturedAt: new Date().toISOString(),
        });
        return;
      case "/control":
        assert.equal(request.method, "GET");
        if (this.mode === "control-timeout") return;
        json({ holder: this.holder });
        return;
      case "/snapshot":
        assert.equal(request.method, "POST");
        assert.deepEqual(body, {});
        this.snapshotId += 1;
        json({
          url: this.target,
          snapshotId: this.snapshotId,
          truncated: false,
          elements: [{ role: "button", name: "Preview", ref: this.ref, disabled: false }],
        });
        return;
      case "/click":
        assert.equal(request.method, "POST");
        // Record the actual attempt before validating it: a wrong or repeated commit cannot hide.
        this.commits.push(body);
        assert.deepEqual(body, { ref: this.ref, snapshotId: this.snapshotId });
        assert.equal(this.holder, "bot");
        this.changed = true;
        if (this.mode === "hold-receipt") return;
        if (this.mode === "drop-receipt") {
          response.destroy();
          return;
        }
        json({ action: "click", ref: this.ref, url: this.target, elapsedMs: 1 });
        return;
      default:
        json({ error: "fixture-route-missing" }, 404);
    }
  }
}

// A real HTTP response is fetched first. Only its body reader cleanup is fault-injected; the
// production Provider still owns acquisition/release of its Bot lock and every authority check.
export function createCleanupGate() {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let entered = false;
  let enabled = true;
  return {
    get entered() {
      return entered;
    },
    release() {
      enabled = false;
      release();
    },
    async fetcher(url, init) {
      const response = await fetch(url, init);
      if (!enabled || !String(url).endsWith("/navigate")) return response;
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream({
          pull() {},
          async cancel() {
            try {
              await reader.cancel();
            } finally {
              reader.releaseLock();
            }
            entered = true;
            await released;
          },
        }),
        { status: response.status, headers: response.headers },
      );
    },
  };
}
