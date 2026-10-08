import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), python: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./python-server.js", async (original) => ({
  ...(await original<typeof import("./python-server.js")>()),
  launchPythonProductServer: mocks.python,
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
  "apps/server-ts/dist/tls.js",
  "apps/server-ts/dist/transcription-read.js",
  "apps/server-ts/dist/primary-bot-write.js",
  "apps/server-ts/dist/write-input.js",
  "apps/server-ts/dist/owner-auth.js",
  "apps/server-ts/dist/owner-auth-crypto.js",
  "apps/server-ts/dist/owner-auth-store.js",
  "node_modules/postgres/package.json",
  "node_modules/fastify/package.json",
  "node_modules/@fastify/reply-from/package.json",
];
beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.python.mockReset();
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
      phase: "python-product-candidate",
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
  for (const resource of [resources[2]!, resources[3]!]) {
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
