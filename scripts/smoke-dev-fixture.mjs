import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const postgresImage =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";

export function validateDatabaseUrl(value) {
  const url = new URL(value);
  assert(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      /^\/[a-z0-9_]+_dev_smoke$/.test(url.pathname) &&
      !url.search &&
      !url.hash,
    "Use one loopback PostgreSQL URL without parameters and an empty database ending _dev_smoke.",
  );
  return url;
}

export async function assertFreshCheckout(root) {
  for (const directory of [root, join(root, "apps/web")]) {
    const files = await readdir(directory);
    assert(
      !files.some(
        (name) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example"),
      ),
      "Use a fresh checkout without local .env files; this journey supplies its own configuration.",
    );
  }
  for (const group of ["apps", "packages", "providers"]) {
    for (const name of await readdir(join(root, group))) {
      assert(
        !existsSync(join(root, group, name, "dist")),
        "Run dev:smoke immediately after npm ci in a fresh checkout, before build/test/check. Existing build output is never deleted.",
      );
    }
  }
}

export async function assertPortFree(port) {
  const listener = createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, "::", resolve);
    });
  } catch {
    throw new Error(
      `Port ${port} is occupied or unavailable. Stop its service or use another clean environment.`,
    );
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  }
}

export function isolatedEnvironment({ source = process.env, directory, npmCli }) {
  return {
    PATH: `${join(dirname(npmCli), "../../.bin")}:${source.PATH ?? ""}`,
    TMPDIR: directory,
    npm_config_cache: source.npm_config_cache ?? join(directory, "npm-cache"),
    npm_config_userconfig: "/dev/null",
    CI: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_NO_UPDATE_NOTIFIER: "1",
    TURBO_CACHE: "local:rw",
  };
}

export function redact(value, secrets) {
  let text = String(value);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, "[fixture secret]");
  }
  return text;
}

async function groupHasLiveMembers(groupId) {
  // Darwin can return EPERM for an existing group containing only unreaped zombies.
  // Inspect numeric identity/state only; never expose other processes' arguments or environment.
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,pgid=,uid=,stat="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  const rows = stdout.trim().split("\n");
  assert(rows.length > 0 && stdout.trim(), "Process-state inspection returned no data.");
  return rows
    .map((row) => {
      const fields = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<>NsElLsWXI-]+)$/);
      assert(fields, "Process-state inspection returned an invalid record.");
      return { group: Number(fields[2]), zombie: fields[4].startsWith("Z") };
    })
    .some((row) => row.group === groupId && !row.zombie);
}

export function startProcess({ command = process.execPath, args, cwd, env, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error;
  let stopped = false;
  let stopping;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", (value) => {
    error = value;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-64 * 1024);
    });
  async function signalGroup(signal) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (value) {
      if (value.code === "ESRCH") return false;
      if (value.code === "EPERM" && !(await groupHasLiveMembers(child.pid))) return false;
      value.message = `${label} owned process group ${child.pid}, signal ${signal}: ${value.message}`;
      throw value;
    }
  }
  async function stopOnce(graceMs) {
    await signalGroup("SIGTERM");
    const deadline = Date.now() + graceMs;
    let active = await signalGroup(0);
    while (active && Date.now() < deadline) {
      await delay(50);
      active = await signalGroup(0);
    }
    if (active) await signalGroup("SIGKILL");
    const killedDeadline = Date.now() + 2000;
    while (await signalGroup(0)) {
      assert(Date.now() < killedDeadline, `${label} process group did not terminate.`);
      await delay(50);
    }
    // A group snapshot may precede libuv reaping our own child; do not leave that reap pending.
    while (child.pid && !exited) {
      assert(Date.now() < killedDeadline, `${label} child exit was not observed.`);
      await delay(10);
    }
    stopped = true;
  }
  return {
    label,
    pid: child.pid,
    output: () => output,
    assertRunning() {
      assert(!error, `${label} could not start (${error?.code ?? "spawn failure"}).`);
      assert(
        child.exitCode === null && child.signalCode === null,
        `${label} exited before readiness (exit ${child.exitCode ?? child.signalCode}).`,
      );
    },
    stop({ graceMs = 8000 } = {}) {
      if (stopped) return Promise.resolve();
      // A failed attempt must remain retryable by the driver's final cleanup.
      stopping ??= stopOnce(graceMs).finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}

export async function readRetainedIdentity(path, nodeId) {
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 4096,
    "Node identity must be a bounded regular file.",
  );
  assert.equal(info.mode & 0o077, 0, "Node identity must remain private to its owner.");
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Node identity file contains invalid JSON.");
  }
  assert(
    value.format === "openbot.node-identity/v1" &&
      value.nodeId === nodeId &&
      typeof value.credential === "string" &&
      typeof value.enrolledAt === "string",
    "Node did not persist the expected identity package.",
  );
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    enrolledAt: value.enrolledAt,
    credential: value.credential,
  };
}

export class SmokeDatabase {
  #name = `openbot-dev-smoke-${randomBytes(8).toString("hex")}`;
  #label = randomBytes(16).toString("hex");
  #attempted = false;
  #env;
  #url;
  #restoreTargets = new Set();
  constructor() {
    this.#env = Object.fromEntries(
      ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    );
  }
  async #docker(args, options = {}) {
    try {
      return (
        await exec("docker", args, {
          env: this.#env,
          timeout: 20_000,
          maxBuffer: 128 * 1024,
          killSignal: "SIGKILL",
          ...options,
        })
      ).stdout.trim();
    } catch (error) {
      throw new Error(
        `Docker fixture command failed (${error.code ?? "unavailable"}). Verify Docker is running and the pinned PostgreSQL image can be loaded.`,
      );
    }
  }
  async start(signal, password) {
    await this.#docker(["info", "--format", "{{.ServerVersion}}"], { signal });
    this.#attempted = true;
    await this.#docker(
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        this.#name,
        "--label",
        `openbot.dev-smoke=${this.#label}`,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_USER=openbot_smoke",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=openbot_dev_smoke",
        "--tmpfs",
        "/var/lib/postgresql/data",
        postgresImage,
        "-c",
        "client_min_messages=warning",
      ],
      { signal, timeout: 180_000 },
    );
    const binding = await this.#docker(["port", this.#name, "5432/tcp"], { signal });
    assert(/^127\.0\.0\.1:\d+$/.test(binding), "Disposable PostgreSQL must bind only to loopback.");
    for (let attempt = 0; attempt < 40; attempt++) {
      signal.throwIfAborted();
      try {
        await this.#docker(
          // The image's temporary initialization server accepts Unix sockets before final startup.
          [
            "exec",
            this.#name,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-U",
            "openbot_smoke",
            "-d",
            "openbot_dev_smoke",
          ],
          { signal, timeout: 5000 },
        );
        this.#url = `postgres://openbot_smoke:${password}@${binding}/openbot_dev_smoke`;
        return this.#url;
      } catch {
        await delay(250, undefined, { signal });
      }
    }
    throw new Error("Disposable PostgreSQL did not become ready within ten seconds.");
  }
  /** Native tools only address this journey's owned container, never a supplied connection URL. */
  async dump({ signal } = {}) {
    assert(this.#url, "Start the owned database before exporting it.");
    const { stdout, stderr } = await exec(
      "docker",
      [
        "exec",
        this.#name,
        "pg_dump",
        "-U",
        "openbot_smoke",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "openbot_dev_smoke",
      ],
      {
        env: this.#env,
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "buffer",
        signal,
        killSignal: "SIGKILL",
      },
    );
    assert.equal(
      stderr.length,
      0,
      "Native dump emitted diagnostics; review the fixture before continuing.",
    );
    return stdout;
  }
  async createRestoreTarget(name, { signal } = {}) {
    assert(
      this.#url && /^openbot_restore_test_[a-z]+$/.test(name),
      "Invalid owned restore target.",
    );
    await this.#docker(
      ["exec", this.#name, "createdb", "-U", "openbot_smoke", "--template=template0", name],
      { signal },
    );
    this.#restoreTargets.add(name);
    const url = new URL(this.#url);
    url.pathname = `/${name}`;
    return url.href;
  }
  async restore(name, archive, { signal } = {}) {
    assert(
      this.#restoreTargets.delete(name),
      "Restore requires a newly created unused fixture target.",
    );
    assert(
      Buffer.isBuffer(archive) && archive.length <= 16 * 1024 * 1024,
      "Restore archive exceeds the fixture bound.",
    );
    const operation = exec(
      "docker",
      [
        "exec",
        "-i",
        this.#name,
        "pg_restore",
        "-U",
        "openbot_smoke",
        "--dbname",
        name,
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
      ],
      { env: this.#env, timeout: 30_000, maxBuffer: 128 * 1024, signal, killSignal: "SIGKILL" },
    );
    // Early pg_restore rejection can close stdin before all bytes are sent.
    operation.child.stdin.on("error", () => {});
    operation.child.stdin.end(archive);
    try {
      const { stderr } = await operation;
      assert.equal(stderr.length, 0, "Native restore emitted diagnostics.");
    } catch {
      throw new Error(
        "Native fixture restore failed; no success is inferred from archive readability.",
      );
    }
  }
  async stop() {
    if (!this.#attempted) return;
    let label;
    try {
      label = (
        await exec(
          "docker",
          ["inspect", "--format", '{{index .Config.Labels "openbot.dev-smoke"}}', this.#name],
          { env: this.#env, timeout: 10_000, killSignal: "SIGKILL" },
        )
      ).stdout.trim();
    } catch (error) {
      if (error.code === 1 && /No such (object|container)/i.test(error.stderr ?? "")) return;
      throw new Error(
        `Could not verify ownership of fixture container ${this.#name}; cleanup was not attempted.`,
      );
    }
    assert.equal(label, this.#label, "Refusing to remove a container not owned by this journey.");
    await this.#docker(["rm", "--force", this.#name]);
    this.#attempted = false;
  }
}
