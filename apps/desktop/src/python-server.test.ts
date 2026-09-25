import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  launchPythonProductServer,
  pythonProductEnvironment,
  pythonProductTemporalEnvironment,
  selectsPythonProduct,
} from "./python-server.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "openbot-python-desktop-test-"));
  directories.push(path);
  return realpath(path);
}
function input(dataRoot: string) {
  return {
    OPENBOT_HOST: "127.0.0.1",
    OPENBOT_PORT: "39001",
    OPENBOT_DATABASE_URL: "postgres://synthetic:synthetic-password@127.0.0.1:35432/postgres",
    OPENBOT_OWNER_PASSWORD: "synthetic-owner-password",
    OPENBOT_ALLOWED_ORIGINS: "http://127.0.0.1:39001",
    OPENBOT_MODEL_ENCRYPTION_KEY: "a".repeat(64),
    OPENBOT_MODEL_SETTINGS_PATH: join(dataRoot, "model-settings.json"),
    OPENBOT_OBJECT_STORE_PATH: join(dataRoot, "objects"),
  };
}
it("retains PostgreSQL, object/plugin paths and the encrypted bootstrap key without inheriting shell secrets", async () => {
  const directory = await temporary();
  const env = pythonProductEnvironment(directory, {
    ...input(directory),
    OPENAI_API_KEY: "unrelated",
    PYTHONPATH: "untrusted",
    NODE_OPTIONS: "--inspect",
    OPENBOT_CONTROL_AUTHORITY: "read-only",
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: "/untrusted/control.json",
    OPENBOT_DESKTOP_TEMPORAL_CONFIG_PATH: "/untrusted/desktop.json",
    TEMPORAL_ADDRESS: "untrusted.example:7233",
    OPENBOT_PLUGIN_LOCAL_ENDPOINTS: " http://127.0.0.1:34321/mcp, http://[::1]:34322/mcp ",
  });
  expect(env.OPENBOT_CONTROL_AUTHORITY).toBe("product");
  expect(env.OPENBOT_CONTROL_COOKIE_MODE).toBe("loopback");
  expect(env.OPENBOT_CONTROL_DATABASE_URL).toBe(input(directory).OPENBOT_DATABASE_URL);
  expect(env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH).toBe(join(directory, "model-settings.json"));
  expect(env.OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY).toBe("a".repeat(64));
  expect(env.OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH).toBe(
    join(directory, "model-connections.key"),
  );
  expect(env.OPENBOT_CONTROL_PLUGIN_STORE_PATH).toBe(join(directory, "objects/plugins/state.json"));
  expect(JSON.parse(env.OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS as string)).toEqual([
    "http://127.0.0.1:34321/mcp",
    "http://[::1]:34322/mcp",
  ]);
  for (const name of [
    "OPENAI_API_KEY",
    "PYTHONPATH",
    "NODE_OPTIONS",
    "OPENBOT_CONTROL_MODEL_DIRECTORY",
    "OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH",
    "OPENBOT_DESKTOP_TEMPORAL_CONFIG_PATH",
    "TEMPORAL_ADDRESS",
    "OPENBOT_MODEL_ENCRYPTION_KEY",
    "OPENBOT_DATABASE_URL",
  ])
    expect(env[name]).toBeUndefined();
});
it("preserves only the Tavily selection already supplied by the trusted Desktop launcher", async () => {
  const directory = await temporary();
  const env = pythonProductEnvironment(directory, {
    ...input(directory),
    TAVILY_API_KEY: "synthetic-explicit-desktop-search",
  });
  expect(env.TAVILY_API_KEY).toBe("synthetic-explicit-desktop-search");
});
it.each([
  { OPENBOT_HOST: "0.0.0.0" },
  { OPENBOT_PORT: "0" },
  { OPENBOT_PORT: "65536" },
  { OPENBOT_DATABASE_URL: "postgres://user:secret@example.com:5432/postgres" },
  { OPENBOT_DATABASE_URL: "sqlite:///tmp/state.db" },
  { OPENBOT_ALLOWED_ORIGINS: "*" },
  { OPENBOT_OWNER_PASSWORD: "short" },
  { OPENBOT_MODEL_ENCRYPTION_KEY: "invalid" },
  { OPENBOT_MODEL_SETTINGS_PATH: "relative" },
  { OPENBOT_PLUGIN_LOCAL_ENDPOINTS: "invalid URL" },
  { OPENBOT_PLUGIN_LOCAL_ENDPOINTS: Array(17).fill("http://127.0.0.1/mcp").join(",") },
])("rejects invalid bootstrap mapping", async (changes) => {
  const directory = await temporary();
  expect(() => pythonProductEnvironment(directory, { ...input(directory), ...changes })).toThrow();
});
it("keeps default selection unchanged and refuses launch without the opt-in manifest", async () => {
  const directory = await temporary();
  expect(await selectsPythonProduct(directory)).toBe(false);
  await expect(launchPythonProductServer(directory, input(directory))).rejects.toThrow(
    "not selected",
  );
});
it("rejects symlink and malformed selection resources", async () => {
  const directory = await temporary();
  await mkdir(join(directory, "outside"));
  await writeFile(join(directory, "outside/marker"), "{}");
  await symlink(join(directory, "outside/marker"), join(directory, "python-control.json"));
  await expect(selectsPythonProduct(directory)).rejects.toThrow("manifest");
  await rm(join(directory, "python-control.json"));
  await writeFile(
    join(directory, "python-control.json"),
    JSON.stringify({
      format: "openbot.desktop.python-control/v1",
      backend: "python-product",
      pythonVersion: "3.12.13",
      platform: "darwin",
      arch: "arm64",
      extra: true,
    }),
  );
  await expect(selectsPythonProduct(directory)).rejects.toThrow("reviewed platform");
});

it("keeps API-only startup without the fixed private Temporal file", async () => {
  const directory = await temporary();
  const env = pythonProductEnvironment(directory, input(directory));
  await expect(pythonProductTemporalEnvironment(env)).resolves.toEqual({});
});

it("maps only the fixed private Temporal file, leaving content and mTLS validation to Python", async () => {
  const directory = await temporary();
  const path = join(directory, "temporal.json");
  await writeFile(path, '{"synthetic":"not yet a valid engine configuration"}', { mode: 0o600 });
  const env = pythonProductEnvironment(directory, input(directory));
  expect(await pythonProductTemporalEnvironment(env)).toEqual({
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: path,
  });
  expect(env.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH).toBeUndefined();
});

it.each(["symlink", "dangling", "directory", "empty", "oversized", "public"])(
  "refuses an unsafe present Temporal entry: %s",
  async (kind) => {
    const directory = await temporary();
    const path = join(directory, "temporal.json");
    if (kind === "directory") await mkdir(path);
    else if (kind === "dangling") await symlink(join(directory, "missing"), path);
    else if (kind === "symlink") {
      const target = join(directory, "elsewhere.json");
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, path);
    } else {
      await writeFile(
        path,
        kind === "empty" ? "" : kind === "oversized" ? "x".repeat(16385) : "{}",
        {
          mode: 0o600,
        },
      );
      if (kind === "public") await chmod(path, 0o644);
    }
    const env = pythonProductEnvironment(directory, input(directory));
    await expect(pythonProductTemporalEnvironment(env)).rejects.toThrow("private owned file");
  },
);

it("rejects another file owner even when permissions are private", async () => {
  const directory = await temporary();
  await writeFile(join(directory, "temporal.json"), "{}", { mode: 0o600 });
  const owner = process.getuid?.();
  if (owner === undefined) throw new Error("This candidate requires POSIX file ownership.");
  vi.spyOn(process, "getuid")
    .mockReturnValueOnce(owner)
    .mockReturnValue(owner + 1);
  const env = pythonProductEnvironment(directory, input(directory));
  await expect(pythonProductTemporalEnvironment(env)).rejects.toThrow("private owned file");
});

it("rejects a public or noncanonical app-data directory instead of selecting another path", async () => {
  const directory = await temporary();
  const data = join(directory, "data");
  await mkdir(data, { mode: 0o700 });
  await writeFile(join(data, "temporal.json"), "{}", { mode: 0o600 });
  const alias = join(directory, "alias");
  await symlink(data, alias);
  await expect(
    pythonProductTemporalEnvironment(pythonProductEnvironment(directory, input(alias))),
  ).rejects.toThrow("directory must be private");
  await chmod(data, 0o755);
  await expect(
    pythonProductTemporalEnvironment(pythonProductEnvironment(directory, input(data))),
  ).rejects.toThrow("directory must be private");
});

it("does not cache prior Temporal file admission", async () => {
  const directory = await temporary();
  const env = pythonProductEnvironment(directory, input(directory));
  const path = join(directory, "temporal.json");
  await writeFile(path, "{}", { mode: 0o600 });
  await expect(pythonProductTemporalEnvironment(env)).resolves.toHaveProperty(
    "OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH",
    path,
  );
  await chmod(path, 0o644);
  await expect(pythonProductTemporalEnvironment(env)).rejects.toThrow("private owned file");
  await rm(path);
  await expect(pythonProductTemporalEnvironment(env)).resolves.toEqual({});
});
