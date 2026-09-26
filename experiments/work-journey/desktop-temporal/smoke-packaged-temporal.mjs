import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedConfiguration, observeBundledPollers, parseArguments } from "./probe-support.mjs";

// Adapted from the existing MIT OpenBot smoke; production controller/launcher remain unchanged.
async function desktopModules(desktopDist) {
  const controller = await import(pathToFileURL(join(desktopDist, "native-server.js")).href);
  const launcher = await import(pathToFileURL(join(desktopDist, "python-server.js")).href);
  return {
    NativeServerController: controller.NativeServerController,
    launchPythonProductServer: launcher.launchPythonProductServer,
  };
}

// A disposable launcher parent is killed to test the real API's inherited pipe EOF.
async function launchThroughDisposableParent(runtimeRoot, desktopDist, env) {
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
      parent.send({ runtimeRoot, desktopDist, env });
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

export async function smokePackagedTemporal({ runtimeRoot, desktopDist, temporalConfigPath }) {
  const privateConfig = await isolatedConfiguration(temporalConfigPath);
  const { NativeServerController, launchPythonProductServer } = await desktopModules(desktopDist);
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-python-temporal-smoke-")));
  const dataRoot = join(root, "local-server");
  let cookie;
  let base;
  let testParentExit = false;
  let stage = "prepare";
  let attemptedPort;
  let ownerLogins = 0;
  let diagnosticsCount = 0;
  const pollerObservations = [];
  const diagnostics = channel("openbot.desktop.native-startup");
  // Do not collect child stderr, bootstrap data or any submitted credential.
  const observer = () => {
    diagnosticsCount += 1;
  };
  diagnostics.subscribe(observer);
  const authenticate = async (url, password) => {
    const health = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    assert.equal(health.status, 200);
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
    ownerLogins += 1;
  };
  const controller = new NativeServerController({
    runtimeRoot,
    dataRoot,
    platform: process.platform,
    // Synthetic fixture only. Real Desktop keeps its existing safeStorage callbacks.
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString(),
    launchServer: (source) => {
      attemptedPort = source.OPENBOT_PORT;
      const env = { ...source };
      // A probe does not acquire unrelated accounts or local endpoints from the invoking shell.
      delete env.TAVILY_API_KEY;
      delete env.OPENBOT_PLUGIN_LOCAL_ENDPOINTS;
      return testParentExit
        ? launchThroughDisposableParent(runtimeRoot, desktopDist, env)
        : launchPythonProductServer(runtimeRoot, env);
    },
    connect: authenticate,
    authenticate,
  });
  const startConnected = async (label) => {
    const startedAt = Date.now();
    stage = `${label}-launch`;
    assert.equal((await controller.start()).status, "ready", "Packaged product startup failed.");
    stage = `${label}-fresh-pollers`;
    pollerObservations.push(
      await observeBundledPollers(runtimeRoot, join(dataRoot, "temporal.json"), startedAt),
    );
    stage = `${label}-health`;
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).phase, "python-product-candidate");
  };
  const stopped = async (pid, port) => {
    await controller.stop();
    assert.equal(controller.getState().status, "idle");
    assert.throws(() => process.kill(pid, 0));
    await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
    );
  };
  try {
    await mkdir(dataRoot, { mode: 0o700 });
    await writeFile(join(dataRoot, "temporal.json"), privateConfig, { mode: 0o600, flag: "wx" });
    await startConnected("initial");
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
    stage = "normal-stop";
    await stopped(processId, firstPort);
    testParentExit = true;
    await startConnected("restart");
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
    stage = "parent-eof-stop";
    await stopped(restartedPostgres, new URL(base).port);
    testParentExit = false;
    stage = "invalid-private-config";
    // This passes the Node ownership/size preflight, then fails Python's real config schema.
    await writeFile(join(dataRoot, "temporal.json"), '{"invalid_probe_configuration":true}', {
      mode: 0o600,
    });
    const priorLogins = ownerLogins;
    assert.equal((await controller.start()).status, "failed");
    assert.equal(ownerLogins, priorLogins);
    await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
    await assert.rejects(
      fetch(`http://127.0.0.1:${attemptedPort}/health`, { signal: AbortSignal.timeout(1000) }),
    );
    await controller.stop();
    await writeFile(join(dataRoot, "temporal.json"), privateConfig, { mode: 0o600 });
    stage = "unsafe-directory";
    // A poisoned new artifact directory must fail before the API, then release PostgreSQL.
    testParentExit = false;
    await rm(join(dataRoot, "objects/work-artifacts"), { recursive: true });
    await symlink(root, join(dataRoot, "objects/work-artifacts"));
    assert.equal((await controller.start()).status, "failed");
    await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
    return {
      format: "openbot.desktop.packaged-temporal-smoke/v1",
      connectedStarts: pollerObservations.length,
      pollerObservations,
      invalidPrivateConfigRefusedAndPostgresStopped: true,
      isolatedQueue: true,
      originalLauncherUsed: true,
      diagnosticEvents: diagnosticsCount,
      fullInferenceVerified: false,
      workflowReplayVerified: false,
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
  } catch {
    throw new Error(`Packaged Temporal smoke failed during ${stage}.`);
  } finally {
    await controller.stop();
    diagnostics.unsubscribe(observer);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--parent-child" && process.send) {
    process.once("message", async ({ runtimeRoot, desktopDist, env }) => {
      try {
        const { launchPythonProductServer } = await desktopModules(desktopDist);
        await launchPythonProductServer(runtimeRoot, env);
        process.send({ ready: true });
      } catch {
        process.send({ ready: false });
        process.exitCode = 1;
        process.disconnect();
      }
    });
  } else {
    try {
      console.log(
        JSON.stringify(await smokePackagedTemporal(parseArguments(process.argv.slice(2)))),
      );
    } catch (error) {
      // Error objects from product/RPC/files never reach the terminal.
      const message = /^Packaged Temporal smoke failed during [a-z-]+\.$/u.test(error.message)
        ? error.message
        : "Packaged Temporal smoke input or setup failed.";
      console.log(JSON.stringify({ ok: false, message }));
      process.exitCode = 1;
    }
  }
}
