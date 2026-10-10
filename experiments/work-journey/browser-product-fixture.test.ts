/** Real loopback HTTP verifies the previous refusal/one-attempt contract without a database or model. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { BrowserHttpFailure, BrowserProductFixture } from "./browser-product-fixture.ts";
const storage = '{"error":"Control-plane storage is unavailable."}';
async function fixture(t: TestContext) {
  let status = 503,
    body = storage;
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.method + " " + request.url);
    for await (const _chunk of request) {
      /* Consume the complete owned request. */
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address === "object");
  const api = new BrowserProductFixture("/unused-no-write", new AbortController().signal);
  api.origin = `http://127.0.0.1:${address.port}`;
  return {
    api,
    calls,
    reply: (code: number, value: string) => {
      status = code;
      body = value;
    },
  };
}
test("snapshot refusals remain observable and each call sends one read", async (t) => {
  const { api, calls } = await fixture(t);
  assert.equal(await api.snapshot("synthetic-task"), false);
  assert.equal(await api.snapshot("synthetic-task"), false);
  assert.equal(api.unavailableReads, 2);
  assert.deepEqual(calls, ["GET /api/v1/tasks/synthetic-task", "GET /api/v1/tasks/synthetic-task"]);
});
test("a later explicit poll reads a later server success", async (t) => {
  const { api, calls, reply } = await fixture(t);
  assert.equal(await api.snapshot("synthetic-task"), false);
  reply(200, '{"status":"completed"}');
  assert.deepEqual(await api.snapshot("synthetic-task"), { status: "completed" });
  assert.equal(calls.length, 2);
});
test("writes remain fatal and are never retried", async (t) => {
  const { api, calls } = await fixture(t);
  await assert.rejects(
    api.api("/api/v1/tasks/synthetic-task", { operation: "cancel" }),
    BrowserHttpFailure,
  );
  assert.deepEqual(calls, ["POST /api/v1/tasks/synthetic-task"]);
  assert.equal(api.unavailableReads, 0);
});
test("other HTTP refusals and malformed JSON remain fatal", async (t) => {
  const { api, calls, reply } = await fixture(t);
  for (const [status, body] of [
    [403, storage],
    [500, storage],
    [503, '{"error":"other"}'],
    [503, "broken"],
  ] as const) {
    reply(status, body);
    await assert.rejects(api.snapshot("synthetic-task"));
  }
  assert.equal(calls.length, 4);
  assert.equal(api.unavailableReads, 0);
});
test("non-snapshot reads remain fatal", async (t) => {
  const { api, calls } = await fixture(t);
  await assert.rejects(api.api("/health"), BrowserHttpFailure);
  assert.deepEqual(calls, ["GET /health"]);
  assert.equal(api.unavailableReads, 0);
});
test("an explicitly expected refusal is returned unchanged", async (t) => {
  const { api, calls } = await fixture(t);
  assert.deepEqual(
    await api.api("/api/v1/tasks/synthetic-task", undefined, 503),
    JSON.parse(storage),
  );
  assert.equal(calls.length, 1);
  assert.equal(api.unavailableReads, 0);
});
test("download refusal remains fatal without another request", async (t) => {
  const { api, calls } = await fixture(t);
  await assert.rejects(
    api.api("/api/v1/tasks/synthetic-task", undefined, 200, true),
    BrowserHttpFailure,
  );
  assert.equal(calls.length, 1);
  assert.equal(api.unavailableReads, 0);
});
