import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { publisherInvocation } from "./employee-publisher-key.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("preserves the original path base without a source directory or argument/env mutation", () => {
  const base = resolve(tmpdir(), "missing", "repo");
  const publicFile = resolve(tmpdir(), "absolute-public.pem");
  const args = [
    "trust",
    "--keyring",
    "./keys",
    "--passphrase-file",
    "../../secret/passphrase",
    "--public-key",
    publicFile,
    "--expected-key-id",
    "ed25519:test",
  ];
  const environment = {
    OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH: "from-env",
    OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE: "../../secret/env",
    UNRELATED: "preserved",
  };
  const value = publisherInvocation(args, environment, base);
  assert.deepEqual(value.args.slice(3), [
    "trust",
    "--keyring",
    join(base, "apps/server/keys"),
    "--passphrase-file",
    join(base, "secret/passphrase"),
    "--public-key",
    publicFile,
    "--expected-key-id",
    "ed25519:test",
  ]);
  assert.equal(
    value.env.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH,
    join(base, "apps/server/from-env"),
  );
  assert.equal(value.env.OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE, join(base, "secret/env"));
  assert.equal(environment.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH, "from-env");
  assert.equal(args[2], "./keys");
  assert.equal(value.cwd, join(base, "packages/employee-publisher"));
});

test("preserves missing options and the original empty/whitespace path resolution", () => {
  const base = resolve(tmpdir(), "missing", "repo");
  for (const args of [
    ["init", "--keyring"],
    ["init", "--keyring", "--passphrase-file"],
  ]) {
    assert.deepEqual(publisherInvocation(args, {}, base).args.slice(3), args);
  }
  assert.equal(
    publisherInvocation(["export-public", "--output", "public.pem"], {}, base).args.at(-1),
    join(base, "apps/server/public.pem"),
  );
  assert.equal(
    publisherInvocation(["status"], { OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH: "" }, base).env
      .OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH,
    join(base, "apps/server"),
  );
  for (const value of ["", "   "])
    assert.equal(
      publisherInvocation(["init", "--keyring", value], {}, base).args.at(-1),
      resolve(base, "apps/server", value),
    );
});

test("real CLI uses only an owned .env/keyring; old Server and oracle directories are absent", {
  timeout: 30000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "openbot-retained-publisher-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, "scripts"));
  await mkdir(join(temporary, "packages"));
  await cp(
    join(root, "scripts/employee-publisher-key.mjs"),
    join(temporary, "scripts/employee-publisher-key.mjs"),
  );
  await cp(
    join(root, "packages/employee-publisher"),
    join(temporary, "packages/employee-publisher"),
    { recursive: true, filter: (path) => !path.split(/[\\/]/).includes("node_modules") },
  );
  await symlink(
    join(root, "node_modules"),
    join(temporary, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await stat(join(root, "packages/employee-publisher/node_modules"));
    await symlink(
      join(root, "packages/employee-publisher/node_modules"),
      join(temporary, "packages/employee-publisher/node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(
    join(temporary, ".env"),
    "OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH=../../keys\nOPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE=../../secret/passphrase\n",
    { mode: 0o600 },
  );
  const environment = Object.fromEntries(
    ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  function cli(args, expected = 0) {
    const result = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "scripts/employee-publisher-key.mjs", ...args],
      { cwd: temporary, env: environment, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, expected, result.stderr);
    assert(!result.stdout.includes("PRIVATE KEY"));
    return result;
  }
  cli(["help"]);
  await assert.rejects(stat(join(temporary, "apps/server")), { code: "ENOENT" });
  const initial = cli(["init"]);
  assert.match(initial.stdout, /ed25519:[a-f0-9]{64}/);
  const keyid = JSON.parse(await readFile(join(temporary, "keys/trust.json"), "utf8")).activeKeyId;
  assert(cli(["status"]).stdout.includes(keyid));
  cli(["export-public", "--output", "../../public.pem"]);
  assert.match(await readFile(join(temporary, "public.pem"), "utf8"), /BEGIN PUBLIC KEY/);
  cli(["export-public", "--output", "../../public.pem"], 1);
  cli(["init"], 1);
  cli(["revoke", "--key-id", keyid], 1);
  cli(["rotate"]);
  cli(["revoke", "--key-id", keyid]);
  assert.equal(
    JSON.parse(await readFile(join(temporary, "keys/trust.json"), "utf8")).keys.find(
      (key) => key.keyid === keyid,
    ).status,
    "revoked",
  );
  await assert.rejects(stat(join(temporary, "apps/server")), { code: "ENOENT" });
  await assert.rejects(stat(join(temporary, "tests/oracles")), { code: "ENOENT" });
});
