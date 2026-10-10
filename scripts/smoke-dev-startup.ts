import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type postgresClient from "postgres";
import { assertFreshSourceCheckout } from "./dev-startup-inputs.ts";
import { FIXTURE_DATABASE, FIXTURE_PASSWORD, redactFixtureOutput } from "./output-redaction.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this uncached root driver runs outside Turbo and preserves npm's selected CLI.
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check through npm run dev:smoke.");
assert(process.platform !== "win32", "This process-group smoke requires Linux or macOS.");
const databaseUrl = process.env.OPENBOT_DEV_SMOKE_DATABASE_URL;
assert(databaseUrl, "OPENBOT_DEV_SMOKE_DATABASE_URL must name a disposable database.");
const parsed = new URL(databaseUrl);
assert(
  ["postgres:", "postgresql:"].includes(parsed.protocol) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
    /^\/[a-z0-9_]+_dev_smoke$/.test(parsed.pathname) &&
    parsed.search === "" &&
    parsed.hash === "",
  "Use a loopback PostgreSQL URL without query parameters and a database ending _dev_smoke.",
);

await assertFreshSourceCheckout(root);
for (const port of [3001, 5173]) {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "::", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

// Resolve the reviewed client from its owning package; a fresh checkout has no db build.
const postgres: typeof postgresClient = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
)("postgres");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
try {
  const [result] = await sql<{ count: number }[]>`
    select count(*)::int as count from pg_catalog.pg_tables
    where schemaname not like 'pg_%' and schemaname <> 'information_schema'
  `;
  assert.equal(result?.count, 0, "The disposable startup database must be empty.");
} finally {
  await sql.end({ timeout: 5 });
}

const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-dev-smoke-")));
const password = randomBytes(24).toString("hex");
const origin = "http://localhost:5173";
const controller = new AbortController();
const abort = () => controller.abort(new Error("Startup smoke interrupted."));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const { startTemporalFixture } = await import("./temporal-fixture.ts");
const temporal = await startTemporalFixture({ signal: controller.signal });
const temporalPath = join(directory, "temporal.json");
await writeFile(temporalPath, JSON.stringify({ temporal_address: temporal.settings.address, namespace: "default", queue: "openbot-dev-smoke", tls: temporal.settings.tls }), { mode: 0o600 });
const child = spawn(process.execPath, [npmCli, "run", "dev"], {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  // Only the disposable fixture reaches the processes: inherited model keys and
  // application configuration must not affect this credential-free journey.
  env: {
    PATH: `${join(dirname(npmCli), "../../.bin")}:${process.env.PATH ?? ""}`,
    TMPDIR: directory,
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: npm's cache config belongs to the uncached root fixture, not a Turbo task input.
    npm_config_cache: process.env.npm_config_cache ?? join(directory, "npm-cache"),
    npm_config_userconfig: "/dev/null",
    CI: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    TURBO_CACHE: "local:rw",
    OPENBOT_TS_DATABASE_URL: databaseUrl,
    OPENBOT_TS_OWNER_PASSWORD: password,
    OPENBOT_TS_OBJECT_ROOT: join(directory, "objects"),
    OPENBOT_TS_ARTIFACT_ROOT: join(directory, "artifacts"),
    OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: temporalPath,
  },
});
let output = "";
let startupError: Error | undefined;
child.once("error", (error) => {
  startupError = error;
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-64 * 1024);
  });
}

async function ready(url: string, verify: (response: Response) => Promise<boolean>) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (startupError) throw startupError;
    assert(child.exitCode === null && child.signalCode === null, "Development command exited.");
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
      });
      if (response.ok && (await verify(response))) return;
    } catch {}
    await delay(200, undefined, { signal: controller.signal });
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

try {
  await ready("http://127.0.0.1:3001/health", async (response) => {
    const value: unknown = await response.json();
    return (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === true &&
      "service" in value &&
      value.service === "openbot-server"
    );
  });
  await ready(`${origin}/`, async (response) => (await response.text()).includes("/src/main.tsx"));
  await ready(`${origin}/health`, async (response) => {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
  });
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(login.status, 200, "Owner login through the development proxy failed.");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(
    typeof cookie === "string" && cookie.startsWith("openbot_session="),
    "Login did not return the Owner session cookie.",
  );
  const session = await fetch(`${origin}/api/v1/auth/session`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5_000),
  });
  const sessionValue: unknown = await session.json();
  assert.equal(
    typeof sessionValue === "object" && sessionValue !== null && "authenticated" in sessionValue
      ? sessionValue.authenticated
      : undefined,
    true,
  );
  const channels = await fetch(`${origin}/api/v1/channels`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(channels.status, 200, "Authenticated workspace API failed.");
  console.log("Fresh startup passed: shared builds, Server health, Web/proxy and Owner session.");
} catch (error) {
  console.error(
    redactFixtureOutput(output, [
      [databaseUrl, FIXTURE_DATABASE],
      [password, FIXTURE_PASSWORD],
    ]),
  );
  throw error;
} finally {
  // npm, Turbo and watchers form a process tree. Signal its dedicated group,
  // then bound cleanup even when a watcher fails to forward termination.
  function signalGroup(signal: NodeJS.Signals | 0): boolean {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  }
  signalGroup("SIGTERM");
  const deadline = Date.now() + 12_000;
  while (signalGroup(0) && Date.now() < deadline) await delay(100);
  signalGroup("SIGKILL");
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  await temporal.close();
  await rm(directory, { recursive: true, force: true });
}
