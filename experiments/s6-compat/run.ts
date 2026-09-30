import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  allowlistedEnvironment,
  cleanupOnTerminationSignals,
} from "../../scripts/python-acceptance-fixture.ts";

assert(process.argv.length === 2, "This fixture accepts no database or configuration arguments.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const DATABASE_USER = "openbot_test";
const READY_ATTEMPTS = 30;
const READY_INTERVAL_MS = 500;
// Match the existing headless harness: keep OS/Docker prerequisites, exclude all product secrets.
const INHERITED_ENVIRONMENT = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
] as const;

/** Generated, run-scoped identity of the single disposable PostgreSQL container. */
interface Fixture {
  readonly name: string;
  readonly database: string;
  readonly password: string;
}

interface CommandOptions {
  readonly capture?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

/** Removal right for the one generated container name; claimed before `docker run` starts. */
interface ContainerOwner {
  claim(): void;
  release(): void;
}

const suffix = randomBytes(6).toString("hex");
const fixture: Fixture = {
  name: `openbot-s6-${suffix}`,
  database: `openbot_s6_test_${suffix}`,
  password: randomBytes(24).toString("hex"),
};
const environment: Record<string, string> = {
  ...allowlistedEnvironment(INHERITED_ENVIRONMENT),
  CI: "1",
  NO_COLOR: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE: "local:rw",
};

function redact(text: string): string {
  return text.replaceAll(fixture.password, "[fixture password]");
}

/** Run one bounded child; failure text never carries the fixture password. */
function run(
  command: string,
  args: readonly string[],
  { capture = false, env = environment, timeout = 120_000 }: CommandOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = redact(String(result.stderr ?? result.error?.message ?? ""));
    throw new Error(`${command} failed (${result.status ?? "unavailable"}). ${detail}`);
  }
  return result.stdout?.trim() ?? "";
}

// Docker can create the container and still lose the CLI response, so ownership is by generated
// name and cleanup is idempotent; a failed removal keeps the run failed.
function containerOwner(name: string): ContainerOwner {
  let owned = false;
  return {
    claim() {
      owned = true;
    },
    release() {
      if (!owned) return;
      owned = false;
      const result = spawnSync("docker", ["rm", "--force", name], {
        env: environment,
        stdio: "ignore",
        timeout: 20_000,
      });
      if (result.status !== 0) {
        console.error(`Could not remove owned fixture container ${name}.`);
        process.exitCode = 1;
      }
    },
  };
}

function buildPrerequisites(): void {
  assert(
    existsSync(join(root, "node_modules/vitest/vitest.mjs")),
    "First run npm ci --ignore-scripts --no-audit.",
  );
  run(process.execPath, [
    join(root, "node_modules/turbo/bin/turbo"),
    "run",
    "build",
    "--filter=@openbot/node^...",
  ]);
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "experiments/s6-compat/tsconfig.json",
  ]);
  run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true, timeout: 15_000 });
}

function startPostgres(owner: ContainerOwner): string {
  console.log("Starting owned S6 PostgreSQL fixture; all Bot/model/MCP inputs are synthetic.");
  // Record the generated name before starting so an uncertain launch also receives bounded cleanup.
  owner.claim();
  run(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      fixture.name,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_USER=${DATABASE_USER}`,
      "--env",
      `POSTGRES_PASSWORD=${fixture.password}`,
      "--env",
      `POSTGRES_DB=${fixture.database}`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      IMAGE,
      "-c",
      "client_min_messages=warning",
    ],
    { capture: true, timeout: 180_000 },
  );
  const binding = run("docker", ["port", fixture.name, "5432/tcp"], { capture: true });
  assert(/^127\.0\.0\.1:\d+$/.test(binding), "Fixture must bind only to loopback.");
  return binding;
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", fixture.name, "pg_isready", "-U", DATABASE_USER, "-d", fixture.database],
      { env: environment, stdio: "ignore", timeout: 5000 },
    );
    if (result.status === 0) return;
    await delay(READY_INTERVAL_MS);
  }
  assert.fail("S6 PostgreSQL did not become ready.");
}

function runCompatibilitySuite(binding: string): void {
  run(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "experiments/s6-compat/compat.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=verbose",
    ],
    {
      env: {
        ...environment,
        OPENBOT_S6_TEST_DATABASE_URL: `postgres://${DATABASE_USER}:${fixture.password}@${binding}/${fixture.database}`,
      },
    },
  );
}

const owner = containerOwner(fixture.name);
cleanupOnTerminationSignals(() => owner.release());
try {
  buildPrerequisites();
  const binding = startPostgres(owner);
  await waitForPostgres();
  runCompatibilitySuite(binding);
  console.log(
    "S6 baseline probes passed, including current per-Run budget behavior. Shared Task admission and durable delegation acceptance remain open.",
  );
} finally {
  owner.release();
}
