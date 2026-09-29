import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { test } from "node:test";
import { type ResponseLossReceipt, responseLossRelay } from "./browser_response_loss.ts";

interface Upstream {
  readonly url: string;
  readonly hits: string[];
  readonly state: { submitted: unknown };
  readonly server: Server;
}
interface UpstreamOptions {
  readonly clickStatus?: number;
  readonly submits?: boolean;
}
type Sent = { status: number; body: string } | { error: string };
const FAILED: ResponseLossReceipt = { failed: true, code: "fault_fixture_failed" };

/** Owned loopback stand-in for the browser service; /click changes independent target state. */
async function startUpstream(options: UpstreamOptions): Promise<Upstream> {
  const hits: string[] = [];
  const state: { submitted: unknown } = { submitted: 0 };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    hits.push(`${req.method} ${req.url} ${body.length}`);
    if (req.url === "/click") {
      if (options.submits !== false) state.submitted = 1;
      res.writeHead(options.clickStatus ?? 200).end("clicked");
      return;
    }
    if (req.url === "/large") {
      res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bytes: body.length }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Upstream has no port");
  return { url: `http://127.0.0.1:${address.port}`, hits, state, server };
}

function send(base: string, method: string, path: string, body = ""): Promise<Sent> {
  return new Promise((resolve) => {
    const outgoing = request(new URL(path, base), { method, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => resolve({ error: error.message }));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    outgoing.on("error", (error) => resolve({ error: error.message }));
    outgoing.end(body);
  });
}

async function withRelay(
  options: UpstreamOptions,
  run: (relay: string, upstream: Upstream, receipts: ResponseLossReceipt[]) => Promise<void>,
): Promise<void> {
  const upstream = await startUpstream(options);
  const receipts: ResponseLossReceipt[] = [];
  const relay = await responseLossRelay(upstream.url, upstream.state, async (value) => {
    receipts.push(value);
  });
  try {
    await run(relay.url, upstream, receipts);
  } finally {
    relay.close();
    upstream.server.closeAllConnections();
    upstream.server.close();
  }
}

function clickHits(upstream: Upstream): number {
  return upstream.hits.filter((hit) => hit.startsWith("POST /click ")).length;
}

test("the relay refuses anything but the owned plain-HTTP loopback upstream", async () => {
  for (const upstream of ["http://localhost:1", "https://127.0.0.1:1", "http://10.0.0.1:1"]) {
    await assert.rejects(
      responseLossRelay(upstream, { submitted: 0 }, async () => {}),
      /owned loopback upstream/,
    );
  }
});

test("ordinary requests pass through exactly up to the 64 KiB request bound", async () => {
  await withRelay({}, async (relay, upstream, receipts) => {
    const exact = await send(relay, "POST", "/health", "x".repeat(65536));
    assert.deepEqual(exact, { status: 200, body: JSON.stringify({ ok: true, bytes: 65536 }) });
    assert.ok("error" in (await send(relay, "POST", "/health", "x".repeat(65537))));
    assert.deepEqual(upstream.hits, ["POST /health 65536"]);
    assert.deepEqual(receipts, [FAILED]);
  });
});

test("an approved click reaches upstream once and its response is deliberately lost", async () => {
  await withRelay({}, async (relay, upstream, receipts) => {
    assert.ok("error" in (await send(relay, "POST", "/click", "{}")));
    assert.equal(upstream.state.submitted, 1);
    assert.deepEqual(receipts, [
      { upstreamClickRequests: 1, upstreamSuccess: true, targetSubmitted: 1 },
    ]);
    // A second click is never forwarded: the fixture refuses it and upstream sees one click.
    assert.ok("error" in (await send(relay, "POST", "/click", "{}")));
    assert.equal(clickHits(upstream), 1);
    assert.deepEqual(receipts.slice(1), [FAILED]);
    assert.deepEqual(await send(relay, "GET", "/health"), {
      status: 200,
      body: JSON.stringify({ ok: true, bytes: 0 }),
    });
  });
});

test("a click without upstream success is not reported as applied", async () => {
  await withRelay({ clickStatus: 500 }, async (relay, upstream, receipts) => {
    assert.ok("error" in (await send(relay, "POST", "/click", "{}")));
    assert.equal(clickHits(upstream), 1);
    assert.deepEqual(receipts, [FAILED]);
  });
});

test("a click without an independent target submission fails after the 3 s wait", async () => {
  await withRelay({ submits: false }, async (relay, upstream, receipts) => {
    const started = Date.now();
    assert.ok("error" in (await send(relay, "POST", "/click", "{}")));
    assert.ok(Date.now() - started >= 2900);
    assert.equal(clickHits(upstream), 1);
    assert.deepEqual(receipts, [FAILED]);
  });
});

test("upstream responses above 8 MiB are refused", async () => {
  await withRelay({}, async (relay, upstream, receipts) => {
    assert.ok("error" in (await send(relay, "GET", "/large")));
    assert.deepEqual(upstream.hits, ["GET /large 0"]);
    assert.deepEqual(receipts, [FAILED]);
  });
});
