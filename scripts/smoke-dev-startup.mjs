import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assertFreshCheckout,
  assertPortFree,
  isolatedEnvironment,
  readRetainedIdentity,
  redact,
  SmokeDatabase,
  startProcess,
  validateDatabaseUrl,
} from "./smoke-dev-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this uncached root driver preserves npm's selected CLI.
const npmCli = process.env.npm_execpath;
const args = process.argv.slice(2);
assert(
  args.every((arg) => arg === "--with-node") && args.length <= 1,
  "Usage: npm run dev:smoke -- [--with-node]",
);
assert(npmCli, "Run this journey through npm run dev:smoke.");
assert(process.platform !== "win32", "This process-group smoke requires Linux or macOS.");
const withNode = args.includes("--with-node");
const origin = "http://localhost:5173";
const controller = new AbortController();
const abort = () => controller.abort(new Error("Contributor journey interrupted."));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const database = new SmokeDatabase();
const processes = [];
const secrets = new Set();
const password = randomBytes(24).toString("hex");
const databasePassword = randomBytes(24).toString("hex");
secrets.add(password);
secrets.add(databasePassword);
let directory;
let stage = "fresh checkout";
let failure;
let databaseUrl = process.env.OPENBOT_DEV_SMOKE_DATABASE_URL;

function phase(name) {
  stage = name;
  console.log(`Contributor journey: ${name}.`);
}
async function ready(label, operation, children, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    for (const child of children) child.assertRunning();
    try {
      if (await operation()) return;
    } catch {}
    await delay(200, undefined, { signal: controller.signal });
  }
  throw new Error(
    `Timed out waiting for ${label}. Check the named service and its bounded diagnostic log.`,
  );
}
async function request(path, { cookie, method = "GET", body, expected = 200 } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(
    response.status,
    expected,
    `${path} returned HTTP ${response.status}; expected ${expected}.`,
  );
  return response;
}
async function startDevelopment(env) {
  const child = startProcess({
    args: [npmCli, "run", "dev"],
    cwd: root,
    env,
    label: "Server/Web development command",
  });
  processes.push(child);
  await ready("Server health on port 3001", async () => {
    const response = await fetch("http://127.0.0.1:3001/health", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    });
    const value = await response.json();
    return response.ok && value.ok === true && value.service === "openbot-server";
  }, [child]);
  await ready(
    "Web development entry on port 5173",
    async () => (await (await request("/")).text()).includes("/src/main.tsx"),
    [child],
  );
  await ready(
    "Web-to-Server health proxy",
    async () => (await (await request("/health")).json()).ok === true,
    [child],
  );
  return child;
}

try {
  await assertFreshCheckout(root);
  await assertPortFree(3001);
  await assertPortFree(5173);
  if (databaseUrl) validateDatabaseUrl(databaseUrl);
  else {
    phase("starting owned loopback PostgreSQL (first run may download the pinned image)");
    databaseUrl = await database.start(controller.signal, databasePassword);
  }
  secrets.add(databaseUrl);
  // The explicit database is checked before any process can migrate it; no existing data is reset.
  phase("checking disposable empty PostgreSQL");
  const postgres = createRequire(new URL("../packages/db/package.json", import.meta.url))(
    "postgres",
  );
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 5000 },
  });
  try {
    const [result] =
      await sql`select count(*)::int as count from pg_catalog.pg_tables where schemaname not like 'pg_%' and schemaname <> 'information_schema'`;
    assert.equal(
      result.count,
      0,
      "The startup database contains tables. Supply a new empty disposable database; nothing was reset.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  directory = await mkdtemp(join(tmpdir(), "openbot-dev-smoke-"));
  const baseEnv = isolatedEnvironment({ directory, npmCli });
  const env = {
    ...baseEnv,
    OPENBOT_HOST: "127.0.0.1",
    OPENBOT_PORT: "3001",
    OPENBOT_DATABASE_URL: databaseUrl,
    OPENBOT_OWNER_PASSWORD: password,
    OPENBOT_ALLOWED_ORIGINS: origin,
    OPENBOT_SECURE_COOKIES: "false",
    OPENBOT_OBJECT_STORE_PATH: join(directory, "objects"),
    OPENBOT_MODEL_DIRECTORY: join(directory, "model"),
  };
  phase("starting fresh Server/Web through npm run dev");
  let dev = await startDevelopment(env);
  phase("Owner login and authenticated API through the development proxy");
  await request("/api/v1/workspace", { expected: 401 });
  const login = await request("/api/v1/auth/login", { method: "POST", body: { password } });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert(cookie?.startsWith("openbot_session="), "Owner login did not return its session cookie.");
  secrets.add(cookie);
  secrets.add(cookie.slice(cookie.indexOf("=") + 1));
  const session = await (await request("/api/v1/auth/session", { cookie })).json();
  assert.equal(session.authenticated, true, "Owner session was not authenticated.");
  await request("/api/v1/channels", { cookie });
  let node;
  let nodeEnv;
  let identity;
  let enrollment;
  const nodeId = `smoke-${randomBytes(8).toString("hex")}`;
  const identityPath = join(directory, "node", "identity.json");
  const connectedIdentity = async () => {
    const result = await (await request("/api/v1/node-identities", { cookie })).json();
    return result.identities.find(
      (item) => item.nodeId === nodeId && item.connected === true && item.status === "active",
    );
  };
  const startNode = (configuration) => {
    const child = startProcess({
      args: [npmCli, "run", "dev:node"],
      cwd: root,
      env: configuration,
      label: "Node development command",
    });
    processes.push(child);
    return child;
  };
  if (withNode) {
    phase("Owner-authorized one-time development Node enrollment");
    enrollment = await (
      await request("/api/v1/nodes/enrollment-tokens", {
        cookie,
        method: "POST",
        body: { nodeId },
        expected: 201,
      })
    ).json();
    assert.equal(typeof enrollment.token, "string", "Server did not issue an enrollment token.");
    secrets.add(enrollment.token);
    nodeEnv = {
      ...baseEnv,
      OPENBOT_NODE_ID: nodeId,
      OPENBOT_NODE_SERVER_URL: "ws://127.0.0.1:3001/ws/nodes",
      OPENBOT_NODE_WORK_DIRECTORY: join(directory, "node"),
      OPENBOT_NODE_CREDENTIAL_PATH: identityPath,
      OPENBOT_NODE_CREDENTIAL_STORE: "file",
    };
    node = startNode({ ...nodeEnv, OPENBOT_NODE_ENROLLMENT_TOKEN: enrollment.token });
    await ready("enrolled Node connection", connectedIdentity, [dev, node]);
    identity = await readRetainedIdentity(identityPath, nodeId);
    secrets.add(identity.credential);
    const registered = await connectedIdentity();
    assert.equal(
      registered.enrolledAt,
      identity.enrolledAt,
      "Server and file disagree on Node enrollment.",
    );
    assert.deepEqual(
      registered.node.capabilities,
      [],
      "The fixture Node must not acquire Provider capabilities.",
    );
    await request("/api/v1/nodes/enroll", {
      method: "POST",
      body: { nodeId, token: enrollment.token },
      expected: 401,
    });
    phase("stopping Node and observing disconnect before restart");
    await node.stop();
    await ready("Node disconnect", async () => !(await connectedIdentity()), [dev], 10_000);
  }
  phase("restarting Server/Web with retained fixture state");
  await dev.stop();
  await assertPortFree(3001);
  await assertPortFree(5173);
  dev = await startDevelopment(env);
  const retainedSession = await (await request("/api/v1/auth/session", { cookie })).json();
  assert.equal(
    retainedSession.authenticated,
    true,
    "Owner session was not retained across Server restart.",
  );
  await request("/api/v1/workspace", { cookie });
  if (withNode) {
    phase("reconnecting Node from retained identity without bootstrap or environment credentials");
    node = startNode(nodeEnv);
    await ready("retained Node reconnect", connectedIdentity, [dev, node]);
    const retained = await readRetainedIdentity(identityPath, nodeId);
    secrets.add(retained.credential);
    assert.equal(retained.digest, identity.digest, "Node identity file changed across restart.");
    assert.equal(
      (await connectedIdentity()).enrolledAt,
      identity.enrolledAt,
      "Server replaced the retained Node identity.",
    );
  }
  console.log(
    `Fresh contributor journey passed: Server/Web, login, retained Owner session${withNode ? ", one-time Node enrollment and retained identity reconnect" : " (Node not requested)"}. No model or Provider was invoked.`,
  );
} catch (error) {
  failure = new Error(`Contributor journey failed at ${stage}: ${redact(error.message, secrets)}`);
  for (const child of processes) {
    const output = redact(child.output(), secrets);
    if (output) console.error(`${child.label} diagnostics (bounded):\n${output}`);
  }
} finally {
  for (const child of [...processes].reverse()) {
    try {
      await child.stop();
    } catch (error) {
      failure ??= error;
    }
  }
  try {
    await database.stop();
  } catch (error) {
    failure ??= error;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
if (failure) {
  console.error(redact(failure.message, secrets));
  process.exitCode = 1;
}
