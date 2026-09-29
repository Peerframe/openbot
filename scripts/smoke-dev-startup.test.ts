import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./smoke-dev-startup.ts", import.meta.url));
const refusal =
  /Use a loopback PostgreSQL URL without query parameters and a database ending _dev_smoke\./;

// Every refusal must happen before the port probe, database query or `npm run dev` child.
function runSmoke(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 30_000,
  });
}

test("the entry requires npm and an explicit disposable database", () => {
  const withoutNpm = runSmoke({
    OPENBOT_DEV_SMOKE_DATABASE_URL: "postgres://127.0.0.1:1/openbot_dev_smoke",
  });
  assert.equal(withoutNpm.status, 1);
  assert.match(withoutNpm.stderr, /Run this check through npm run dev:smoke\./);
  for (const url of [undefined, ""]) {
    const missing = runSmoke({
      npm_execpath: "/nonexistent/npm-cli.js",
      ...(url === undefined ? {} : { OPENBOT_DEV_SMOKE_DATABASE_URL: url }),
    });
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /OPENBOT_DEV_SMOKE_DATABASE_URL must name a disposable database\./,
    );
  }
});

test("remote, misnamed or parameterized databases are refused before startup", () => {
  for (const url of [
    "postgres://db.example.test/openbot_dev_smoke",
    "postgres://0.0.0.0/openbot_dev_smoke",
    "postgres://127.0.0.2/openbot_dev_smoke",
    "mysql://127.0.0.1/openbot_dev_smoke",
    "postgres://127.0.0.1/openbot",
    "postgres://127.0.0.1/Openbot_dev_smoke",
    "postgres://127.0.0.1/openbot_dev_smoke/extra",
    "postgres://127.0.0.1/openbot_dev_smoke?sslmode=disable",
    "postgres://127.0.0.1/openbot_dev_smoke#fragment",
  ]) {
    const result = runSmoke({
      npm_execpath: "/nonexistent/npm-cli.js",
      OPENBOT_DEV_SMOKE_DATABASE_URL: url,
    });
    assert.equal(result.status, 1, url);
    assert.match(result.stderr, refusal, url);
    assert.doesNotMatch(result.stderr, /prebuilt npm package|without local \.env|EADDRINUSE/, url);
  }
});
