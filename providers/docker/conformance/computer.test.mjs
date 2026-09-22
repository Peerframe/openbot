import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runProviderConformanceSuite } from "../../../packages/provider-conformance-runner/dist/runner.js";
import { createDockerProvider } from "../dist/index.js";
import { runConformanceChild } from "./child-process.mjs";
import { createCleanupGate, SyntheticComputer } from "./computer.mjs";
import { eventually } from "./fixture.mjs";
import { createBrowserSuite } from "./scenarios.mjs";

async function computer(t) {
  const fixture = new SyntheticComputer("synthetic-test-computer-token");
  fixture.botId = randomUUID();
  await fixture.start();
  t.after(() => fixture.stop());
  return fixture;
}
function headers(f) {
  return {
    "x-openbot-computer-token": f.token,
    "x-openbot-bot-id": f.botId,
    "content-type": "application/json",
  };
}

test("computer rejects foreign Bot or missing token without a commit", async (t) => {
  const f = await computer(t);
  for (const supplied of [{}, { ...headers(f), "x-openbot-bot-id": randomUUID() }]) {
    const response = await fetch(`${f.origin}/click`, {
      method: "POST",
      headers: supplied,
      body: JSON.stringify({ ref: f.ref, snapshotId: f.snapshotId }),
    });
    assert.equal(response.status, 401);
    await response.body.cancel();
  }
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.requests, []);
});

test("lost receipt records the exact attempt before destroying the real socket", async (t) => {
  const f = await computer(t);
  f.mode = "drop-receipt";
  const body = { ref: f.ref, snapshotId: f.snapshotId };
  await assert.rejects(
    fetch(`${f.origin}/click`, { method: "POST", headers: headers(f), body: JSON.stringify(body) }),
  );
  assert.deepEqual(f.commits, [body]);
  assert.equal(f.changed, true);
  assert.deepEqual(f.errors, []);
});

test("incorrect reference remains visible as an attempted commit and fixture error", async (t) => {
  const f = await computer(t);
  const body = { ref: "e999", snapshotId: f.snapshotId };
  await assert.rejects(
    fetch(`${f.origin}/click`, { method: "POST", headers: headers(f), body: JSON.stringify(body) }),
  );
  assert.deepEqual(f.commits, [body]);
  assert.deepEqual(f.errors, ["computer-handler-failed"]);
});

test("production Bot lock is held while real HTTP reader cleanup is gated", {
  timeout: 5000,
}, async (t) => {
  const f = await computer(t);
  const gate = createCleanupGate();
  t.after(() => gate.release());
  f.mode = "cleanup-gate";
  const provider = createDockerProvider({
    computerUrl: f.origin,
    computerToken: f.token,
    allowPrivateHosts: true,
    fetcher: gate.fetcher,
  });
  const signal = AbortSignal.timeout(3000);
  const context = { nodeId: "fixture", workDirectory: "/unused", signal };
  const input = {
    runId: randomUUID(),
    channelId: randomUUID(),
    botId: f.botId,
    title: "Synthetic",
    instruction: `Open ${f.target}`,
    executionProfile: "docker-linux",
  };
  const first = provider
    .execute(context, input, () => {})
    .then(
      () => "unexpected-success",
      () => "failed",
    );
  await eventually(() => gate.entered, Boolean, signal, "Cleanup gate did not open.");
  await assert.rejects(
    provider.execute(context, { ...input, runId: randomUUID() }, () => {}),
    /already has an active browser operation/,
  );
  assert.equal(f.requests.length, 1);
  gate.release();
  assert.equal(await first, "failed");
  f.mode = "normal";
  assert.equal(
    (await provider.execute(context, { ...input, runId: randomUUID() }, () => {})).ok,
    true,
  );
});

test("suite has only required scenarios and runner fails when a scenario or its cleanup fails", async () => {
  const suite = createBrowserSuite("postgres://fixture:fixture@127.0.0.1:1/openbot_dev_smoke");
  assert.equal(suite.scenarios.length, 11);
  assert(suite.scenarios.every((scenario) => scenario.severity === "required"));
  assert.equal(suite.target.evidenceLevel, "hermetic");
  for (const phase of ["setup", "run", "cleanup"]) {
    const result = await runProviderConformanceSuite({
      ...suite,
      scenarios: [
        {
          id: "fixture.failure",
          name: "Failure propagation",
          description: "A required fixture failure must fail the report.",
          severity: "required",
          setup() {},
          run() {
            return { status: "success", code: "verified" };
          },
          cleanup() {},
          [phase]() {
            throw new Error("synthetic failure");
          },
        },
      ],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.summary.conformant, false);
  }
});

for (const mode of ["deadline", "external-abort"]) {
  test(`driver reaps a child ignoring SIGTERM after ${mode}`, { timeout: 5000 }, async (t) => {
    const controller = new AbortController();
    let child;
    let ready = false;
    t.after(() => child?.kill("SIGKILL"));
    const started = Date.now();
    const operation = runConformanceChild(
      ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        signal: controller.signal,
        timeoutMs: mode === "deadline" ? 500 : 3000,
        graceMs: 100,
        stdout(chunk) {
          if (chunk.toString().includes("ready")) {
            ready = true;
            if (mode === "external-abort") controller.abort();
          }
        },
        stderr() {},
        onSpawn(value) {
          child = value;
        },
      },
    );
    await assert.rejects(operation, /Conformance child failed \(ABORT_ERR\)/);
    assert(ready, "Child did not install its SIGTERM handler.");
    assert.equal(child.signalCode, "SIGKILL");
    assert(Date.now() - started < 2500, "Driver did not bound child termination.");
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  });
}
