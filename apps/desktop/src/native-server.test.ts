import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopSearchEnvironment,
  NativeServerController,
  type NativeServerOptions,
  runBounded,
} from "./native-server.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function options(): Promise<NativeServerOptions> {
  const root = await mkdtemp(join(tmpdir(), "openbot-native-test-"));
  dirs.push(root);
  return {
    runtimeRoot: join(root, "runtime"),
    dataRoot: join(root, "data"),
    platform: "darwin",
    encrypt: vi.fn(() => {
      throw new Error("Keychain unavailable");
    }),
    decrypt: vi.fn(),
    launchServer: vi.fn(),
    connect: vi.fn(),
    authenticate: vi.fn(),
  };
}
async function fakeResources(opts: NativeServerOptions) {
  await mkdir(join(opts.runtimeRoot, "postgres/bin"), { recursive: true });
  for (const name of ["postgres", "initdb"])
    await writeFile(join(opts.runtimeRoot, "postgres/bin", name), "not executable");
  await writeFile(join(opts.runtimeRoot, "postgres-supervisor"), "not executable");
}
describe("Native Server boundary", () => {
  it.each(["darwin", "win32"])(
    "remote-only %s leaves retained bootstrap and data untouched",
    async (platform) => {
      const opts = await options();
      await mkdir(join(opts.dataRoot, "postgres"), { recursive: true });
      await writeFile(join(opts.dataRoot, "bootstrap.json"), '"retained ciphertext"');
      await writeFile(join(opts.dataRoot, "postgres/PG_VERSION"), "17");
      const service = new NativeServerController({
        ...opts,
        platform,
        localServiceSupported: false,
      });
      expect(await service.start()).toEqual({ status: "failed", code: "unsupported_platform" });
      expect(await readFile(join(opts.dataRoot, "bootstrap.json"), "utf8")).toBe(
        '"retained ciphertext"',
      );
      expect(await readFile(join(opts.dataRoot, "postgres/PG_VERSION"), "utf8")).toBe("17");
      expect(opts.decrypt).not.toHaveBeenCalled();
      expect(opts.encrypt).not.toHaveBeenCalled();
      expect(opts.launchServer).not.toHaveBeenCalled();
    },
  );
  it("ignores another application's generic search credential", () => {
    expect(desktopSearchEnvironment({ TAVILY_API_KEY: "unrelated-search-fixture" })).toEqual({});
  });
  it("forwards only the explicitly selected Desktop search account", () => {
    const source = {
      TAVILY_API_KEY: "unrelated-search-fixture",
      OPENBOT_DESKTOP_TAVILY_API_KEY: "desktop-search-fixture",
      OPENAI_API_KEY: "unrelated-model-fixture",
    };
    expect(desktopSearchEnvironment(source)).toEqual({ TAVILY_API_KEY: "desktop-search-fixture" });
    expect(source.TAVILY_API_KEY).toBe("unrelated-search-fixture");
  });
  it.each([undefined, "", "   "])("does not configure search for an empty Desktop key", (key) => {
    expect(desktopSearchEnvironment({ OPENBOT_DESKTOP_TAVILY_API_KEY: key })).toEqual({});
  });
  it("bounds native command diagnostics without changing the public failure", async () => {
    const diagnostic = vi.fn();
    const diagnostics = channel("openbot.desktop.native-startup");
    diagnostics.subscribe(diagnostic);
    try {
      await expect(
        runBounded(process.execPath, [
          "-e",
          "process.stderr.write('x'.repeat(20000));process.exitCode=2;",
        ]),
      ).rejects.toThrow("Native operation failed.");
      expect(diagnostic).toHaveBeenCalledWith(
        {
          operation: basename(process.execPath),
          code: 2,
          stderr: "x".repeat(16_384),
        },
        "openbot.desktop.native-startup",
      );
    } finally {
      diagnostics.unsubscribe(diagnostic);
    }
  });
  it.each(["linux", "freebsd"])("does not install on %s", async (platform) => {
    const opts = await options();
    const service = new NativeServerController({ ...opts, platform });
    expect(await service.start()).toEqual({ status: "failed", code: "unsupported_platform" });
    expect(opts.launchServer).not.toHaveBeenCalled();
    expect(opts.encrypt).not.toHaveBeenCalled();
  });
  it("rejects absent resources without creating bootstrap secrets", async () => {
    const opts = await options();
    const service = new NativeServerController(opts);
    const diagnostic = vi.fn();
    const diagnostics = channel("openbot.desktop.native-startup");
    diagnostics.subscribe(diagnostic);
    try {
      expect(await service.start()).toEqual({ status: "failed", code: "installation_failed" });
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { status: "installing", mode: "initialize", step: "checking" },
          error: expect.objectContaining({ code: "ENOENT" }),
        }),
        "openbot.desktop.native-startup",
      );
    } finally {
      diagnostics.unsubscribe(diagnostic);
    }
    expect(opts.encrypt).not.toHaveBeenCalled();
    expect(opts.connect).not.toHaveBeenCalled();
  });
  it("preserves an existing cluster if its bootstrap identity is missing", async () => {
    const opts = await options();
    await fakeResources(opts);
    await mkdir(join(opts.dataRoot, "postgres"), { recursive: true, mode: 0o700 });
    await writeFile(join(opts.dataRoot, "postgres", "do-not-delete"), "retained");
    expect((await new NativeServerController(opts).start()).status).toBe("failed");
    expect(await readFile(join(opts.dataRoot, "postgres", "do-not-delete"), "utf8")).toBe(
      "retained",
    );
    expect(opts.encrypt).not.toHaveBeenCalled();
  });
  it("deduplicates pending installation attempts before inspecting resources", async () => {
    const opts = await options();
    const service = new NativeServerController(opts);
    const first = service.start();
    expect(service.start()).toBe(first);
    expect(await first).toEqual({ status: "failed", code: "installation_failed" });
    expect(opts.encrypt).not.toHaveBeenCalled();
    expect(opts.launchServer).not.toHaveBeenCalled();
  });
  // Native bootstrap requires POSIX ownership/mode evidence before it reaches Keychain.
  // A Windows filesystem cannot satisfy that prerequisite by spoofing options.platform.
  it.skipIf(process.platform === "win32")(
    "never launches when encryption is unavailable",
    async () => {
      const opts = await options();
      await fakeResources(opts);
      const service = new NativeServerController(opts);
      const first = service.start();
      expect(service.start()).toBe(first);
      await first;
      expect(opts.encrypt).toHaveBeenCalledOnce();
      expect(opts.launchServer).not.toHaveBeenCalled();
      await service.stop();
      expect(service.getState()).toEqual({ status: "idle" });
    },
  );
});

it("reports retained installation without decrypting or modifying its bootstrap", async () => {
  const opts = await options();
  await mkdir(join(opts.dataRoot, "postgres"), { recursive: true, mode: 0o700 });
  await writeFile(join(opts.dataRoot, "postgres", "PG_VERSION"), "17");
  await writeFile(join(opts.dataRoot, "bootstrap.json"), "existing encrypted data", {
    mode: 0o600,
  });
  const service = new NativeServerController(opts);
  expect(service.getState()).toEqual({ status: "idle", initialized: true });
  expect(opts.decrypt).not.toHaveBeenCalled();
  expect(opts.encrypt).not.toHaveBeenCalled();
  expect(await readFile(join(opts.dataRoot, "bootstrap.json"), "utf8")).toBe(
    "existing encrypted data",
  );
});
it.skipIf(process.platform === "win32")(
  "classifies denied OS credential access separately without launching a service",
  async () => {
    const opts = await options();
    await fakeResources(opts);
    const service = new NativeServerController(opts);
    expect(await service.start()).toEqual({ status: "failed", code: "credential_unavailable" });
    expect(opts.launchServer).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the controller responsive while credentials are locked and preserves ciphertext on denial",
  async () => {
    const opts = await options();
    await fakeResources(opts);
    await mkdir(join(opts.dataRoot, "postgres"), { recursive: true, mode: 0o700 });
    await writeFile(join(opts.dataRoot, "postgres", "PG_VERSION"), "17");
    const ciphertext = JSON.stringify("a".repeat(64));
    await writeFile(join(opts.dataRoot, "bootstrap.json"), ciphertext, { mode: 0o600 });
    let reject!: (error: Error) => void;
    opts.decrypt = vi.fn(
      () =>
        new Promise<string>((_, fail) => {
          reject = fail;
        }),
    );
    const service = new NativeServerController(opts);
    const pending = service.start();
    await vi.waitFor(() => expect(opts.decrypt).toHaveBeenCalledOnce());
    expect(service.getState()).toEqual({
      status: "installing",
      mode: "resume",
      step: "credentials",
    });
    expect(service.start()).toBe(pending);
    expect(opts.launchServer).not.toHaveBeenCalled();
    reject(new Error("OS access denied"));
    expect(await pending).toEqual({ status: "failed", code: "credential_unavailable" });
    expect(await readFile(join(opts.dataRoot, "bootstrap.json"), "utf8")).toBe(ciphertext);
    expect(opts.encrypt).not.toHaveBeenCalled();
  },
);
