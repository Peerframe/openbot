/** Keeps retired container preflight/order failures executable against the single TS entry. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  events: [] as string[],
  migrationFailure: false,
  drainFailure: false,
  options: undefined as unknown,
}));
vi.mock("../packages/db/dist/index.js", () => ({
  createDatabase() {
    calls.events.push("database");
    return {
      async migrate() {
        calls.events.push("migrate");
        if (calls.migrationFailure) throw new Error("private-dsn");
      },
      async close() {
        calls.events.push("close-database");
      },
    };
  },
}));
vi.mock("../deploy/server/legacy-work-preflight.ts", () => ({
  async verifyLegacyWorkPreflight() {
    calls.events.push("legacy-drain");
    if (calls.drainFailure) throw new Error("private-history");
  },
}));
vi.mock("../apps/server/dist/lifetime.js", () => ({
  async runEntry(options: unknown) {
    calls.events.push("server");
    calls.options = options;
    return options;
  },
}));
import { entryOptions } from "../apps/server/dist/config.js";
import { startProduct } from "../deploy/server/product-entry.ts";
let directory: string, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  calls.events.length = 0;
  calls.migrationFailure = false;
  calls.drainFailure = false;
  directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-product-entry-")));
  for (const name of ["objects", "artifacts"]) await mkdir(join(directory, name), { mode: 0o700 });
  const temporal = join(directory, "temporal.json");
  await writeFile(
    temporal,
    JSON.stringify({
      temporal_address: "127.0.0.1:7233",
      namespace: "synthetic",
      queue: "synthetic",
      tls: {
        ca: join(directory, "ca"),
        certificate: join(directory, "crt"),
        key: join(directory, "key"),
        server_name: "synthetic.internal",
      },
    }),
    { mode: 0o600 },
  );
  env = {
    OPENBOT_TS_DATABASE_URL: "postgres://127.0.0.1/unused",
    OPENBOT_TS_OWNER_PASSWORD: "synthetic-container-owner-password",
    OPENBOT_TS_PUBLIC_ORIGIN: "http://127.0.0.1:3001",
    OPENBOT_TS_PORT: "3001",
    OPENBOT_TS_HOST: "127.0.0.1",
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: temporal,
    OPENBOT_TS_OBJECT_ROOT: join(directory, "objects"),
    OPENBOT_TS_ARTIFACT_ROOT: join(directory, "artifacts"),
    OPENBOT_TS_WORK_FILE_ROOT: join(directory, "artifacts"),
    OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(directory, "model.key"),
  };
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
for (const [key, value] of [
  ["OPENBOT_TS_DATABASE_URL", ""],
  ["OPENBOT_TS_HOST", ""],
  ["OPENBOT_TS_HOST", "localhost"],
  ["OPENBOT_TS_HOST", "::"],
  ["OPENBOT_TS_OWNER_PASSWORD", ""],
  ["OPENBOT_TS_OWNER_PASSWORD", "short"],
  ["OPENBOT_TS_AUTH_ALLOWED_ORIGINS", "*"],
  ["OPENBOT_TS_AUTH_ALLOWED_ORIGINS", "https://example.invalid/path"],
  ["OPENBOT_TS_PORT", "0"],
  ["OPENBOT_TS_SESSION_TTL_HOURS", "169"],
  ["OPENBOT_TS_READ_GROUP", "none"],
  ["OPENBOT_TS_PYTHON_ORIGIN", "http://127.0.0.1:2"],
  ["OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH", ""],
])
  it(`invalid ${key}=${value} cannot migrate or start a Server`, async () => {
    await assert.rejects(startProduct({ ...env, [key!]: value }), {
      name: "StartupFailure",
      message: "Server startup refused.",
    });
    assert.deepEqual(calls.events, []);
  });
it("environment projection has no ambient proxy, Python, model or arbitrary executable fallback", () => {
  const options = entryOptions({
    ...env,
    HTTPS_PROXY: "private-proxy",
    PYTHONPATH: "untrusted",
    OPENAI_API_KEY: "ambient-key",
    OPENBOT_CONTROL_NODE_EXECUTABLE: "/tmp/untrusted-node",
  });
  const text = JSON.stringify(options);
  for (const secret of ["private-proxy", "untrusted", "ambient-key"])
    assert(!text.includes(secret));
  assert.equal(
    options.product?.files?.parser?.worker.endsWith("/apps/server/dist/parser-worker.js"),
    true,
  );
});
it("storage preflight failure cannot migrate or start a Server", async () => {
  await rm(join(directory, "objects"), { recursive: true });
  await assert.rejects(startProduct(env));
  assert.deepEqual(calls.events, []);
});
it("canonical migration and legacy drain finish before the sole Server starts", async () => {
  await startProduct(env);
  assert.deepEqual(calls.events, [
    "database",
    "migrate",
    "close-database",
    "legacy-drain",
    "server",
  ]);
});
it("migration failure closes the SQL owner and cannot start any API fallback", async () => {
  calls.migrationFailure = true;
  await assert.rejects(startProduct(env));
  assert.deepEqual(calls.events, ["database", "migrate", "close-database"]);
});
it("undrained history refuses the Server after closing the migration database", async () => {
  calls.drainFailure = true;
  await assert.rejects(startProduct(env));
  assert.deepEqual(calls.events, ["database", "migrate", "close-database", "legacy-drain"]);
});

it("container key-file default stays under its explicit object root and never mutates supplied env", async () => {
  const supplied = { ...env };
  delete supplied.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH;
  await startProduct(supplied);
  const value = calls.options as ReturnType<typeof entryOptions>;
  assert.equal(value.product?.models?.keyPath, join(directory, "objects/model-connections.key"));
  assert.equal(supplied.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH, undefined);
  calls.events.length = 0;
  await assert.rejects(startProduct({ ...supplied, OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: "" }));
  assert.deepEqual(calls.events, []);
});
it("an explicit key-file path is preserved", async () => {
  await startProduct(env);
  assert.equal(
    (calls.options as ReturnType<typeof entryOptions>).product?.models?.keyPath,
    env.OPENBOT_TS_MODEL_CONNECTION_KEY_PATH,
  );
});
