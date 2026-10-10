/** Exercises fixed Host invocation, bounded captures and failure cleanup without sudo or providers. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { NativeProductController, reserveLoopbackPort } from "./product-native-controller.ts";
const route = {
  nodeId: "fixture",
  providerId: "linux-command",
  enforcementKeyId: "enforcer",
  ledgerId: randomUUID(),
};
const timing = {
  prepareBudgetMs: 30000,
  challengeBudgetMs: 5000,
  runtimeMaxMs: 50000,
  stopAllowanceMs: 5000,
  clockRateErrorPpm: 1000,
  clockQuantizationMs: 100,
  policyDigest: "e".repeat(64),
};
const pem = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();
const READY = {
  version: 1,
  event: "remote_ready",
  socketReady: true,
  nodeSpawned: true,
  nodeUid: 62425,
  serverAuthenticated: false,
};
const token = "obenr_" + "A".repeat(43);
class Process extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  finish(value: unknown, code = 0) {
    if (value !== undefined) this.stdout.write(JSON.stringify(value) + "\n");
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
  kill() {
    this.killed = true;
    this.finish(undefined, null as unknown as number);
    return true;
  }
}
async function fixture(
  t: TestContext,
  responder?: (operation: string, payload: Record<string, unknown>, child: Process) => boolean,
) {
  const directory = await mkdtemp(join(tmpdir(), "ob-native-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const calls: { operation: string; payload: Record<string, unknown>; child: Process }[] = [];
  const replacement = t.mock.method(childProcess, "spawn", (command: unknown, args: unknown) => {
    assert.equal(command, "/usr/bin/sudo");
    assert(Array.isArray(args));
    assert.deepEqual(args.slice(0, 3), [
      "-n",
      "/opt/obp5/code/node",
      "/opt/obp5/code/product-host.cjs",
    ]);
    assert.equal(args.length, 4);
    assert(!JSON.stringify(args).includes(token));
    const child = new Process(),
      operation = String(args[3]);
    let input = "";
    child.stdin.on("data", (bytes) => {
      input += bytes.toString();
    });
    child.stdin.on("finish", () => {
      const payload = JSON.parse(input);
      calls.push({ operation, payload, child });
      if (responder?.(operation, payload, child)) return;
      if (operation === "stage")
        child.finish({
          version: 1,
          stageReady: true,
          route,
          enforcementIssuer: "product-enforcer",
          enforcementKeyId: route.enforcementKeyId,
          enforcementPublicPem: pem,
          serverUrl: `ws://127.0.0.1:${payload.serverPort}/ws/nodes`,
        });
      else if (operation === "cleanup") child.finish({ unusedStageKeyRemoved: true });
      else if (operation === "check")
        child.finish({ version: 1, singleActionAbsent: true, runnerReserved: true, route });
      else if (operation === "run") child.stdout.write(JSON.stringify(READY) + "\n");
      else assert.fail("Unexpected native operation.");
    });
    return child as unknown as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => {
    replacement.mock.restore();
    syncBuiltinESMExports();
  });
  const config = join(directory, "config.json"),
    bundle = join(directory, "node.cjs");
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      program: "/opt/obp5/code/product-host.cjs",
      node: "/opt/obp5/code/node",
    }),
  );
  await writeFile(bundle, "public synthetic bundle");
  const controller = await NativeProductController.open(config, directory),
    reservation = await reserveLoopbackPort();
  return {
    controller,
    reservation,
    calls,
    directory,
    bundle,
    async staged() {
      assert.equal(await controller.stage(route, timing, pem, bundle, reservation), pem);
      await controller.releaseServerPort();
    },
  };
}
test("owned loopback socket stays reserved during stage; unused cleanup only", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.controller.stage(route, timing, pem, f.bundle, f.reservation), pem);
  await assert.rejects(reserveLoopbackPort(f.reservation.port));
  await assert.rejects(
    f.controller.stage(route, timing, pem, f.bundle, f.reservation),
    /already_attempted/,
  );
  await f.controller.close();
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "cleanup"],
  );
  const next = await reserveLoopbackPort(f.reservation.port);
  await next.close();
});
test("failed stage consumes its attempt and independently removes only the unused stage key", async (t) => {
  const f = await fixture(t, (op, _payload, child) => {
    if (op !== "stage") return false;
    child.finish({}, 1);
    return true;
  });
  await assert.rejects(
    f.controller.stage(route, timing, pem, f.bundle, f.reservation),
    /native_stage_failed/,
  );
  await f.controller.close();
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "cleanup"],
  );
});
test("once refuses capture overflow without retrying or printing captured bytes", async (t) => {
  const f = await fixture(t, (op, _payload, child) => {
    if (op !== "stage") return false;
    child.stdout.write(Buffer.alloc(96 * 1024 + 1, 97));
    child.finish(undefined);
    return true;
  });
  await assert.rejects(
    f.controller.stage(route, timing, pem, f.bundle, f.reservation),
    /native_capture_bound/,
  );
  await f.controller.close();
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "cleanup"],
  );
});
test("enrollment is stdin-only, one original run, no unused-key cleanup after run", async (t) => {
  const f = await fixture(t);
  await f.staged();
  await f.controller.start(token, f.reservation.port);
  const run = f.calls.find((c) => c.operation === "run")!;
  assert.deepEqual(run.payload, { version: 1, enrollmentToken: token });
  await assert.rejects(f.controller.start(token, f.reservation.port), /native_server_port_changed/);
  await f.controller.assertUnprepared();
  run.child.stderr.write(token);
  run.child.finish({ version: 1 });
  await f.controller.close();
  assert(!run.child.killed);
  assert.equal(
    await readFile(join(f.directory, "native-run.stderr-private"), "utf8"),
    "[redacted-enrollment]",
  );
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "run", "check"],
  );
});
test("bad readiness waits for the original runner to finish instead of aborting its cleanup", async (t) => {
  let finish!: () => void;
  const f = await fixture(t, (op, _payload, child) => {
    if (op !== "run") return false;
    child.stdout.write(JSON.stringify({ ...READY, nodeUid: 0 }) + "\n");
    finish = () => child.finish({ version: 1 });
    return true;
  });
  await f.staged();
  let settled = false;
  const started = f.controller.start(token, f.reservation.port).finally(() => {
    settled = true;
  });
  const rejection = assert.rejects(started, /native_ready_changed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  await rejection;
  await f.controller.close();
  assert(!f.calls.find((c) => c.operation === "run")!.child.killed);
});
test("run overflow remains a failure after successful root exit, with no retry or unreserved cleanup", async (t) => {
  const f = await fixture(t);
  await f.staged();
  await f.controller.start(token, f.reservation.port);
  const run = f.calls.find((c) => c.operation === "run")!;
  run.child.stderr.write(Buffer.alloc(96 * 1024 + 1, 97));
  run.child.finish({ version: 1 });
  await assert.rejects(f.controller.close(), /native_capture_bound/);
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "run"],
  );
  assert(!run.child.killed);
});
test("invalid enrollment or changed canonical port cannot spawn a run", async (t) => {
  const f = await fixture(t);
  await f.staged();
  await assert.rejects(
    f.controller.start("bad", f.reservation.port),
    /one_time_enrollment_required/,
  );
  await assert.rejects(
    f.controller.start(token, f.reservation.port + 1),
    /native_server_port_changed/,
  );
  await f.controller.close();
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["stage", "cleanup"],
  );
});
