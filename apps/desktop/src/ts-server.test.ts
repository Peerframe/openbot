import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), python: vi.fn(), configuration: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./python-server.js", async (original) => ({
  ...(await original<typeof import("./python-server.js")>()),
  launchPythonProductServer: mocks.python,
  pythonProductConfigurationEnvironment: mocks.configuration,
}));

import * as native from "./native-server.js";
import { TS_CANDIDATE } from "./ts-product-manifest.js";
import {
  launchDesktopProductServer,
  launchTsProductServer,
  selectsTsProduct,
} from "./ts-server.js";

const directories: string[] = [];
const resources = [
  "node/bin/node",
  "apps/server-ts/dist/desktop-entry.js",
  "apps/server-ts/dist/app.js",
  "apps/server-ts/dist/work-installation.js",
  "apps/server-ts/dist/work-python-drain.js",
  "apps/server-ts/dist/work-service.js",
  "apps/server-ts/dist/work-runtime.js",
  "apps/server-ts/dist/work-command.js",
  "apps/server-ts/dist/worker-runtime.js",
  "packages/work/dist/workflows.js",
  "node_modules/@temporalio/worker/package.json",
  "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin/index.node",
  "node_modules/jose/package.json",
  "node_modules/canonicalize/package.json",

  "apps/server-ts/dist/tls.js",
  "apps/server-ts/dist/transcription-read.js",
  "apps/server-ts/dist/primary-bot-write.js",
  "apps/server-ts/dist/write-input.js",
  "apps/server-ts/dist/owner-auth.js",
  "apps/server-ts/dist/owner-auth-crypto.js",
  "apps/server-ts/dist/owner-auth-store.js",
  "apps/server-ts/dist/owner-transaction.js",
  "apps/server-ts/dist/product-http.js",
  "apps/server-ts/dist/runtime-port.js",
  "apps/server-ts/dist/database-fence.js",
  "apps/server-ts/dist/product-workspace.js",
  "apps/server-ts/dist/product-events.js",
  "apps/server-ts/dist/product-nodes.js",
  "apps/server-ts/dist/product-browser.js",
  "apps/server-ts/dist/employee-portability.js",
  "apps/server-ts/dist/employee-publisher.js",
  "apps/server-ts/dist/employee-knowledge.js",
  "apps/server-ts/dist/employee-records.js",
  "apps/server-ts/dist/employee-source-lock.js",
  "apps/server-ts/dist/identity-create.js",
  "apps/server-ts/dist/identity-lifecycle.js",
  "apps/server-ts/dist/bot-greeting.js",
  "apps/server-ts/dist/greeting-network.js",
  "apps/server-ts/dist/greeting-text.js",
  "apps/server-ts/dist/product-plugins.js",
  "apps/server-ts/dist/plugin-store.js",
  "apps/server-ts/dist/plugin-transport.js",
  "apps/server-ts/dist/owner-files.js",
  "apps/server-ts/dist/attachment-processing.js",
  "apps/server-ts/dist/attachment-parser.js",
  "apps/server-ts/dist/attachment-transcription.js",
  "apps/server-ts/dist/storage-service.js",
  "apps/server-ts/dist/storage-usage.js",
  "apps/server-ts/dist/product-approvals.js",
  "apps/server-ts/dist/product-automations.js",
  "apps/server-ts/dist/plugin_catalog.json",
  "apps/server-python/src/openbot_server/ts_runtime_port.py",
  "apps/server-python/src/openbot_server/parser_worker.ts",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/entities/package.json",
  "packages/employee-publisher/dist/employee-package.js",
  "apps/server-ts/dist/product-identity.js",
  "apps/server-ts/dist/model-connections.js",
  "apps/server-ts/dist/model-network.js",
  "apps/server-ts/dist/model-credential-cipher.js",
  "apps/server-ts/dist/posix-files.js",
  "node_modules/koffi/package.json",
  "node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node",
  "node_modules/openai/package.json",
  "node_modules/@anthropic-ai/sdk/package.json",
  "apps/server-ts/dist/channel-read.js",
  "apps/server-ts/dist/channel-read-query.js",
  "apps/server-ts/dist/channel-read-projection.js",
  "node_modules/postgres/package.json",
  "node_modules/fastify/package.json",
  "node_modules/@fastify/reply-from/package.json",
];
beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.python.mockReset();
  // These are pairing tests with a simulated macOS payload on every CI host. The real
  // POSIX ownership/file checks are covered by python-server tests and native qualification.
  mocks.configuration.mockReset().mockImplementation(async (env: Record<string, string>) => ({
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: join(
      dirname(env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH!),
      "temporal.json",
    ),
  }));
  vi.stubGlobal(
    "process",
    Object.create(process, {
      platform: { value: "darwin" },
      arch: { value: "arm64" },
    }),
  );
  vi.spyOn(native, "availablePort").mockResolvedValue(39002);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      ok: true,
      service: "openbot-server",
      phase: "typescript-product-candidate",
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openbot-ts-desktop-test-")));
  directories.push(root);
  await writeFile(join(root, "temporal.json"), JSON.stringify({ retainedPrivateFixture: true }), {
    mode: 0o600,
  });
  await writeFile(join(root, "ts-control.json"), JSON.stringify(TS_CANDIDATE));
  await writeFile(
    join(root, "python-control.json"),
    JSON.stringify({
      format: "openbot.desktop.python-control/v1",
      backend: "python-product",
      pythonVersion: "3.12.13",
      platform: "darwin",
      arch: "arm64",
    }),
  );
  for (const path of resources) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "synthetic fixed resource");
  }
  const env = {
    OPENBOT_HOST: "127.0.0.1",
    OPENBOT_PORT: "39001",
    OPENBOT_DATABASE_URL: "postgres://synthetic:synthetic-password@127.0.0.1:35432/postgres",
    OPENBOT_OWNER_PASSWORD: "synthetic-owner-password",
    OPENBOT_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_MODEL_ENCRYPTION_KEY: "a".repeat(64),
    OPENBOT_MODEL_SETTINGS_PATH: join(root, "model-settings.json"),
    OPENBOT_OBJECT_STORE_PATH: join(root, "objects"),
    NODE_OPTIONS: "--inspect",
    OPENAI_API_KEY: "unrelated-secret",
  };
  const order: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 9999999;
  child.stdin = new PassThrough();
  child.stdin.on("finish", () => {
    order.push("ts");
    queueMicrotask(() => child.emit("close", 0));
  });
  child.kill = vi.fn(() => child.emit("close", null, "SIGKILL"));
  mocks.spawn.mockReturnValue(child);
  let alive = true;
  let endPython!: () => void;
  const python = {
    processIds: [9999998],
    isAlive: () => alive,
    closed: new Promise<void>((resolve) => {
      endPython = () => {
        alive = false;
        resolve();
      };
    }),
    stop: vi.fn(async () => {
      order.push("python");
      endPython();
    }),
  };
  mocks.python.mockResolvedValue(python);
  return { root, env, order, child, python, endPython };
}

it("keeps absent selection on Python and refuses malformed, symlink or unmatched TS selection before launch", async () => {
  const f = await fixture();
  await rm(join(f.root, "ts-control.json"));
  expect(await selectsTsProduct(f.root)).toBe(false);
  expect(await launchDesktopProductServer(f.root, f.env)).toBe(f.python);
  mocks.python.mockClear();
  for (const value of [
    {},
    { ...TS_CANDIDATE, extra: true },
    { ...TS_CANDIDATE, fastifyVersion: "5.12.4" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v1" },
    { ...TS_CANDIDATE, writeGroup: "none" },
    { ...TS_CANDIDATE, authGroup: "none" },
    { ...TS_CANDIDATE, productGroup: "none" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v4" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v5" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v6" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v7" },
    { ...TS_CANDIDATE, koffiVersion: "3.3.1" },
    { ...TS_CANDIDATE, openaiVersion: "7.27.0" },
    { ...TS_CANDIDATE, anthropicVersion: "0.130.0" },
    { ...TS_CANDIDATE, channelReadGroup: "none" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v3" },
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v2" },
  ]) {
    await writeFile(join(f.root, "ts-control.json"), JSON.stringify(value));
    await expect(launchDesktopProductServer(f.root, f.env)).rejects.toThrow("composition");
  }
  await rm(join(f.root, "ts-control.json"));
  await symlink(join(f.root, "python-control.json"), join(f.root, "ts-control.json"));
  await expect(selectsTsProduct(f.root)).rejects.toThrow("manifest");
  expect(mocks.python).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("owns one private Python writer and public TS entry, passes only the database and Owner bootstrap credentials to TS, and stops TS first", async () => {
  const f = await fixture();
  const managed = await launchDesktopProductServer(f.root, f.env);
  expect(mocks.python).toHaveBeenCalledExactlyOnceWith(
    f.root,
    f.env,
    39002,
    "transcription",
    "primary-bot",
    "owner",
    "channels",
    "p3",
    "p4",
  );
  const [executable, args, options] = mocks.spawn.mock.calls[0]!;
  expect(executable).toBe(join(f.root, "node/bin/node"));
  expect(args).toEqual([join(f.root, "apps/server-ts/dist/desktop-entry.js")]);
  expect(options.env).toEqual({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENBOT_TS_READ_GROUP: "transcription",
    OPENBOT_TS_WRITE_GROUP: "primary-bot",
    OPENBOT_TS_AUTH_GROUP: "owner",
    OPENBOT_TS_PRODUCT_GROUP: "p3",
    OPENBOT_TS_WORK_GROUP: "p4",
    OPENBOT_TS_WORK_FILE_ROOT: join(f.root, "objects/work-artifacts"),
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: join(f.root, "temporal.json"),
    OPENBOT_TS_OBJECT_ROOT: join(f.root, "objects"),
    OPENBOT_TS_ARTIFACT_ROOT: join(f.root, "objects/work-artifacts"),
    OPENBOT_TS_PLUGIN_STORE_PATH: join(f.root, "objects/plugins/state.json"),
    OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS: "[]",
    OPENBOT_TS_PARSER_WORKER_PATH: join(
      f.root,
      "apps/server-python/src/openbot_server/parser_worker.ts",
    ),
    OPENBOT_TS_NODE_MODULE_ROOT: join(f.root, "node_modules"),
    OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(f.root, "model-connections.key"),
    OPENBOT_TS_CHANNEL_READ_GROUP: "channels",
    OPENBOT_TS_OWNER_PASSWORD: f.env.OPENBOT_OWNER_PASSWORD,
    OPENBOT_TS_AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_WRITE_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_READ_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_DATABASE_URL: f.env.OPENBOT_DATABASE_URL,
    OPENBOT_TS_HOST: "127.0.0.1",
    OPENBOT_TS_PORT: "39001",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:39001",
    OPENBOT_TS_PYTHON_ORIGIN: "http://127.0.0.1:39002",
  });
  expect(options.stdio).toEqual(["pipe", "ignore", "ignore"]);
  expect(managed.isAlive()).toBe(true);
  await Promise.all([managed.stop(), managed.stop()]);
  expect(f.order).toEqual(["ts", "python"]);
  expect(f.python.stop).toHaveBeenCalledOnce();
  expect(managed.isAlive()).toBe(false);
});

it.each(["ts", "python"])("stops the partner when %s terminates without retry", async (which) => {
  const f = await fixture();
  const managed = await launchTsProductServer(f.root, f.env);
  if (which === "ts") f.child.emit("close", 1);
  else f.endPython();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await managed.stop();
  expect(managed.isAlive()).toBe(false);
  expect(f.python.stop).toHaveBeenCalledOnce();
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.python).toHaveBeenCalledOnce();
});

it("refuses incomplete TS resources before starting Python, and releases Python if TS spawn throws", async () => {
  const f = await fixture();
  for (const resource of resources.slice(2)) {
    await rm(join(f.root, resource));
    await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow();
    expect(mocks.python).not.toHaveBeenCalled();
    await writeFile(join(f.root, resource), "synthetic");
  }
  mocks.spawn.mockImplementation(() => {
    throw new Error("synthetic spawn failure");
  });
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow("spawn failure");
  expect(f.python.stop).toHaveBeenCalledOnce();
});

it("refuses missing P4 engine configuration before starting the Python migrator or TS entry", async () => {
  const f = await fixture();
  mocks.configuration.mockResolvedValue({});
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow("P4 requires");
  expect(mocks.python).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("propagates execution configuration refusal before either product process starts", async () => {
  const f = await fixture();
  mocks.configuration.mockRejectedValue(new Error("Private configuration refused"));
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow(
    "Private configuration refused",
  );
  expect(mocks.python).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
