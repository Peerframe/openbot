/** Checks complete production configuration and refuses malformed authority before resources start. */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { entryOptions, validateOptions, type EntryOptions } from "./config.js";

const base = { host: "127.0.0.1" as const, port: 3101, publicOrigin: "http://127.0.0.1:3101" };
const database = { databaseUrl: "postgres://127.0.0.1/disposable" };
it("rejects malformed SQL, origins and divergent authority databases for every component", () => {
  for (const key of ["transcriptionRead", "primaryBotWrite", "channelRead"] as const) {
    assert.deepEqual(validateOptions({ ...base, [key]: database })[key], database);
    for (const patch of [{ databaseUrl: "https://db.test" }, { databaseUrl: "" },
      ...["*", "null", "", "https://entry.test/path"].map((v) => ({ allowedOrigins: [v] })), { allowedOrigins: [] }])
      assert.throws(() => validateOptions({ ...base, [key]: { ...database, ...patch } }));
  }
  assert.throws(() => validateOptions({ ...base, channelRead: database, primaryBotWrite: { databaseUrl: "postgres://127.0.0.1/other" } }));
  assert.deepEqual(validateOptions({ ...base, transcriptionRead: { ...database, allowedOrigins: [base.publicOrigin, "https://secondary.test"] } }).transcriptionRead?.allowedOrigins,
    [base.publicOrigin, "https://secondary.test"]);
});
it("validates code-point credential bounds, identity, session TTL and listener bounds", () => {
  const auth = { ...database, password: "synthetic-owner-password", ownerName: "Owner", ttlHours: 12 };
  assert(validateOptions({ ...base, ownerAuth: auth }).ownerAuth);
  for (const override of [
    ...["short", "x".repeat(1025), "replace-with-a-long-random-owner-password", "x".repeat(15) + "\ud800"].map((v) => ({ password: v })),
    { ttlHours: 169 }, { ttlHours: 1.5 }, { ttlHours: 0 }, { ownerName: " " }, { ownerName: "😀".repeat(81) },
  ]) assert.throws(() => validateOptions({ ...base, ownerAuth: { ...auth, ...override } }));
  assert(validateOptions({ ...base, ownerAuth: { ...auth, password: "😀".repeat(1024) } }).ownerAuth);
  for (const port of [0, 65536, 1.5]) assert.throws(() => validateOptions({ ...base, port }));
  assert.throws(() => validateOptions({ ...base, host: "0.0.0.0" }));
  assert.throws(() => validateOptions({ ...base, publicOrigin: "https://entry.test" }));
  assert.throws(() => validateOptions({ ...base, unexpected: true } as unknown as EntryOptions));
});
it.skipIf(!process.getuid)("composes every production owner with no selections and refuses obsolete or incomplete inputs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openbot-config-")));
  try {
    const temporal = join(root, "temporal.json");
    writeFileSync(temporal, JSON.stringify({ temporal_address: "127.0.0.1:7233", namespace: "default", queue: "fixture",
      tls: { ca: join(root, "ca.pem"), certificate: join(root, "client.pem"), key: join(root, "client.key"), server_name: "temporal.test" },
    }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {
      OPENBOT_TS_PUBLIC_ORIGIN: base.publicOrigin, OPENBOT_TS_DATABASE_URL: database.databaseUrl,
      OPENBOT_TS_OWNER_PASSWORD: "synthetic-owner-password", OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: temporal,
      OPENBOT_TS_WORK_FILE_ROOT: join(root, "artifacts"), OPENBOT_TS_OBJECT_ROOT: join(root, "objects"),
      OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: join(root, "model.key"),
    };
    const value = entryOptions(env);
    for (const key of ["ownerAuth", "primaryBotWrite", "transcriptionRead", "channelRead", "product"] as const)
      assert.equal(value[key]?.databaseUrl, database.databaseUrl);
    assert(value.product?.work && value.product.workerRuntime && value.product.controlReads);
    assert.equal(value.ownerAuth?.ttlHours, 12);
    for (const key of Object.keys(env)) assert.throws(() => entryOptions({ ...env, [key]: undefined }), key);
    for (const [key, bad] of [
      ["OPENBOT_TS_READ_GROUP", "none"], ["OPENBOT_TS_WORK_GROUP", "reports"], ["OPENBOT_TS_PYTHON_ORIGIN", "http://127.0.0.1:2"],
      ["OPENBOT_TS_PORT", "1.0"], ["OPENBOT_TS_SESSION_TTL_HOURS", "1.5"], ["OPENBOT_CONTROL_WORK_TOKEN_LIMIT", "1e5"],
      ["OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS", "["], ["OPENBOT_TS_MODEL_CUSTOM_BASE_URLS", "{}"],
      ["OPENBOT_TS_READ_ALLOWED_ORIGINS", "*"], ["OPENBOT_TS_AUTH_ALLOWED_ORIGINS", ""],
      ["OPENBOT_TS_TLS_CERT_PATH", join(root, "server.pem")], ["OPENBOT_CONTROL_PUBLISHER_DIRECTORY", root],
      ["OPENBOT_TS_HOST", "localhost"],
    ]) assert.throws(() => entryOptions({ ...env, [key!]: bad }), key);
    assert.equal(entryOptions({ ...env, OPENBOT_CONTROL_WORK_TOKEN_LIMIT: "0" }).product?.work?.tokenLimit, 0);
    assert.equal(entryOptions({ ...env, OPENBOT_TS_PUBLIC_ORIGIN: "https://entry.test", OPENBOT_TS_TLS_CERT_PATH: join(root, "server.pem"), OPENBOT_TS_TLS_KEY_PATH: join(root, "server.key") }).tls?.privateKeyPath, join(root, "server.key"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
