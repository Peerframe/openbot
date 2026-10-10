/** Same poller freshness/identity negatives as the retired Python observer, using synthetic RPCs. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { freshIdentities, observe, type Poller, type PollerResponse } from "./observe-pollers.ts";
const poller = (identity: string, ns: number) => ({ identity, lastAccessTime: { seconds: Math.floor(ns / 1e9), nanos: ns % 1e9 } });
const response = (...pollers: Poller[]) => ({ pollers });
function fixture(...responses: PollerResponse[]) {
  const calls: { namespace: string; taskQueue: { name: string }; taskQueueType: number }[] = [], deadlines: number[] = [];
  return { calls, deadlines, connection: {
    async withDeadline<T>(deadline: number, callback: () => Promise<T>) { deadlines.push(deadline); return callback(); },
    workflowService: { async describeTaskQueue(request: typeof calls[number]) { calls.push(request); return responses.shift()!; } },
  } };
}
test("exact nanosecond boundary ignores absent identity/time", () => {
  assert.deepEqual(freshIdentities(response(poller("old", 999999999), poller("fresh", 1000000000), poller("", 2000000000), { identity: "no-time" }), 1000), new Set(["fresh"]));
});
test("both queue types require one matching fresh identity; only its hash is returned", async () => {
  const f = fixture(response(poller("private-worker", 1000000000)), response(poller("private-worker", 1000000001)));
  const before = Date.now(), result = await observe(f.connection, "synthetic", "unique-queue", 1000);
  assert.equal(result.freshWorkflowPollers, 1); assert.equal(result.freshActivityPollers, 1);
  assert.equal(result.sameWorkerIdentity, true); assert.match(result.workerIdentitySha256, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(result).includes("private-worker"));
  assert.deepEqual(f.calls.map((v) => v.taskQueueType), [1, 2]);
  assert(f.calls.every((v) => v.namespace === "synthetic" && v.taskQueue.name === "unique-queue"));
  assert(f.deadlines.every((v) => v >= before && v <= Date.now() + 5000));
});
test("old stopped workers do not count as multiple current workers", async () => {
  const entries = [poller("old", 999000000), poller("fresh", 1000000000)];
  const f = fixture(response(...entries), response(...entries));
  assert.equal((await observe(f.connection, "synthetic", "queue", 1000)).sameWorkerIdentity, true);
});
test("pending descriptions are re-read without starting execution", async () => {
  const f = fixture(response(), response(), response(poller("worker", 1000000000)), response(poller("worker", 1000000000)));
  assert.equal((await observe(f.connection, "synthetic", "queue", 1000, { intervalMs: 0 })).sameWorkerIdentity, true);
  assert.equal(f.calls.length, 4);
});
test("multiple current workers fail closed", async () => {
  const f = fixture(response(poller("one", 1000000000), poller("two", 1000000000)), response(poller("one", 1000000000)));
  await assert.rejects(observe(f.connection, "synthetic", "queue", 1000), /multiple_fresh_worker_identities/);
});
for (const identity of ["", "another-worker"]) test(`missing/different Activity worker: ${identity}`, async () => {
  const f = fixture();
  f.connection.workflowService.describeTaskQueue = async (request) => response(poller(request.taskQueueType === 1 ? "workflow-worker" : identity, 1000000000));
  await assert.rejects(observe(f.connection, "synthetic", "queue", 1000, { timeoutMs: 30, intervalMs: 5 }), /fresh_worker_pollers_not_observed/);
});
