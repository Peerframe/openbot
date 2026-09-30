import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DevProcessOwner } from "./dev-processes.ts";

const env = process.env;

function hangingFakeChild(killImpl: (signal?: NodeJS.Signals | number) => boolean): ChildProcess {
  const fake = new EventEmitter() as ChildProcess;
  Object.defineProperty(fake, "pid", { configurable: true, value: 12345 });
  Object.defineProperty(fake, "exitCode", { configurable: true, value: null });
  Object.defineProperty(fake, "signalCode", { configurable: true, value: null });
  fake.kill = killImpl;
  return fake;
}

test("waitSuccess resolves when a Node child exits 0", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start(process.execPath, ["-e", "process.exit(0)"], env);
  await owner.waitSuccess(child);
  await owner.stop();
});

test("late waitSuccess still resolves after a successful exit", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start(process.execPath, ["-e", "process.exit(0)"], env);
  await once(child, "exit");
  await owner.waitSuccess(child);
  await owner.stop();
});

test("late waitSuccess rejects after a non-zero exit", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start(process.execPath, ["-e", "process.exit(7)"], env);
  await once(child, "exit");
  await assert.rejects(owner.waitSuccess(child), { message: "Development process exited (7)." });
  await owner.stop();
});

test("late waitSuccess rejects after a spawn ENOENT", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start("/no/such/openbot-dev-process-binary", [], env);
  await once(child, "error");
  await assert.rejects(owner.waitSuccess(child), { code: "ENOENT" });
  await owner.stop();
});

test("waitSuccess rejects when a Node child exits non-zero", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start(process.execPath, ["-e", "process.exit(7)"], env);
  await assert.rejects(owner.waitSuccess(child), { message: "Development process exited (7)." });
  await owner.stop();
});

test("stop is shared across repeats and rejects new starts afterward", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd(), graceMs: 500 });
  owner.start(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], env);
  const first = owner.stop();
  assert.equal(first, owner.stop());
  await first;
  assert.equal(owner.stopping, true);
  assert.throws(() => owner.start(process.execPath, ["-e", "process.exit(0)"], env), {
    message: "Development process owner has stopped.",
  });
});

test("stop during a long child settles waitSuccess and refuses the next start", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd(), graceMs: 500 });
  const child = owner.start(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], env);
  const rejected = assert.rejects(owner.waitSuccess(child), /Development process exited/);
  await owner.stop();
  await rejected;
  assert.equal(owner.stopping, true);
  assert.throws(() => owner.start(process.execPath, ["-e", "process.exit(0)"], env), /has stopped/);
});

test("ignored SIGTERM escalates to SIGKILL after the child is ready", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-dev-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const readyPath = join(directory, "ready");
  const owner = new DevProcessOwner({ cwd: process.cwd(), graceMs: 200 });
  const script = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `fs.writeFileSync(${JSON.stringify(readyPath)}, '1');`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = owner.start(process.execPath, ["-e", script], env);
  t.after(() => owner.stop());
  const rejected = assert.rejects(owner.waitSuccess(child), /Development process exited/);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(readyPath);
      break;
    } catch {
      await delay(20);
    }
  }
  await access(readyPath);
  await owner.stop();
  await rejected;
  assert.equal(child.signalCode, "SIGKILL");
});

test("undelivered SIGTERM rejects stop and does not claim cleanup finished", async () => {
  const owner = new DevProcessOwner({
    cwd: process.cwd(),
    graceMs: 50,
    createChild: () => hangingFakeChild(() => false),
  });
  owner.start("ignored", [], env);
  await assert.rejects(owner.stop(), { message: "Development process SIGTERM was not delivered." });
  const again = owner.stop();
  await assert.rejects(again, /SIGTERM was not delivered/);
  assert.equal(again, owner.stop());
});

test("SIGTERM throw rejects stop unless the child already settled", async () => {
  const owner = new DevProcessOwner({
    cwd: process.cwd(),
    graceMs: 50,
    createChild: () =>
      hangingFakeChild(() => {
        throw new Error("kill boom");
      }),
  });
  owner.start("ignored", [], env);
  await assert.rejects(owner.stop(), { message: "kill boom" });
});

test("kill EPERM on a live pid rejects stop and does not complete the child", async () => {
  const owner = new DevProcessOwner({
    cwd: process.cwd(),
    graceMs: 50,
    createChild: () => {
      const fake = hangingFakeChild(() => {
        fake.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
        return false;
      });
      Object.defineProperty(fake, "pid", { configurable: true, value: 12345 });
      return fake;
    },
  });
  const child = owner.start("ignored", [], env);
  let waitSettled = false;
  void owner.waitSuccess(child).then(
    () => {
      waitSettled = true;
    },
    () => {
      waitSettled = true;
    },
  );
  await assert.rejects(owner.stop(), /SIGTERM was not delivered/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waitSettled, false);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

// Independent acceptance: exercise cleanup after an actual missing executable and signal failure.
test("stop immediately after spawn ENOENT settles without an exit event", async () => {
  const owner = new DevProcessOwner({ cwd: process.cwd() });
  const child = owner.start("/no/such/openbot-dev-process-binary", [], env);
  const rejected = assert.rejects(owner.waitSuccess(child), { code: "ENOENT" });
  await owner.stop();
  await rejected;
});

test("a failed stop still waits for the other owned Node child", async () => {
  const { spawn } = await import("node:child_process");
  const failed = hangingFakeChild(() => false);
  const owner = new DevProcessOwner({
    cwd: process.cwd(),
    graceMs: 200,
    createChild: (command, args, options) =>
      command === "failed" ? failed : spawn(command, args, options),
  });
  owner.start("failed", [], env);
  const real = owner.start(process.execPath, ["-e", "setInterval(()=>{},1000)"], env);
  await assert.rejects(owner.stop(), /SIGTERM was not delivered/);
  assert.notEqual(real.signalCode, null);
});

test("settled termination releases the default grace timer", () => {
  const source = `import { DevProcessOwner } from ${JSON.stringify(new URL("./dev-processes.ts", import.meta.url).href)};
const owner = new DevProcessOwner({cwd:process.cwd()});
owner.start(process.execPath, ['-e','setInterval(()=>{},1000)'], process.env);
await owner.stop();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 5000,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, "stop resolved but its 12s timer kept Node running");
  assert.equal(result.status, 0, result.stderr);
});
