import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  allowlistedEnvironment,
  CONTROL_POSTGRES_IMAGE,
  createControlDatabase,
  OwnedDockerFixture,
  readWorkerTests,
  startControlPostgres,
  writePrivateFixture,
} from "./python-acceptance-fixture.ts";

const password = "0123456789abcdef".repeat(3);

// A recording stand-in for the Docker CLI; behavior is selected per test through its environment.
async function fakeDocker(t: TestContext, env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-fake-docker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const log = join(directory, "calls.log");
  await writeFile(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  info) echo 27.0.0 ;;
  create) if [ "$FAKE_DOCKER_FAIL" = create ]; then exit 1; fi ;;
  port) echo "$FAKE_DOCKER_BINDING" ;;
  exec) if [ "$FAKE_DOCKER_FAIL" = ready ] && [ "$3" = pg_isready ]; then exit 2; fi ;;
  rm|image) if [ "$FAKE_DOCKER_FAIL" = remove ]; then exit 1; fi ;;
esac
exit 0
`,
  );
  await chmod(docker, 0o700);
  const fixture = new OwnedDockerFixture(
    directory,
    {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_BINDING: "127.0.0.1:49153",
      ...env,
    },
    docker,
  );
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0);
  return { fixture, calls };
}

test("the container is owned after create, bound to loopback and removed exactly once", async (t) => {
  const { fixture, calls } = await fakeDocker(t);
  const dsn = await startControlPostgres(fixture, "openbot-control-test", password);
  assert.equal(
    dsn,
    `postgres://openbot_test:${password}@127.0.0.1:49153/openbot_control_test_reference`,
  );
  const started = await calls();
  assert.equal(started[0], "info --format {{.ServerVersion}}");
  assert.equal(
    started[1],
    [
      "create --name openbot-control-test --publish 127.0.0.1::5432",
      `--env POSTGRES_USER=openbot_test --env POSTGRES_PASSWORD=${password}`,
      "--env POSTGRES_DB=openbot_control_test_reference --tmpfs /var/lib/postgresql/data",
      `${CONTROL_POSTGRES_IMAGE} -c client_min_messages=warning`,
    ].join(" "),
  );
  assert.match(CONTROL_POSTGRES_IMAGE, /^postgres:17\.11-bookworm@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(started.slice(2), [
    "start openbot-control-test",
    "port openbot-control-test 5432/tcp",
    "exec openbot-control-test pg_isready -h 127.0.0.1 -U openbot_test -d openbot_control_test_reference",
  ]);
  fixture.cleanup();
  fixture.cleanup();
  assert.deepEqual((await calls()).slice(started.length), ["rm --force openbot-control-test"]);
});

test("a non-loopback published port is refused and the created container is still removed", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_BINDING: "0.0.0.0:49153" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    name: "AssertionError",
  });
  assert(!(await calls()).some((call) => call.includes("pg_isready")));
  fixture.cleanup();
  assert.equal((await calls()).at(-1), "rm --force openbot-control-test");
});

test("a failed create owns nothing and withholds command output", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "create" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /\/docker fixture command failed\.$/);
    assert(!error.message.includes(password));
    return true;
  });
  fixture.cleanup();
  assert(!(await calls()).some((call) => call.startsWith("rm ")));
});

test("PostgreSQL that never accepts connections fails after the bounded wait", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "ready" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    message: "Owned PostgreSQL did not become ready.",
  });
  assert.equal((await calls()).filter((call) => call.includes("pg_isready")).length, 60);
  fixture.cleanup();
  assert.equal((await calls()).at(-1), "rm --force openbot-control-test");
});

test("containers are removed before images and failed removal is reported by name", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "remove" });
  fixture.own("image", "openbot-python-acceptance:abc");
  fixture.own("container", "openbot-python-test-abc");
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errors.push(message);
  });
  fixture.cleanup();
  fixture.cleanup();
  assert.deepEqual(await calls(), [
    "rm --force openbot-python-test-abc",
    "image rm openbot-python-acceptance:abc",
  ]);
  assert.deepEqual(errors, [
    "Could not remove owned fixture openbot-python-test-abc.",
    "Could not remove owned fixture image openbot-python-acceptance:abc.",
  ]);
});

test("model and command databases are separate databases in the same owned container", async (t) => {
  const { fixture, calls } = await fakeDocker(t);
  const dsn = await startControlPostgres(fixture, "openbot-control-test", password);
  const model = createControlDatabase(
    fixture,
    "openbot-control-test",
    dsn,
    "openbot_control_test_model_connections",
  );
  const command = createControlDatabase(
    fixture,
    "openbot-control-test",
    dsn,
    "openbot_control_test_commands",
  );
  assert.equal(new URL(model).pathname, "/openbot_control_test_model_connections");
  assert.equal(new URL(command).pathname, "/openbot_control_test_commands");
  assert.equal(new URL(model).host, new URL(dsn).host);
  assert.equal(new URL(command).password, password);
  assert.deepEqual((await calls()).slice(-2), [
    "exec openbot-control-test createdb --username=openbot_test --no-password --template=template0 openbot_control_test_model_connections",
    "exec openbot-control-test createdb --username=openbot_test --no-password --template=template0 openbot_control_test_commands",
  ]);
  fixture.cleanup();
});

test("fixture children receive only allowlisted variables that are present", () => {
  assert.deepEqual(
    allowlistedEnvironment(["PATH", "HOME", "DOCKER_HOST"], {
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      OPENBOT_CONTROL_OWNER_PASSWORD: "must-not-leak",
      DEEPSEEK_API_KEY: "must-not-leak",
    }),
    { PATH: "/usr/bin", DOCKER_HOST: "unix:///tmp/docker.sock" },
  );
});

test("fixture descriptors are created owner-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-private-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "reference.json");
  await writePrivateFixture(path, { dsn: "synthetic", token: "synthetic" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), '{"dsn":"synthetic","token":"synthetic"}');
});

test("Worker test discovery refuses blank, duplicate and missing entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openbot-worker-tests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "apps/server-python");
  await mkdir(join(base, "tests"), { recursive: true });
  await mkdir(join(root, "deploy/server"), { recursive: true });
  await writeFile(join(base, "tests/test_one.py"), "");
  await writeFile(join(root, "deploy/server/test_two.py"), "");
  const list = join(base, "worker-tests.txt");
  await writeFile(list, "tests/test_one.py\n../../deploy/server/test_two.py\n");
  assert.deepEqual(await readWorkerTests(root), [
    "tests/test_one.py",
    "../../deploy/server/test_two.py",
  ]);
  await writeFile(list, "tests/test_one.py\ntests/test_one.py\n");
  await assert.rejects(readWorkerTests(root), /^AssertionError.*Duplicate Worker test path\./);
  await writeFile(list, "tests/test_one.py\ntests/test_missing.py\n");
  await assert.rejects(readWorkerTests(root), {
    message: "Missing Worker test: tests/test_missing.py",
  });
  for (const content of ["", "\n", "tests/test_one.py\n\ntests/test_one.py\n"]) {
    await writeFile(list, content);
    await assert.rejects(readWorkerTests(root), { name: "AssertionError" });
  }
});

test("termination signals run owned cleanup and keep conventional exit statuses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-fixture-signal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = new URL("./python-acceptance-fixture.ts", import.meta.url).href;
  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const marker = join(directory, signal);
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFileSync } from "node:fs";
import { cleanupOnTerminationSignals } from ${JSON.stringify(helper)};
cleanupOnTerminationSignals(() => writeFileSync(${JSON.stringify(marker)}, "cleaned"));
setInterval(() => {}, 1000);
process.kill(process.pid, ${JSON.stringify(signal)});`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, status, child.stderr);
    assert.equal(await readFile(marker, "utf8"), "cleaned");
  }
});
