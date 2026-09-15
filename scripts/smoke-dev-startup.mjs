import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

for (const directory of [root, join(root, "apps/web")]) {
  const files = await readdir(directory);
  assert(
    !files.some((name) => name === ".env" || (name.startsWith(".env.") && name !== ".env.example")),
    "Use a fresh checkout without local .env files; this check supplies its own configuration.",
  );
}
for (const group of ["apps", "packages", "providers"]) {
  for (const name of await readdir(join(root, group))) {
    assert(
      !existsSync(join(root, group, name, "dist")),
      "Run dev:smoke immediately after npm ci in a fresh checkout, before build/test/check.",
    );
  }
}
for (const port of [3001, 5173]) {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "::", resolve);
  });
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
}

const postgres = createRequire(new URL("../packages/db/package.json", import.meta.url))("postgres");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
try {
  const [result] = await sql`
    select count(*)::int as count from pg_catalog.pg_tables
    where schemaname not like 'pg_%' and schemaname <> 'information_schema'
  `;
  assert.equal(result.count, 0, "The disposable startup database must be empty.");
} finally {
  await sql.end({ timeout: 5 });
}

const directory = await mkdtemp(join(tmpdir(), "openbot-dev-smoke-"));
const password = randomBytes(24).toString("hex");
const origin = "http://localhost:5173";
const controller = new AbortController();
const abort = () => controller.abort(new Error("Startup smoke interrupted."));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
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
    OPENBOT_HOST: "127.0.0.1",
    OPENBOT_PORT: "3001",
    OPENBOT_DATABASE_URL: databaseUrl,
    OPENBOT_OWNER_PASSWORD: password,
    OPENBOT_ALLOWED_ORIGINS: origin,
    OPENBOT_SECURE_COOKIES: "false",
    OPENBOT_OBJECT_STORE_PATH: join(directory, "objects"),
    OPENBOT_MODEL_DIRECTORY: join(directory, "model"),
  },
});
let output = "";
let startupError;
child.once("error", (error) => {
  startupError = error;
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-64 * 1024);
  });
}

async function ready(url, verify) {
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
    const value = await response.json();
    return value.ok === true && value.service === "openbot-server";
  });
  await ready(`${origin}/`, async (response) => (await response.text()).includes("/src/main.tsx"));
  await ready(`${origin}/health`, async (response) => (await response.json()).ok === true);
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(login.status, 200, "Owner login through the development proxy failed.");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie?.startsWith("openbot_session="), "Login did not return the Owner session cookie.");
  const session = await fetch(`${origin}/api/v1/auth/session`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal((await session.json()).authenticated, true);
  const channels = await fetch(`${origin}/api/v1/channels`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(channels.status, 200, "Authenticated workspace API failed.");
  console.log("Fresh startup passed: shared builds, Server health, Web/proxy and Owner session.");
} catch (error) {
  console.error(
    output.replaceAll(databaseUrl, "[fixture database]").replaceAll(password, "[fixture password]"),
  );
  throw error;
} finally {
  // npm, Turbo and watchers form a process tree. Signal its dedicated group,
  // then bound cleanup even when a watcher fails to forward termination.
  function signalGroup(signal) {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  signalGroup("SIGTERM");
  const deadline = Date.now() + 12_000;
  while (signalGroup(0) && Date.now() < deadline) await delay(100);
  signalGroup("SIGKILL");
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  await rm(directory, { recursive: true, force: true });
}
