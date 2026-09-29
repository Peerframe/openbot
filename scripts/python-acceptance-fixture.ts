// Owned Docker/PostgreSQL lifetime shared by the Python control and Linux runtime acceptance gates.
// Node built-ins only: the Linux runtime gate runs before `npm ci`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CONTROL_POSTGRES_IMAGE =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const CONTROL_POSTGRES_USER = "openbot_test";
const CONTROL_POSTGRES_DATABASE = "openbot_control_test_reference";

export type FixtureEnvironment = Readonly<Record<string, string>>;

/** Copies only the named, present variables; everything else stays out of fixture children. */
export function allowlistedEnvironment(
  keys: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
}

export type FixtureCommandOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout?: number;
};

/** Captured fixture command; output is withheld on failure because it may contain secrets. */
export function runFixtureCommand(
  command: string,
  args: readonly string[],
  options: FixtureCommandOptions,
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error) throw new Error(`${command} fixture command failed.`);
  return result.stdout.trim();
}

type OwnedResource = { readonly kind: "container" | "image"; readonly name: string };

/**
 * Records Docker resources only after this invocation created them and removes exactly those:
 * containers before images, each at most once, never a pre-existing or foreign resource.
 */
export class OwnedDockerFixture {
  readonly #cwd: string;
  readonly #environment: FixtureEnvironment;
  readonly #docker: string;
  #owned: OwnedResource[] = [];

  constructor(cwd: string, environment: FixtureEnvironment, docker = "docker") {
    this.#cwd = cwd;
    this.#environment = environment;
    this.#docker = docker;
  }

  run(args: readonly string[], timeout?: number): string {
    return runFixtureCommand(this.#docker, args, {
      cwd: this.#cwd,
      env: this.#environment,
      ...(timeout === undefined ? {} : { timeout }),
    });
  }

  /** Bounded readiness probe; failure is an expected answer, not a fixture error. */
  probe(args: readonly string[]): boolean {
    const result = spawnSync(this.#docker, args, {
      env: this.#environment,
      stdio: "ignore",
      timeout: 5000,
    });
    return result.status === 0;
  }

  own(kind: OwnedResource["kind"], name: string): void {
    this.#owned.push({ kind, name });
  }

  cleanup(): void {
    const owned = this.#owned;
    this.#owned = [];
    for (const kind of ["container", "image"] as const) {
      for (const { name } of owned.filter((resource) => resource.kind === kind)) {
        const removed = spawnSync(
          this.#docker,
          kind === "container" ? ["rm", "--force", name] : ["image", "rm", name],
          { env: this.#environment, stdio: "ignore", timeout: 20_000 },
        );
        if (removed.status !== 0)
          console.error(
            kind === "container"
              ? `Could not remove owned fixture ${name}.`
              : `Could not remove owned fixture image ${name}.`,
          );
      }
    }
  }
}

/** Interrupted gates clean up synchronously, then keep the conventional signal exit status. */
export function cleanupOnTerminationSignals(cleanup: () => void): void {
  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.once(signal, () => {
      cleanup();
      process.exit(status);
    });
}

/**
 * Starts the pinned PostgreSQL on an ephemeral loopback port with tmpfs storage and returns its
 * DSN. The container is owned as soon as `docker create` succeeds, before any later check.
 */
export async function startControlPostgres(
  fixture: OwnedDockerFixture,
  name: string,
  password: string,
): Promise<string> {
  fixture.run(["info", "--format", "{{.ServerVersion}}"]);
  fixture.run([
    "create",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_USER=${CONTROL_POSTGRES_USER}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${CONTROL_POSTGRES_DATABASE}`,
    "--tmpfs",
    "/var/lib/postgresql/data",
    CONTROL_POSTGRES_IMAGE,
    "-c",
    "client_min_messages=warning",
  ]);
  fixture.own("container", name);
  fixture.run(["start", name]);
  const binding = fixture.run(["port", name, "5432/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const dsn = `postgres://${CONTROL_POSTGRES_USER}:${password}@${binding}/${CONTROL_POSTGRES_DATABASE}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const accepting = fixture.probe([
      "exec",
      name,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      CONTROL_POSTGRES_USER,
      "-d",
      CONTROL_POSTGRES_DATABASE,
    ]);
    if (accepting) {
      ready = true;
      break;
    }
    await delay(250);
  }
  assert(ready, "Owned PostgreSQL did not become ready.");
  return dsn;
}

/** Adds a separate empty database inside the same owned container and returns its DSN. */
export function createControlDatabase(
  fixture: OwnedDockerFixture,
  name: string,
  dsn: string,
  database: string,
): string {
  fixture.run([
    "exec",
    name,
    "createdb",
    `--username=${CONTROL_POSTGRES_USER}`,
    "--no-password",
    "--template=template0",
    database,
  ]);
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.href;
}

/** The base check excludes exactly these files; the Worker invocation executes them. */
export async function readWorkerTests(root: string): Promise<readonly string[]> {
  const workerTests = (await readFile(join(root, "apps/server-python/worker-tests.txt"), "utf8"))
    .trim()
    .split("\n");
  assert(workerTests.length > 0 && workerTests.every((path) => path.length > 0));
  assert.equal(new Set(workerTests).size, workerTests.length, "Duplicate Worker test path.");
  for (const path of workerTests)
    assert(existsSync(join(root, "apps/server-python", path)), `Missing Worker test: ${path}`);
  return workerTests;
}

/** Fixture files carry DSNs and session tokens: create them owner-only. */
export async function writePrivateFixture(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
