/** Qualifies one native bootstrap lifetime while dependencies wait, resume or are cancelled. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ stop: vi.fn(async () => {}), start: vi.fn() }));
vi.mock("./darwin-postgres.js", () => ({ startDarwinPostgres: native.start }));
vi.mock("postgres", () => ({
  default: () => Object.assign(async () => [], { end: async () => {} }),
}));

import { NativeServerController, type NativeStartupContext } from "./native-server.js";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-native-wait-"));
  directories.push(root);
  const runtimeRoot = join(root, "runtime"),
    dataRoot = join(root, "data");
  await mkdir(join(runtimeRoot, "postgres/bin"), { recursive: true });
  for (const path of ["postgres/bin/initdb", "postgres/bin/postgres", "postgres-supervisor"])
    await writeFile(join(runtimeRoot, path), "fixture");
  await mkdir(join(dataRoot, "postgres"), { recursive: true, mode: 0o700 });
  await writeFile(join(dataRoot, "postgres/PG_VERSION"), "17");
  const secrets = JSON.stringify({
    databasePassword: "a".repeat(64),
    ownerPassword: "b".repeat(64),
  });
  await writeFile(
    join(dataRoot, "bootstrap.json"),
    JSON.stringify(Buffer.from(secrets).toString("base64")),
    { mode: 0o600 },
  );
  native.start.mockResolvedValue({ isAlive: () => true, stop: native.stop });
  let starting: NativeStartupContext | undefined;
  const server = { isAlive: () => true, stop: vi.fn(async () => {}) };
  const launch = vi.fn(async (_env: Record<string, string>, context: NativeStartupContext) => {
    starting = context;
    context.waiting("docker_unavailable", true);
    await context.waitForRetry();
    context.signal.throwIfAborted();
    return server;
  });
  const connect = vi.fn(async () => {});
  const controller = new NativeServerController({
    runtimeRoot,
    dataRoot,
    platform: "darwin",
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString(),
    launchServer: launch,
    connect,
    authenticate: connect,
  });
  return { controller, launch, server, connect, starting: () => starting };
}
it.skipIf(process.platform === "win32")(
  "retry wakes the same bootstrap and authenticates exactly once",
  async () => {
    const f = await fixture();
    const pending = f.controller.start();
    await vi.waitFor(() =>
      expect(f.controller.getState()).toMatchObject({
        status: "waiting",
        reason: "docker_unavailable",
      }),
    );
    expect(f.controller.start()).toBe(pending);
    expect((await pending).status).toBe("ready");
    expect(f.launch).toHaveBeenCalledOnce();
    expect(native.start).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
    await f.controller.stop();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(f.server.stop).toHaveBeenCalledOnce();
  },
);
it.skipIf(process.platform === "win32")(
  "quit cancels a waiting startup before retry and stops only its database",
  async () => {
    const f = await fixture();
    const pending = f.controller.start();
    await vi.waitFor(() => expect(f.controller.getState().status).toBe("waiting"));
    await f.controller.stop();
    await pending;
    expect(f.starting()?.signal.aborted).toBe(true);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.connect).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toMatchObject({ status: "idle" });
  },
);
