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
const fakeId = "c".repeat(64);

// A recording stand-in for the Docker CLI and one daemon view; behavior is selected per test
// through its environment. A create records the exact name and label the daemon would hold.
async function fakeDocker(t: TestContext, env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-fake-docker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const log = join(directory, "calls.log");
  await writeFile(
    docker,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
const id = ${JSON.stringify(fakeId)};
const fail = env.FAKE_DOCKER_FAIL || "";
fs.appendFileSync(env.FAKE_DOCKER_LOG, args.join(" ") + "\\n");
const option = (flag) => args[args.indexOf(flag) + 1];
const state = () =>
  fs.existsSync(env.FAKE_DOCKER_STATE)
    ? JSON.parse(fs.readFileSync(env.FAKE_DOCKER_STATE, "utf8"))
    : undefined;
const record = (label) =>
  fs.writeFileSync(env.FAKE_DOCKER_STATE, JSON.stringify({ name: option("--name"), label }));
if (args[0] === "info") console.log("27.0.0");
if (args[0] === "create") {
  if (fail === "create") process.exit(1);
  if (fail === "existing") {
    record("openbot.fixture=foreign");
    process.exit(1);
  }
  record(option("--label"));
  if (fail === "lost") process.exit(42);
}
if (args[0] === "port") console.log(env.FAKE_DOCKER_BINDING);
if (args[0] === "exec" && fail === "ready" && args[2] === "pg_isready") process.exit(2);
if (args[0] === "image" && fail === "remove") process.exit(1);
if (args[0] === "container" && args[1] === "ls") {
  if (fail === "lookup") {
    process.stderr.write("synthetic lookup failure\\n");
    process.exit(43);
  }
  const filters = args.filter((_, index) => args[index - 1] === "--filter");
  const current = state();
  if (fail === "ambiguous") console.log(id + "\\n" + "d".repeat(64));
  else if (fail === "malformed") console.log("invalid");
  else if (
    current &&
    filters.includes("name=" + current.name) &&
    filters.includes("label=" + current.label)
  )
    console.log(id);
}
if (args[0] === "container" && args[1] === "inspect") {
  if (fail === "inspect") process.exit(1);
  const current = state();
  const separator = current.label.indexOf("=");
  console.log(JSON.stringify([{
    Id: id,
    Name: fail === "foreign-name" ? "/another-container" : "/" + current.name,
    Config: { Labels: { [current.label.slice(0, separator)]: current.label.slice(separator + 1) } },
  }]));
}
if (args[0] === "container" && args[1] === "rm" && fail === "remove") process.exit(1);
process.exit(0);
`,
  );
  await chmod(docker, 0o700);
  const fixture = new OwnedDockerFixture(
    directory,
    {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_STATE: join(directory, "state.json"),
      FAKE_DOCKER_BINDING: "127.0.0.1:49153",
      ...env,
    },
    docker,
  );
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0);
  return { fixture, calls };
}

/** The fresh label that the actual create command carried. */
function ownershipLabel(createCall: string | undefined): string {
  const label = /--label (openbot\.fixture=python-acceptance-[0-9a-f-]{36}) /.exec(
    createCall ?? "",
  )?.[1];
  assert(label, "create must carry this invocation's fixture label");
  return label;
}

/** Discovery by exact name and label, inspection, then removal by the inspected full ID only. */
function ownedRemoval(name: string, label: string): string[] {
  return [
    `container ls --all --no-trunc --filter name=${name} --filter label=${label} --format {{.ID}}`,
    `container inspect ${fakeId}`,
    `container rm --force ${fakeId}`,
  ];
}

test("the container is reserved before create, bound to loopback and removed exactly once by ID", async (t) => {
  const { fixture, calls } = await fakeDocker(t);
  const dsn = await startControlPostgres(fixture, "openbot-control-test", password);
  assert.equal(
    dsn,
    `postgres://openbot_test:${password}@127.0.0.1:49153/openbot_control_test_reference`,
  );
  const started = await calls();
  assert.equal(started[0], "info --format {{.ServerVersion}}");
  const label = ownershipLabel(started[1]);
  assert.equal(
    started[1],
    [
      `create --name openbot-control-test --label ${label} --publish 127.0.0.1::5432`,
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
  assert.deepEqual(
    (await calls()).slice(started.length),
    ownedRemoval("openbot-control-test", label),
  );
});

test("a non-loopback published port is refused and the created container is still removed", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_BINDING: "0.0.0.0:49153" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    name: "AssertionError",
  });
  assert(!(await calls()).some((call) => call.includes("pg_isready")));
  fixture.cleanup();
  assert.equal((await calls()).at(-1), `container rm --force ${fakeId}`);
});

test("a failed create removes nothing and withholds command output", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "create" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /\/docker fixture command failed\.$/);
    assert(!error.message.includes(password));
    return true;
  });
  fixture.cleanup();
  const cleaned = await calls();
  assert(!cleaned.some((call) => call.startsWith("rm ")));
  assert(
    !cleaned.some(
      (call) => call.startsWith("container rm ") || call.startsWith("container inspect "),
    ),
  );
  assert.equal(cleaned.filter((call) => call.startsWith("container ls ")).length, 1);
});

test("a lost create reply removes only this invocation's inspected container and never retries", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "lost" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    message: /fixture command failed\.$/,
  });
  const started = await calls();
  const label = ownershipLabel(started[1]);
  assert.equal(started.filter((call) => call.startsWith("create ")).length, 1);
  assert(!started.some((call) => call.startsWith("start ")));
  fixture.cleanup();
  fixture.cleanup();
  assert.deepEqual(
    (await calls()).slice(started.length),
    ownedRemoval("openbot-control-test", label),
  );
});

test("a pre-existing or foreign container reusing the name is never inspected or removed", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "existing" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    message: /fixture command failed\.$/,
  });
  const started = await calls();
  const label = ownershipLabel(started[1]);
  fixture.cleanup();
  assert.deepEqual((await calls()).slice(started.length), [
    ownedRemoval("openbot-control-test", label)[0],
  ]);
});

test("PostgreSQL that never accepts connections fails after the bounded wait", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "ready" });
  await assert.rejects(startControlPostgres(fixture, "openbot-control-test", password), {
    message: "Owned PostgreSQL did not become ready.",
  });
  assert.equal((await calls()).filter((call) => call.includes("pg_isready")).length, 60);
  fixture.cleanup();
  assert.equal((await calls()).at(-1), `container rm --force ${fakeId}`);
});

for (const [mode, message] of [
  ["ambiguous", "Refusing ambiguous control PostgreSQL container cleanup"],
  ["malformed", "Refusing invalid control PostgreSQL container ID"],
  ["foreign-name", "Refusing unowned control PostgreSQL container name"],
  ["inspect", "Docker fixture cleanup command failed."],
  ["lookup", "Docker fixture cleanup command failed."],
] as const) {
  test(`cleanup refuses deletion on ${mode} ownership evidence and reports failure`, async (t) => {
    const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: mode });
    await startControlPostgres(fixture, "openbot-control-test", password);
    const errors: string[] = [];
    t.mock.method(console, "error", (line: string) => {
      errors.push(line);
    });
    assert.throws(() => fixture.cleanup(), { message: "Owned Docker fixture cleanup failed." });
    const after = await calls();
    assert(!after.some((call) => call.startsWith("container rm ")));
    assert.deepEqual(errors, [message, "Could not remove owned fixture openbot-control-test."]);
    for (const line of errors) {
      assert(!line.includes(fakeId), "Refusal must not echo inspected identifiers");
      assert(!line.includes("another-container"), "Refusal must not echo inspected names");
      assert(!line.includes(password), "Refusal must not echo fixture secrets");
    }
    fixture.cleanup();
    assert.deepEqual(await calls(), after);
  });
}

test("containers are removed before images and failed removal is reported and fails", async (t) => {
  const { fixture, calls } = await fakeDocker(t, { FAKE_DOCKER_FAIL: "remove" });
  fixture.own("image", "openbot-python-acceptance:abc");
  await startControlPostgres(fixture, "openbot-python-test-abc", password);
  const started = await calls();
  const label = ownershipLabel(started[1]);
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errors.push(message);
  });
  assert.throws(() => fixture.cleanup(), { message: "Owned Docker fixture cleanup failed." });
  fixture.cleanup();
  assert.deepEqual((await calls()).slice(started.length), [
    ...ownedRemoval("openbot-python-test-abc", label),
    "image rm openbot-python-acceptance:abc",
  ]);
  assert.deepEqual(errors, [
    "Docker fixture cleanup command failed.",
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

// Exercise the real child-stream bound: maxBuffer can return an oversized final read chunk.
test("oversized cleanup diagnostics refuse inspection and stay bounded; root output stays withheld", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-cleanup-overflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const marker = join(directory, "unexpected-mutation");
  await writeFile(
    docker,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[3] === "ls") process.stderr.write("X".repeat(2 * 1024 * 1024));
else fs.writeFileSync(${JSON.stringify(marker)}, "unexpected inspection/removal");
`,
  );
  await chmod(docker, 0o700);
  const helper = new URL("./python-acceptance-fixture.ts", import.meta.url).href;
  for (const diagnostics of ["daemon", "withheld"] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { OwnedDockerFixture } from ${JSON.stringify(helper)};
const fixture = new OwnedDockerFixture(${JSON.stringify(directory)}, {}, ${JSON.stringify(docker)});
fixture.reserveContainer("overflow", {key: "openbot.fixture", value: "overflow"}, "overflow", ${JSON.stringify(diagnostics)});
try { fixture.cleanup(); console.log("absent"); }
catch { console.log("refused"); }
`,
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    if (diagnostics === "daemon") {
      assert.equal(result.stdout.trim(), "refused");
      assert(Buffer.byteLength(result.stderr) <= 64 * 1024 + 1024);
    } else {
      assert.equal(result.stdout.trim(), "absent");
      assert.equal(result.stderr, "");
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});
