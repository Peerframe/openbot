import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { lstat, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeServerController } from "../dist/native-server.js";
import { launchPythonProductServer } from "../dist/python-server.js";

// A disposable launcher parent is killed to test the real API's inherited pipe EOF.
async function launchThroughDisposableParent(runtimeRoot, env) {
  const parent = fork(fileURLToPath(import.meta.url), ["--parent-child"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let alive = true;
  const closed = new Promise((resolve) =>
    parent.once("close", () => {
      alive = false;
      resolve();
    }),
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Disposable candidate parent timed out.")),
        90_000,
      );
      parent.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Disposable parent failed."));
      });
      parent.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Disposable parent exited."));
      });
      parent.once("message", (message) => {
        clearTimeout(timer);
        message?.ready === true ? resolve() : reject(new Error("Disposable API failed."));
      });
      parent.send({ runtimeRoot, env });
    });
  } catch (error) {
    parent.kill("SIGKILL");
    await closed;
    throw error;
  }
  return {
    isAlive: () => alive,
    async stop() {
      parent.kill("SIGKILL");
      await closed;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          await fetch(`http://127.0.0.1:${env.OPENBOT_PORT}/health`, {
            signal: AbortSignal.timeout(500),
          });
        } catch {
          return;
        }
        await delay(100);
      }
      throw new Error("Python API survived its disposable parent.");
    },
  };
}

export async function smokePythonProduct(runtimeRoot) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-python-candidate-smoke-")));
  const dataRoot = join(root, "local-server");
  let cookie;
  let base;
  let testParentExit = false;
  const problems = [];
  const diagnostics = channel("openbot.desktop.native-startup");
  // Do not collect child stderr, bootstrap data or any submitted credential.
  const observer = (value) => problems.push(value?.error?.message ?? "Native startup failed.");
  diagnostics.subscribe(observer);
  const authenticate = async (url, password) => {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal((await health.json()).phase, "python-product-candidate");
    const result = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 200);
    cookie = result.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("openbot_session="));
    base = url;
  };
  const controller = new NativeServerController({
    runtimeRoot,
    dataRoot,
    platform: process.platform,
    // Synthetic fixture only. Real Desktop keeps its existing safeStorage callbacks.
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString(),
    launchServer: (env) =>
      testParentExit
        ? launchThroughDisposableParent(runtimeRoot, env)
        : launchPythonProductServer(runtimeRoot, env),
    connect: authenticate,
    authenticate,
  });
  try {
    assert.equal((await controller.start()).status, "ready", problems.join("; "));
    const firstPort = new URL(base).port;
    const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
    const created = await fetch(`${base}/api/v1/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Python Desktop synthetic", botIds: [] }),
    });
    assert.equal(created.status, 201);
    const channelId = (await created.json()).channel.id;
    const bootstrap = await readFile(join(dataRoot, "bootstrap.json"));
    const key = await readFile(join(dataRoot, "model-connections.key"));
    assert.equal(key.length, 32);
    assert.equal((await lstat(join(dataRoot, "model-connections.key"))).mode & 0o077, 0);
    const processId = Number(
      (await readFile(join(dataRoot, "postgres/postmaster.pid"), "utf8")).split("\n")[0],
    );
    await controller.stop();
    assert.equal(controller.getState().status, "idle");
    assert.throws(() => process.kill(processId, 0));
    await assert.rejects(
      fetch(`http://127.0.0.1:${firstPort}/health`, { signal: AbortSignal.timeout(1000) }),
    );
    testParentExit = true;
    assert.equal((await controller.start()).status, "ready", problems.join("; "));
    assert.deepEqual(await readFile(join(dataRoot, "bootstrap.json")), bootstrap);
    assert.deepEqual(await readFile(join(dataRoot, "model-connections.key")), key);
    const channels = await fetch(`${base}/api/v1/channels`, { headers: { Cookie: cookie } });
    assert.ok((await channels.json()).channels.some((value) => value.id === channelId));
    const nodes = await fetch(`${base}/api/v1/nodes`, { headers: { Cookie: cookie } });
    assert.equal(nodes.status, 200);
    assert.deepEqual((await nodes.json()).nodes, []);
    const plugins = await fetch(`${base}/api/v1/plugins`, { headers: { Cookie: cookie } });
    assert.equal(plugins.status, 200);
    const restartedPostgres = Number(
      (await readFile(join(dataRoot, "postgres/postmaster.pid"), "utf8")).split("\n")[0],
    );
    await controller.stop();
    assert.throws(() => process.kill(restartedPostgres, 0));
    // A poisoned new artifact directory must fail before the API, then release PostgreSQL.
    testParentExit = false;
    await rm(join(dataRoot, "objects/work-artifacts"), { recursive: true });
    await symlink(root, join(dataRoot, "objects/work-artifacts"));
    assert.equal((await controller.start()).status, "failed");
    await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
    return {
      parentEofStoppedActualApi: true,
      unsafeDirectoryRefusedAndPostgresStopped: true,
      pythonProductHealth: true,
      ownerLogin: true,
      postgresInitialized: true,
      restartPreservedData: true,
      serverAndPostgresStopped: true,
      syntheticOnly: true,
      nativeKeychainVerified: false,
    };
  } finally {
    await controller.stop();
    diagnostics.unsubscribe(observer);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--parent-child" && process.send) {
    process.once("message", async ({ runtimeRoot, env }) => {
      try {
        await launchPythonProductServer(runtimeRoot, env);
        process.send({ ready: true });
      } catch {
        process.send({ ready: false });
        process.exitCode = 1;
        process.disconnect();
      }
    });
  } else {
    if (process.argv.length !== 3)
      throw new Error("Usage: smoke-python-product <candidate-native-runtime>");
    console.log(JSON.stringify(await smokePythonProduct(resolve(process.argv[2]))));
  }
}
