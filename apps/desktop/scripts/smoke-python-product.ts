import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  transcriptionSettingsSchema,
  workspacePrimaryBotSchema,
  workspaceSnapshotSchema,
} from "@openbot/protocol";
import {
  confirmProcessesStopped,
  launchThroughDisposableParent,
  loadDesktopModules,
} from "./python-product-probe.ts";

const desktopDist = fileURLToPath(new URL("../dist/", import.meta.url));

export async function smokePythonProduct(runtimeRoot: string) {
  const { NativeServerController, launchDesktopProductServer } =
    await loadDesktopModules(desktopDist);
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-python-candidate-smoke-")));
  const dataRoot = join(root, "local-server");
  let cookie: string | undefined;
  let base: string | undefined;
  let testParentExit = false;
  let bootstrapPassword: string | undefined;
  let changedPassword: string | undefined;
  let productIds: readonly number[] = [];
  const tsSelected = await lstat(join(runtimeRoot, "ts-control.json"))
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const problems: string[] = [];
  const diagnostics = channel("openbot.desktop.native-startup");
  // Do not collect child stderr, bootstrap data or any submitted credential.
  const observer = (value: unknown) => {
    const error = value && typeof value === "object" && "error" in value ? value.error : undefined;
    problems.push(error instanceof Error ? error.message : "Native startup failed.");
  };
  diagnostics.subscribe(observer);
  const authenticate = async (url: string, password: string) => {
    bootstrapPassword ??= password;
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(((await health.json()) as { phase: unknown }).phase, "python-product-candidate");
    const result = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ password: changedPassword ?? password }),
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
    launchServer: async (env) => {
      const managed = await (testParentExit
        ? launchThroughDisposableParent(runtimeRoot, desktopDist, env)
        : launchDesktopProductServer(runtimeRoot, env));
      productIds = managed.processIds;
      assert.equal(productIds.length, tsSelected ? 2 : 1);
      return managed;
    },
    connect: authenticate,
    authenticate,
  });
  try {
    assert.equal((await controller.start()).status, "ready", problems.join("; "));
    assert.ok(base && cookie);
    const readSettings = async () => {
      const response = await fetch(`${base}/api/v1/settings/transcription`, {
        headers: { Cookie: cookie! },
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(response.status, 200);
      return transcriptionSettingsSchema.parse(await response.json());
    };
    const firstSettings = await readSettings();
    const firstPort = new URL(base).port;
    const headers = { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
    const readPrimary = async () => {
      const response = await fetch(`${base}/api/v1/workspace`, {
        headers: { Cookie: cookie! },
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(response.status, 200);
      const snapshot = workspaceSnapshotSchema.parse(await response.json());
      return { primaryBotId: snapshot.primaryBotId, revision: snapshot.revision };
    };
    const botResponse = await fetch(`${base}/api/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Native primary fixture", role: "assistant" }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(botResponse.status, 201);
    const primaryBefore = await readPrimary();
    assert(primaryBefore.primaryBotId);
    const primarySave = await fetch(`${base}/api/v1/workspace/primary-bot`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ botId: null, expectedRevision: primaryBefore.revision }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(primarySave.status, 200);
    const primarySaved = workspacePrimaryBotSchema.parse(await primarySave.json());
    assert.deepEqual(primarySaved, { primaryBotId: null, revision: primaryBefore.revision + 1 });

    const created = await fetch(`${base}/api/v1/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Python Desktop synthetic", botIds: [] }),
    });
    assert.equal(created.status, 201);
    const channelId = ((await created.json()) as { channel: { id: unknown } }).channel.id;
    const bootstrap = await readFile(join(dataRoot, "bootstrap.json"));
    const key = await readFile(join(dataRoot, "model-connections.key"));
    assert.equal(key.length, 32);
    assert.equal((await lstat(join(dataRoot, "model-connections.key"))).mode & 0o077, 0);
    const processId = Number(
      (await readFile(join(dataRoot, "postgres/postmaster.pid"), "utf8")).split("\n")[0],
    );
    if (tsSelected) {
      changedPassword = `Synthetic-native-${randomBytes(24).toString("hex")}`;
      const changed = await fetch(`${base}/api/v1/auth/password`, {
        method: "POST",
        headers,
        body: JSON.stringify({ currentPassword: bootstrapPassword, newPassword: changedPassword }),
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(changed.status, 200);
      assert.deepEqual(await changed.json(), { changed: true, reauthenticationRequired: true });
      const expired = await fetch(`${base}/api/v1/auth/session`, { headers: { Cookie: cookie } });
      assert.deepEqual(await expired.json(), { authenticated: false });
    }
    await controller.stop();
    assert.equal(controller.getState().status, "idle");
    await confirmProcessesStopped(productIds);
    assert.throws(() => process.kill(processId, 0));
    await assert.rejects(
      fetch(`http://127.0.0.1:${firstPort}/health`, { signal: AbortSignal.timeout(1000) }),
    );
    testParentExit = true;
    assert.equal((await controller.start()).status, "ready", problems.join("; "));
    assert.deepEqual(await readFile(join(dataRoot, "bootstrap.json")), bootstrap);
    assert.deepEqual(await readFile(join(dataRoot, "model-connections.key")), key);
    const channels = await fetch(`${base}/api/v1/channels`, { headers: { Cookie: cookie } });
    assert.ok(
      ((await channels.json()) as { channels: { id: unknown }[] }).channels.some(
        (value: { id: unknown }) => value.id === channelId,
      ),
    );
    assert.deepEqual(await readSettings(), firstSettings);
    assert.deepEqual(await readPrimary(), primarySaved);
    const nodes = await fetch(`${base}/api/v1/nodes`, { headers: { Cookie: cookie } });
    assert.equal(nodes.status, 200);
    assert.deepEqual(((await nodes.json()) as { nodes: unknown }).nodes, []);
    const plugins = await fetch(`${base}/api/v1/plugins`, { headers: { Cookie: cookie } });
    assert.equal(plugins.status, 200);
    const restartedPostgres = Number(
      (await readFile(join(dataRoot, "postgres/postmaster.pid"), "utf8")).split("\n")[0],
    );
    await controller.stop();
    assert.throws(() => process.kill(restartedPostgres, 0));
    testParentExit = false;
    if (tsSelected) {
      // These are PIDs returned by this launch, never discovered from another profile.
      for (const victim of [0, 1]) {
        assert.equal((await controller.start()).status, "ready", problems.join("; "));
        process.kill(productIds[victim]!, "SIGKILL");
        await confirmProcessesStopped(productIds);
        assert.equal(controller.getState().status, "failed");
        await controller.stop();
        await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), {
          code: "ENOENT",
        });
      }
    }
    for (const name of ["browser.json", "command.json"]) {
      // A present execution configuration without Temporal must refuse API-only fallback.
      await writeFile(join(dataRoot, name), "{}", { mode: 0o600 });
      assert.equal((await controller.start()).status, "failed");
      await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
      await controller.stop();
      await rm(join(dataRoot, name));
    }
    // A poisoned new artifact directory must fail before the API, then release PostgreSQL.
    await rm(join(dataRoot, "objects/work-artifacts"), { recursive: true });
    await symlink(root, join(dataRoot, "objects/work-artifacts"));
    assert.equal((await controller.start()).status, "failed");
    await assert.rejects(readFile(join(dataRoot, "postgres/postmaster.pid")), { code: "ENOENT" });
    return {
      parentEofStoppedActualApi: true,
      parentEofStoppedOwnedProcessCount: tsSelected ? 2 : 1,
      tsForwardingEntry: tsSelected,
      transcriptionReadRestartVerified: true,
      tsReadGroup: tsSelected ? "transcription" : "none",
      primaryBotWriteRestartVerified: true,
      tsWriteGroup: tsSelected ? "primary-bot" : "none",
      tsAuthGroup: tsSelected ? "owner" : "none",
      passwordRotationRestartVerified: tsSelected,
      restartLoginUsedChangedPassword: tsSelected,
      eitherProductExitStoppedPair: tsSelected,
      unsafeDirectoryRefusedAndPostgresStopped: true,
      executionConfigurationWithoutEngineRefusedAndPostgresStopped: true,
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
  if (process.argv.length !== 3 || !process.argv[2])
    throw new Error("Usage: smoke-python-product <candidate-native-runtime>");
  console.log(JSON.stringify(await smokePythonProduct(resolve(process.argv[2]))));
}
