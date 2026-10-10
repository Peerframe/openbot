/** Qualifies one Server lifecycle and fail-closed package selection without changing profile ownership. */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  prepare: vi.fn(),
  preflight: vi.fn(),
  configuration: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./server-bootstrap.js", async (original) => ({
  ...(await original<typeof import("./server-bootstrap.js")>()),
  preparePrivateDirectories: mocks.prepare,
  fixedProcess: mocks.preflight,
  productConfigurationEnvironment: mocks.configuration,
}));

import { TemporalUnavailableError } from "./server-bootstrap.js";
import { TS_CANDIDATE } from "./ts-product-manifest.js";
import {
  launchDesktopProductServer,
  launchTsProductServer,
  selectsTsProduct,
} from "./ts-server.js";

const directories: string[] = [];
const resources = [
  "desktop/product-migrate.mjs",
  "apps/web/dist/index.html",
  "node/bin/node",
  "apps/server/dist/desktop-entry.js",
  "apps/server/dist/app.js",
  "apps/server/dist/work-installation.js",
  "deploy/server/legacy-work-preflight.ts",
  "deploy/server/prepare-product.ts",
  "apps/server/dist/work-service.js",
  "apps/server/dist/work-runtime.js",
  "apps/server/dist/work-command.js",
  "apps/server/dist/worker-runtime.js",
  "packages/work/dist/workflows.js",
  "node_modules/@temporalio/worker/package.json",
  "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin/index.node",
  "node_modules/jose/package.json",
  "node_modules/canonicalize/package.json",

  "apps/server/dist/tls.js",
  "apps/server/dist/transcription-read.js",
  "apps/server/dist/primary-bot-write.js",
  "apps/server/dist/write-input.js",
  "apps/server/dist/owner-auth.js",
  "apps/server/dist/owner-auth-crypto.js",
  "apps/server/dist/owner-auth-store.js",
  "apps/server/dist/owner-transaction.js",
  "apps/server/dist/product-http.js",
  "apps/server/dist/database-fence.js",
  "apps/server/dist/product-workspace.js",
  "apps/server/dist/product-events.js",
  "apps/server/dist/product-nodes.js",
  "apps/server/dist/product-browser.js",
  "apps/server/dist/employee-portability.js",
  "apps/server/dist/employee-publisher.js",
  "apps/server/dist/employee-knowledge.js",
  "apps/server/dist/employee-records.js",
  "apps/server/dist/employee-source-lock.js",
  "apps/server/dist/identity-create.js",
  "apps/server/dist/identity-lifecycle.js",
  "apps/server/dist/bot-greeting.js",
  "apps/server/dist/greeting-network.js",
  "apps/server/dist/greeting-text.js",
  "apps/server/dist/product-plugins.js",
  "apps/server/dist/plugin-store.js",
  "apps/server/dist/plugin-transport.js",
  "apps/server/dist/owner-files.js",
  "apps/server/dist/attachment-processing.js",
  "apps/server/dist/attachment-parser.js",
  "apps/server/dist/attachment-transcription.js",
  "apps/server/dist/storage-service.js",
  "apps/server/dist/storage-usage.js",
  "apps/server/dist/product-approvals.js",
  "apps/server/dist/product-automations.js",
  "apps/server/dist/plugin_catalog.json",
  "apps/server/dist/parser-worker.js",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/entities/package.json",
  "packages/employee-publisher/dist/employee-package.js",
  "apps/server/dist/product-identity.js",
  "apps/server/dist/model-connections.js",
  "apps/server/dist/model-network.js",
  "apps/server/dist/model-credential-cipher.js",
  "apps/server/dist/posix-files.js",
  "node_modules/koffi/package.json",
  "node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node",
  "node_modules/openai/package.json",
  "node_modules/@anthropic-ai/sdk/package.json",
  "apps/server/dist/channel-read.js",
  "apps/server/dist/channel-read-query.js",
  "apps/server/dist/channel-read-projection.js",
  "node_modules/postgres/package.json",
  "node_modules/fastify/package.json",
  "node_modules/@fastify/static/package.json",
];
beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.preflight.mockReset().mockResolvedValue(undefined);
  // These are lifecycle tests with a simulated macOS payload on every CI host. The real
  // POSIX ownership/file checks are covered by server-bootstrap tests and native qualification.
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
  return { root, env, order, child };
}

it("refuses absent, malformed, symlink or unmatched package selection before launch", async () => {
  const f = await fixture();
  await rm(join(f.root, "ts-control.json"));
  expect(await selectsTsProduct(f.root)).toBe(false);
  await expect(launchDesktopProductServer(f.root, f.env)).rejects.toThrow("not selected");
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
    { ...TS_CANDIDATE, format: "openbot.desktop.ts-control/v8" },
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
  await symlink(join(f.root, "temporal.json"), join(f.root, "ts-control.json"));
  await expect(selectsTsProduct(f.root)).rejects.toThrow("manifest");
  expect(mocks.preflight).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("runs migration before the sole Server with an explicit environment and stops exactly once", async () => {
  const f = await fixture();
  const managed = await launchDesktopProductServer(f.root, f.env);
  expect(mocks.preflight).toHaveBeenCalledOnce();
  expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.spawn.mock.invocationCallOrder[0]!,
  );
  const [executable, args, options] = mocks.spawn.mock.calls[0]!;
  expect(executable).toBe(join(f.root, "node/bin/node"));
  expect(args).toEqual([join(f.root, "apps/server/dist/desktop-entry.js")]);
  expect(options.env).toEqual({
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENBOT_TS_WORK_FILE_ROOT: join(f.root, "objects/work-artifacts"),
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: join(f.root, "temporal.json"),
    OPENBOT_TS_OBJECT_ROOT: join(f.root, "objects"),
    OPENBOT_TS_ARTIFACT_ROOT: join(f.root, "objects/work-artifacts"),
    OPENBOT_TS_PLUGIN_STORE_PATH: join(f.root, "objects/plugins/state.json"),
    OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS: "[]",
    OPENBOT_TS_PARSER_WORKER_PATH: join(f.root, "apps/server/dist/parser-worker.js"),
    OPENBOT_TS_NODE_MODULE_ROOT: join(f.root, "node_modules"),
    OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(f.root, "model-connections.key"),
    OPENBOT_TS_OWNER_PASSWORD: f.env.OPENBOT_OWNER_PASSWORD,
    OPENBOT_TS_AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_WRITE_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_READ_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_TS_DATABASE_URL: f.env.OPENBOT_DATABASE_URL,
    OPENBOT_TS_HOST: "127.0.0.1",
    OPENBOT_CONTROL_WEB_ROOT: join(f.root, "apps/web/dist"),
    OPENBOT_TS_PORT: "39001",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:39001",
  });
  expect(options.stdio).toEqual(["pipe", "ignore", "ignore"]);
  expect(managed.isAlive()).toBe(true);
  await Promise.all([managed.stop(), managed.stop()]);
  expect(f.order).toEqual(["ts"]);
  expect(managed.processIds).toEqual([f.child.pid]);
  expect(managed.isAlive()).toBe(false);
});

it("records unexpected Server termination without retry", async () => {
  const f = await fixture();
  const managed = await launchTsProductServer(f.root, f.env);
  f.child.emit("close", 1);
  await managed.stop();
  expect(managed.isAlive()).toBe(false);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.preflight).toHaveBeenCalledOnce();
});

// Each missing resource exercises the full file preflight. Windows CI performs roughly 80
// removal/check/restore cycles here; this bound covers fixture I/O, not a product deadline.
it("refuses incomplete resources before migration and surfaces a Server spawn failure", async () => {
  const f = await fixture();
  for (const resource of resources) {
    await rm(join(f.root, resource));
    await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow();
    expect(mocks.preflight).not.toHaveBeenCalled();
    await writeFile(join(f.root, resource), "synthetic");
  }
  mocks.spawn.mockImplementation(() => {
    throw new Error("synthetic spawn failure");
  });
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow("spawn failure");
  expect(mocks.preflight).toHaveBeenCalledOnce();
}, 15_000);

it("refuses missing engine configuration before migration or Server startup", async () => {
  const f = await fixture();
  mocks.configuration.mockResolvedValue({});
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow("Server requires");
  expect(mocks.preflight).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("propagates execution configuration refusal before migration or a product writer starts", async () => {
  const f = await fixture();
  mocks.configuration.mockRejectedValue(new Error("Private configuration refused"));
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow(
    "Private configuration refused",
  );
  expect(mocks.preflight).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("never starts the Server after a migration preflight failure", async () => {
  const f = await fixture();
  mocks.preflight.mockRejectedValue(new Error("migration refused"));
  await expect(launchTsProductServer(f.root, f.env)).rejects.toThrow("migration refused");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("retains a Temporal outage from preflight without starting the Server", async () => {
  const f = await fixture();
  mocks.preflight.mockRejectedValue(new TemporalUnavailableError());
  await expect(launchTsProductServer(f.root, f.env)).rejects.toBeInstanceOf(
    TemporalUnavailableError,
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("recognizes only the fixed Server exit code after its connection fails", async () => {
  const f = await fixture();
  vi.mocked(fetch).mockImplementation(async () => {
    f.child.emit("close", 75);
    throw new Error("not listening");
  });
  await expect(launchTsProductServer(f.root, f.env)).rejects.toBeInstanceOf(
    TemporalUnavailableError,
  );
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(f.child.kill).not.toHaveBeenCalled();
});
