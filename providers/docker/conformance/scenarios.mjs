import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { detectWorkerHost } from "../../../apps/node/dist/host.js";
import { validateDatabaseUrl } from "../../../scripts/smoke-dev-fixture.mjs";
import { createDockerProvider } from "../dist/index.js";
import { afterPng, beforePng } from "./computer.mjs";
import { BrowserFixture, eventually } from "./fixture.mjs";

async function begin(fixture) {
  const run = await fixture.submit();
  const approval = await fixture.waitApproval(run);
  assert.equal(fixture.computer.commits.length, 0);
  return { run, approval };
}
async function completed(fixture, run) {
  await fixture.waitRun(run, "completed");
  await fixture.waitSettled(run);
  const workspace = await fixture.workspace();
  const approved = workspace.approvals.find((approval) => approval.runId === run.id);
  assert.equal(approved.status, "approved");
  assert.deepEqual(fixture.computer.commits, [
    { ref: approved.beforeState.ref, snapshotId: approved.beforeState.snapshotId },
  ]);
  assert.deepEqual(fixture.computer.errors, []);
  const artifacts = workspace.artifacts.filter((artifact) => artifact.runId === run.id);
  assert.equal(artifacts.length, 1);
  const response = await fixture.request(`/api/v1/artifacts/${artifacts[0].id}/content`);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(afterPng, "base64"));
  const frame = fixture.frames.get(run.id);
  assert.equal(frame.frame.revision, 2);
  assert.deepEqual(frame.bytes, Buffer.from(afterPng, "base64"));
  const events = await fixture.database
    .client`select type from run_events where run_id = ${run.id}`;
  for (const type of ["APPROVAL_REQUESTED", "APPROVAL_APPROVED", "RUN_COMPLETED"])
    assert.equal(events.filter((event) => event.type === type).length, 1);
}

const cases = [
  [
    "browser.approve-once",
    "Approve the frozen action once",
    async (f) => {
      const { run, approval } = await begin(f);
      assert.equal(approval.action, "browser.click");
      assert.equal(approval.target, f.computer.target);
      assert.equal(approval.risk, "privileged");
      assert.deepEqual(approval.beforeState, {
        ref: f.computer.ref,
        snapshotId: f.computer.snapshotId,
        buttonName: "Preview",
        screenshotSha256: createHash("sha256")
          .update(Buffer.from(beforePng, "base64"))
          .digest("hex"),
      });
      const before = await f.request(`/api/v1/runs/${run.id}/frame`);
      assert.deepEqual(Buffer.from(await before.arrayBuffer()), Buffer.from(beforePng, "base64"));
      // Public requests without the Owner session cannot authorize this observed side effect.
      const denied = await f.request(
        `/api/v1/approvals/${approval.id}/decision`,
        { decision: "approve" },
        401,
        false,
      );
      await denied.body.cancel();
      assert.equal(f.computer.commits.length, 0);
      await f.decide(approval, "approve");
      await completed(f, run);
      await f.decide(approval, "approve", 409);
      assert.equal(f.computer.commits.length, 1);
    },
  ],
  [
    "browser.reject",
    "Rejection prevents a commit",
    async (f) => {
      const { run, approval } = await begin(f);
      await f.decide(approval, "reject");
      await f.waitRun(run, "blocked");
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.expire",
    "Expired approval prevents a commit",
    async (f) => {
      const { run, approval } = await begin(f);
      // Fixture-only clock fault in the disposable database; the actual decision path is unchanged.
      await f.database
        .client`update approvals set expires_at = now() - interval '1 second' where id = ${approval.id}`;
      await f.decide(approval, "approve", 409);
      await f.waitRun(run, "blocked");
      assert.equal(
        (await f.workspace()).approvals.find((item) => item.id === approval.id).status,
        "expired",
      );
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.node-stop",
    "Node stop aborts the pending Provider",
    async (f, signal) => {
      const { run, approval } = await begin(f);
      await f.node.stop();
      await eventually(
        () => f.registry.list(),
        (nodes) => nodes.length === 0,
        signal,
        "Stopped Node remains registered.",
      );
      await f.assertNoResult(run);
      // Current B1b gap: pending approvals need a later decision to become terminal after disconnect.
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed");
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.disconnect",
    "Owner credential revocation stops the Node",
    async (f, signal) => {
      const { run, approval } = await begin(f);
      await f.request(`/api/v1/nodes/${f.nodeId}/revoke`, {}, 204);
      await eventually(
        () => f.registry.list(),
        (nodes) => nodes.length === 0,
        signal,
        "Revoked Node remains registered.",
      );
      await f.assertNoResult(run);
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed");
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.changed-evidence",
    "Changed evidence prevents a commit",
    async (f) => {
      const { run, approval } = await begin(f);
      f.computer.changed = true;
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed");
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.human-control",
    "Human takeover prevents a commit",
    async (f) => {
      const { run, approval } = await begin(f);
      f.computer.holder = "human";
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed");
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.transport-timeout",
    "Production HTTP deadline prevents a commit",
    async (f) => {
      const { run, approval } = await begin(f);
      f.computer.mode = "control-timeout";
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed", 20_000);
      await f.assertNoResult(run);
    },
  ],
  [
    "browser.lost-receipt",
    "Lost receipt never retries a click",
    async (f) => {
      const { run, approval } = await begin(f);
      f.computer.mode = "drop-receipt";
      await f.decide(approval, "approve");
      await f.waitRun(run, "failed");
      await f.waitSettled(run);
      assert.deepEqual(f.computer.commits, [
        { ref: f.computer.ref, snapshotId: f.computer.snapshotId },
      ]);
      assert.equal(f.computer.changed, true);
      assert.deepEqual(
        (await f.workspace()).artifacts.filter((artifact) => artifact.runId === run.id),
        [],
      );
      assert.deepEqual(f.computer.errors, []);
      const events = await f.database.client`select type from run_events where run_id = ${run.id}`;
      assert.equal(
        events.some((event) => event.type === "RUN_COMPLETED"),
        false,
      );
    },
  ],
  [
    "browser.bot-approval-exclusion",
    "Same Bot remains exclusive during approval",
    async (f) => {
      const first = await begin(f);
      const second = await f.submit();
      await f.waitRun(second, "failed");
      await f.waitSettled(second);
      assert.equal(f.computer.requests.filter((request) => request.path === "/navigate").length, 1);
      await f.decide(first.approval, "reject");
      await f.assertNoResult(first.run);
      const third = await begin(f);
      await f.decide(third.approval, "approve");
      await completed(f, third.run);
    },
  ],
  [
    "browser.bot-cleanup-exclusion",
    "Same Bot remains exclusive until reader cleanup",
    async (f, signal) => {
      const first = await f.submit();
      await eventually(
        () => f.cleanupGate.entered,
        Boolean,
        signal,
        "Reader did not enter gated cleanup.",
      );
      assert.equal(f.settled.has(first.id), false);
      const second = await f.submit();
      await f.waitRun(second, "failed");
      await f.waitSettled(second);
      assert.equal(f.computer.requests.filter((request) => request.path === "/navigate").length, 1);
      assert.equal(f.settled.has(first.id), false);
      f.cleanupGate.release();
      f.computer.mode = "normal";
      await f.waitRun(first, "failed");
      await f.waitSettled(first);
      const third = await begin(f);
      await f.decide(third.approval, "approve");
      await completed(f, third.run);
    },
    { gateCleanup: true },
  ],
];

export function createBrowserSuite(databaseUrl) {
  validateDatabaseUrl(databaseUrl);
  const { platform, architecture, osVersion } = detectWorkerHost();
  return {
    name: "openbot-docker-browser",
    version: "1.0.0",
    stage: "integration",
    providerVersion: "0.0.0",
    provider: createDockerProvider({
      computerUrl: "http://127.0.0.1:1",
      computerToken: "declaration-only-fixture",
      inputOrigins: ["http://127.0.0.1:1"],
    }),
    target: { platform, architecture, osVersion, evidenceLevel: "hermetic" },
    defaultTimeoutMs: 35_000,
    scenarios: cases.map(([id, name, run, options]) => {
      let fixture;
      return {
        id,
        name,
        description: `${name} through the production Server, enrolled Node and Docker Provider with a synthetic computer.`,
        severity: "required",
        async setup({ signal }) {
          console.info(`${id}: setup`);
          fixture = new BrowserFixture();
          await fixture.start(databaseUrl, signal, options);
        },
        async run({ signal }) {
          console.info(`${id}: run`);
          await run(fixture, signal);
          return { status: "success", code: "verified" };
        },
        async cleanup() {
          await fixture?.close();
          console.info(`${id}: cleaned`);
        },
      };
    }),
  };
}
