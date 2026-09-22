import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertFreshCheckout,
  assertPortFree,
  isolatedEnvironment,
  readRetainedIdentity,
  redact,
  startProcess,
  validateDatabaseUrl,
} from "./smoke-dev-fixture.mjs";

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-smoke-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("accepts only an explicitly disposable single-host loopback database", () => {
  assert.equal(
    validateDatabaseUrl("postgres://fixture:synthetic@127.0.0.1:5533/demo_dev_smoke").hostname,
    "127.0.0.1",
  );
  for (const value of [
    "postgres://fixture:synthetic@example.com/demo_dev_smoke",
    "postgres://fixture:synthetic@127.0.0.1/real",
    "postgres://fixture:synthetic@127.0.0.1/demo_dev_smoke?sslmode=disable",
    "postgres://fixture:synthetic@127.0.0.1/demo_dev_smoke#x",
    "https://127.0.0.1/demo_dev_smoke",
  ])
    assert.throws(() => validateDatabaseUrl(value));
});

test("refuses private dotenv and prior build output without deleting them", async (t) => {
  const root = await temporary(t);
  for (const directory of ["apps/web", "packages/test", "providers/test"])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, ".env.example"), "synthetic example");
  await assertFreshCheckout(root);
  await writeFile(join(root, ".env.local"), "PRIVATE_VALUE=keep");
  await assert.rejects(assertFreshCheckout(root), /without local .env/);
  await rm(join(root, ".env.local"));
  await mkdir(join(root, "packages/test/dist"));
  await assert.rejects(assertFreshCheckout(root), /Existing build output is never deleted/);
});

test("child environment excludes model credentials, user configuration and bootstrap identity", () => {
  const env = isolatedEnvironment({
    directory: "/tmp/fixture",
    npmCli: "/runtime/npm/bin/npm-cli.js",
    source: {
      PATH: "/runtime/bin",
      OPENAI_API_KEY: "private",
      ANTHROPIC_API_KEY: "private",
      OPENBOT_DATABASE_URL: "private",
      OPENBOT_NODE_ENROLLMENT_TOKEN: "private",
      OPENBOT_NODE_CREDENTIAL: "private",
      HOME: "/private/profile",
      NODE_OPTIONS: "--require=private",
      npm_config_userconfig: "/private/npmrc",
    },
  });
  assert.equal(env.npm_config_userconfig, "/dev/null");
  assert.equal(env.TMPDIR, "/tmp/fixture");
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENBOT_DATABASE_URL",
    "OPENBOT_NODE_ENROLLMENT_TOKEN",
    "OPENBOT_NODE_CREDENTIAL",
    "HOME",
    "NODE_OPTIONS",
  ])
    assert.equal(env[key], undefined);
});

test("diagnostics redact raw cookies, URLs and credential values even when overlapping", () => {
  const secrets = new Set([
    "token",
    "cookie=token",
    "postgres://fixture:pass@127.0.0.1/test",
    "pass",
  ]);
  const result = redact(
    "cookie=token\npostgres://fixture:pass@127.0.0.1/test\ncredential token pass",
    secrets,
  );
  for (const secret of secrets) assert.equal(result.includes(secret), false);
});

test("retained identity requires a private regular bounded file and preserves exact bytes", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, "identity.json");
  const content = {
    format: "openbot.node-identity/v1",
    nodeId: "fixture-node",
    credential: "synthetic-only",
    enrolledAt: "2026-09-22T00:00:00.000Z",
  };
  await writeFile(path, JSON.stringify(content), { mode: 0o600 });
  const first = await readRetainedIdentity(path, "fixture-node");
  assert.equal((await readRetainedIdentity(path, "fixture-node")).digest, first.digest);
  await assert.rejects(readRetainedIdentity(path, "other-node"), /expected identity/);
  await chmod(path, 0o644);
  await assert.rejects(readRetainedIdentity(path, "fixture-node"), /remain private/);
  await chmod(path, 0o600);
  const link = join(directory, "link.json");
  await symlink(path, link);
  await assert.rejects(readRetainedIdentity(link, "fixture-node"), /regular file/);
  await writeFile(path, "x".repeat(4097));
  await assert.rejects(readRetainedIdentity(path, "fixture-node"), /bounded regular/);
});

test("occupied development ports fail without disturbing their owner", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "::", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(assertPortFree(server.address().port), /occupied or unavailable/);
  assert.equal(server.listening, true);
});

test("process cleanup removes its group and preserves an unrelated process", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await temporary(t);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => unrelated.kill());
  const child = startProcess({
    args: ["-e", "console.log('ready');setInterval(() => {}, 1000)"],
    cwd: directory,
    env: { PATH: process.env.PATH },
    label: "synthetic fixture",
  });
  t.after(() => child.stop());
  for (let i = 0; i < 50 && !child.output().includes("ready"); i++) await delay(20);
  child.assertRunning();
  await child.stop({ graceMs: 500 });
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  await child.stop();
});
