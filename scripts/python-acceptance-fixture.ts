// Owned Docker/PostgreSQL lifetime shared by the Python control and Linux runtime acceptance gates.
// Node built-ins only: the Linux runtime gate runs before `npm ci`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

export type FixtureLabel = { readonly key: string; readonly value: string };

/** Cleanup query stderr is withheld by default; only a synthetic-only caller may pass it through. */
export type CleanupDiagnostics = "withheld" | "daemon";

type ReservedContainer = {
  readonly name: string;
  readonly label: FixtureLabel;
  readonly subject: string;
  readonly diagnostics: CleanupDiagnostics;
};

const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

/** Plain refusal: never carries inspected or listed values into diagnostics. */
function refuseUnless(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Owns this invocation's disposable Docker resources. A container is reserved by exact name and a
 * fixture label before `create`/`run` can succeed, so a lost or terminated CLI reply still leaves
 * a discoverable candidate. Cleanup removes only the uniquely discovered, inspected full ID (never
 * a mutable name) and refuses any absent-evidence mismatch; then it removes owned images. Each
 * resource is attempted at most once, containers before images, and any failure fails the caller.
 */
export class OwnedDockerFixture {
  readonly #cwd: string;
  readonly #environment: FixtureEnvironment;
  readonly #docker: string;
  #containers: ReservedContainer[] = [];
  #images: string[] = [];

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

  /**
   * Records ownership before creation can happen. The caller passes the returned value to the
   * create command's `--label`; the name must be unique to this invocation.
   */
  reserveContainer(
    name: string,
    label: FixtureLabel,
    subject: string,
    diagnostics: CleanupDiagnostics = "withheld",
  ): string {
    this.#containers.push({ name, label, subject, diagnostics });
    return `${label.key}=${label.value}`;
  }

  /** Images are owned by tag only after this invocation built them. */
  own(kind: "image", name: string): void {
    assert.equal(kind, "image");
    this.#images.push(name);
  }

  /** Bounded cleanup query; stdout is parsed and never printed. */
  #cleanupCommand(args: readonly string[], diagnostics: CleanupDiagnostics): string {
    const result = spawnSync(this.#docker, args, {
      cwd: this.#cwd,
      env: this.#environment,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", diagnostics === "daemon" ? "pipe" : "ignore"],
    });
    if (result.status !== 0 || result.error) {
      // Synthetic S7 diagnostics share the captured output bound; inherit would bypass maxBuffer.
      if (diagnostics === "daemon" && result.stderr)
        process.stderr.write(Buffer.from(result.stderr).subarray(0, 64 * 1024));
      throw new Error("Docker fixture cleanup command failed.");
    }
    return result.stdout.trim();
  }

  #removeContainer({ name, label, subject, diagnostics }: ReservedContainer): void {
    // A failed create reply does not prove the daemon did not create it: discover, then verify.
    const ids = this.#cleanupCommand(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=${name}`,
        "--filter",
        `label=${label.key}=${label.value}`,
        "--format",
        "{{.ID}}",
      ],
      diagnostics,
    )
      .split("\n")
      .filter(Boolean);
    if (ids.length === 0) return;
    refuseUnless(ids.length === 1, `Refusing ambiguous ${subject} container cleanup`);
    const id = ids[0] ?? "";
    refuseUnless(FULL_CONTAINER_ID.test(id), `Refusing invalid ${subject} container ID`);
    let inspected: unknown;
    try {
      inspected = JSON.parse(this.#cleanupCommand(["container", "inspect", id], diagnostics));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(`Refusing malformed ${subject} container inspection`);
      throw error;
    }
    refuseUnless(
      Array.isArray(inspected) && inspected.length === 1,
      `Refusing ambiguous ${subject} container inspection`,
    );
    const record: unknown = Array.isArray(inspected) ? inspected[0] : undefined;
    refuseUnless(field(record, "Id") === id, `Refusing changed ${subject} container identity`);
    refuseUnless(
      field(record, "Name") === `/${name}`,
      `Refusing unowned ${subject} container name`,
    );
    refuseUnless(
      field(field(field(record, "Config"), "Labels"), label.key) === label.value,
      `Refusing unowned ${subject} container label`,
    );
    this.#cleanupCommand(["container", "rm", "--force", id], diagnostics);
  }

  cleanup(): void {
    const containers = this.#containers;
    const images = this.#images;
    this.#containers = [];
    this.#images = [];
    let failed = false;
    for (const container of containers) {
      try {
        this.#removeContainer(container);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Docker fixture cleanup failed.");
        console.error(`Could not remove owned fixture ${container.name}.`);
        failed = true;
      }
    }
    for (const name of images) {
      const removed = spawnSync(this.#docker, ["image", "rm", name], {
        env: this.#environment,
        stdio: "ignore",
        timeout: 20_000,
      });
      if (removed.status !== 0) {
        console.error(`Could not remove owned fixture image ${name}.`);
        failed = true;
      }
    }
    if (failed) throw new Error("Owned Docker fixture cleanup failed.");
  }
}

/** Interrupted gates clean up synchronously, then keep the conventional signal exit status. */
export function cleanupOnTerminationSignals(cleanup: () => void): void {
  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.once(signal, () => {
      try {
        cleanup();
      } finally {
        process.exit(status);
      }
    });
}

/**
 * Starts the pinned PostgreSQL on an ephemeral loopback port with tmpfs storage and returns its
 * DSN. The container is reserved with a fresh per-invocation label before `docker create`, so an
 * unknown create outcome is still cleaned up by inspected ID and never by name alone.
 */
export async function startControlPostgres(
  fixture: OwnedDockerFixture,
  name: string,
  password: string,
): Promise<string> {
  fixture.run(["info", "--format", "{{.ServerVersion}}"]);
  const label = fixture.reserveContainer(
    name,
    { key: "openbot.fixture", value: `python-acceptance-${randomUUID()}` },
    "control PostgreSQL",
  );
  fixture.run([
    "create",
    "--name",
    name,
    "--label",
    label,
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
