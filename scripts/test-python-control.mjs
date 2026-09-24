import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readSteering } from "../apps/server/dist/agent-steering.js";
import { createApp } from "../apps/server/dist/app.js";
import { OwnerAuthService } from "../apps/server/dist/owner-auth.js";
import { PostgresAgentStore } from "../apps/server/dist/postgres-agent-store.js";
import { PostgresRequestThrottleStore } from "../apps/server/dist/postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "../apps/server/dist/postgres-session-store.js";
import { PostgresControlPlaneStore } from "../apps/server/dist/postgres-store.js";
import { RequestThrottle } from "../apps/server/dist/request-throttle.js";
import { createDatabase } from "../packages/db/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const image =
  "postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0";
const name = `openbot-control-${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const environment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
let owned = false;
let fixtureDirectory;
let database;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0 || result.error) throw new Error(`${command} fixture command failed.`);
  return result.stdout.trim();
}
function removeContainer() {
  if (owned) {
    const removed = spawnSync("docker", ["rm", "--force", name], {
      env: environment,
      stdio: "ignore",
      timeout: 20_000,
    });
    if (removed.status !== 0) console.error(`Could not remove owned fixture ${name}.`);
    owned = false;
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    removeContainer();
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
try {
  assert(
    existsSync(join(root, "apps/agent-runtime-python/.venv/bin/python")),
    "Bootstrap apps/agent-runtime-python before the persisted SDK/control acceptance gate.",
  );
  run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  run("docker", [
    "create",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER=openbot_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=openbot_control_test_reference",
    "--tmpfs",
    "/var/lib/postgresql/data",
    image,
    "-c",
    "client_min_messages=warning",
  ]);
  owned = true;
  run("docker", ["start", name]);
  const binding = run("docker", ["port", name, "5432/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const dsn = `postgres://openbot_test:${password}@${binding}/openbot_control_test_reference`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "openbot_test",
        "-d",
        "openbot_control_test_reference",
      ],
      {
        env: environment,
        stdio: "ignore",
        timeout: 5000,
      },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await delay(250);
  }
  assert(ready, "Owned PostgreSQL did not become ready.");
  database = createDatabase(dsn);
  await database.migrate();
  const store = new PostgresControlPlaneStore(database.db);
  const throttle = new RequestThrottle(new PostgresRequestThrottleStore(database.db));
  const ownerPassword = randomBytes(24).toString("hex");
  const auth = new OwnerAuthService(
    new PostgresOwnerSessionStore(database.db),
    {
      ownerName: "验收 Owner",
      ownerPassword,
      sessionTtlMs: 600_000,
    },
    throttle,
  );
  const bot = await store.createBot({
    name: "研究员一",
    role: "核对材料",
    computerProfile: "none",
    appearance: {
      head: "cat",
      body: "classic",
      mobility: "feet",
      accessory: "none",
      accent: "blue",
    },
  });
  const colleague = await store.createBot({
    name: "同事二",
    role: "复核",
    computerProfile: "none",
  });
  const messageChannel = await store.createChannel({
    name: "迁移验收",
    description: "中文附件核对",
    botIds: [bot.id, colleague.id],
  });
  const emptyChannel = await store.createChannel({
    name: "空频道",
    description: "没有成员",
    botIds: [],
  });
  for (let index = 0; index < 105; index += 1) {
    const authorType = ["human", "bot", "system"][index % 3];
    await database.client`
      INSERT INTO messages (id, channel_id, author_type, author_id, reply_to_message_id,
                            run_id, content, created_at)
      VALUES (${`fixture-message-${index}`}, ${messageChannel.id}, ${authorType},
              ${authorType === "human" ? "owner" : authorType === "bot" ? bot.id : null},
              ${index > 0 ? `fixture-message-${index - 1}` : null},
              ${authorType === "bot" ? "fixture-run-reference" : null},
              ${`记录 ${index}: 中文 🧪\n<example> & quoted "text"`},
              ${new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()})`;
  }
  const runChannel = await store.createChannel({
    name: "TS task reference",
    description: "",
    botIds: [bot.id],
  });
  const seedTask = await store.submitTask(runChannel.id, { content: "TS 原生任务参考" });
  await database.client`UPDATE runs SET status='completed', result_summary='已核查',
    model_usage=${JSON.stringify({ provider: "deepseek", model: "fixture", steps: 1, inputTokens: null, outputTokens: 2 })}::jsonb WHERE id=${seedTask.run.id}`;
  await store.joinBotToChannel(runChannel.id, colleague.id);
  await database.client`INSERT INTO runs(id,parent_run_id,root_run_id,delegated_by_bot_id,channel_id,bot_id,
    execution_profile,instruction,title,status,error_message,error_code,model_usage,created_at,updated_at)
    VALUES ('fixture-child-run',${seedTask.run.id},${seedTask.run.id},${bot.id},${runChannel.id},${colleague.id},
      'none','子任务','子任务','failed','权限已撤销','scope_revoked','{"unknown":"must not leak"}'::jsonb,
      now()+interval '1 second',now()+interval '1 second')`;

  await store.getOrCreateDirectConversation(bot.id);
  const app = createApp({
    store,
    auth,
    requestThrottle: throttle,
    listNodes: () => [],
    allowedOrigins: ["http://localhost"],
    secureCookies: false,
    getRemoteAddress: () => "127.0.0.1",
  });
  const login = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(login.status, 200, "Fixture Owner login failed.");
  const token = login.headers.get("set-cookie")?.match(/^openbot_session=([^;]+)/)?.[1];
  assert(token, "Fixture session cookie is required.");
  const additionalLogin = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(additionalLogin.status, 200);
  const tsRevocableToken = additionalLogin.headers
    .get("set-cookie")
    ?.match(/^openbot_session=([^;]+)/)?.[1];
  assert(tsRevocableToken);
  const expected = {};
  for (const path of [
    "/api/v1/auth/session",
    "/api/v1/bots",
    "/api/v1/channels",
    `/api/v1/channels/${messageChannel.id}/messages`,
    `/api/v1/channels/${emptyChannel.id}/messages`,
    `/api/v1/channels/${runChannel.id}/runs`,
    `/api/v1/channels/${emptyChannel.id}/runs`,
  ]) {
    const response = await app.request(path, { headers: { Cookie: `openbot_session=${token}` } });
    assert.equal(response.status, 200);
    expected[path] = await response.json();
  }
  fixtureDirectory = await mkdtemp(join(tmpdir(), "openbot-control-fixture-"));
  const fixture = join(fixtureDirectory, "reference.json");
  await writeFile(
    fixture,
    JSON.stringify({
      dsn,
      token,
      tsRevocableToken,
      ownerPassword,
      ownerName: "验收 Owner",
      expected,
      authResult: join(fixtureDirectory, "auth-result.json"),
      identityResult: join(fixtureDirectory, "identity-result.json"),
      conversationResult: join(fixtureDirectory, "conversation-result.json"),
      profileResult: join(fixtureDirectory, "profile-result.json"),
      taskResult: join(fixtureDirectory, "task-result.json"),
      runCommandResult: join(fixtureDirectory, "run-command-result.json"),
      contextResult: join(fixtureDirectory, "context-result.json"),
      executionResult: join(fixtureDirectory, "execution-result.json"),
      artifactDirectory: join(fixtureDirectory, "artifacts"),
    }),
    {
      mode: 0o600,
    },
  );
  const result = spawnSync(
    join(root, "apps/server-python/.venv/bin/python"),
    [
      "-m",
      "pytest",
      "tests/test_postgres_integration.py",
      "tests/test_auth_postgres.py",
      "tests/test_identity_postgres.py",
      "tests/test_conversation_postgres.py",
      "tests/test_message_postgres.py",
      "tests/test_profile_postgres.py",
      "tests/test_task_postgres.py",
      "tests/test_run_command_postgres.py",
      "tests/test_execution_postgres.py",
      "tests/test_work_postgres.py",
      "tests/test_work_effects_postgres.py",
      "tests/test_work_publication_postgres.py",
      "tests/test_work_handoff_postgres.py",
      "tests/test_work_engine_binding_postgres.py",
      "tests/test_work_temporal_activity.py",
      "tests/test_work_temporal_effect.py",
      "tests/test_work_reconciliation_postgres.py",
      "tests/test_work_corrections_postgres.py",
      "tests/test_execution_sdk_postgres.py",
      "-q",
    ],
    {
      cwd: join(root, "apps/server-python"),
      env: { ...environment, OPENBOT_CONTROL_TEST_FIXTURE: fixture },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .replaceAll(password, "[fixture password]")
    .replaceAll(token, "[fixture token]")
    .replaceAll(tsRevocableToken, "[fixture token]")
    .replaceAll(ownerPassword, "[fixture password]");
  console.log(output.trim());
  assert.equal(result.status, 0, "Python/PostgreSQL compatibility checks failed.");
  // The Temporal SDK is optional in the default control venv. When a separately pinned SDK
  // interpreter is supplied, exercise the activity adapter and effect seam against this fixture.
  if (process.env.OPENBOT_TEMPORAL_TEST_PYTHON) {
    const temporal = spawnSync(
      process.env.OPENBOT_TEMPORAL_TEST_PYTHON,
      [
        "-m",
        "pytest",
        "tests/test_work_temporal_activity.py",
        "tests/test_work_temporal_effect.py",
        "tests/test_work_model_receipts_postgres.py",
        "tests/test_work_worker_postgres.py",
        "tests/test_work_deferred_postgres.py",
        "tests/test_work_closed_repair_postgres.py",
        "tests/test_work_repair_dispatch.py",
        "tests/test_work_dispatch_entry.py",
        "-q",
      ],
      {
        cwd: join(root, "apps/server-python"),
        env: { ...environment, OPENBOT_CONTROL_TEST_FIXTURE: fixture },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      },
    );
    const temporalOutput = `${temporal.stdout ?? ""}${temporal.stderr ?? ""}`
      .replaceAll(password, "[fixture password]")
      .replaceAll(token, "[fixture token]")
      .replaceAll(tsRevocableToken, "[fixture token]")
      .replaceAll(ownerPassword, "[fixture password]");
    console.log(temporalOutput.trim());
    assert.equal(temporal.status, 0, "Temporal activity/PostgreSQL checks failed.");
  }
  const identityResult = JSON.parse(
    await readFile(join(fixtureDirectory, "identity-result.json"), "utf8"),
  );
  for (const [key, collection] of [
    ["bot", "bots"],
    ["channel", "channels"],
  ]) {
    const response = await app.request(`/api/v1/${collection}`, {
      headers: { Cookie: `openbot_session=${token}` },
    });
    assert.equal(response.status, 200);
    const actual = (await response.json())[collection].find(
      (value) => value.id === identityResult[key].id,
    );
    if (key === "channel") {
      actual.botIds.sort();
      identityResult[key].botIds.sort();
    }
    assert.deepEqual(
      actual,
      identityResult[key],
      "TS must project the committed Python identity identically.",
    );
  }
  const conversationResult = JSON.parse(
    await readFile(join(fixtureDirectory, "conversation-result.json"), "utf8"),
  );
  const channels = await app.request("/api/v1/channels", {
    headers: { Cookie: `openbot_session=${token}` },
  });
  assert.equal(channels.status, 200);
  assert.deepEqual(
    (await channels.json()).channels.find((value) => value.id === conversationResult.channel.id),
    conversationResult.channel,
    "TS must project the Python-created direct conversation identically.",
  );
  const profileResult = JSON.parse(
    await readFile(join(fixtureDirectory, "profile-result.json"), "utf8"),
  );
  const profileResponse = await app.request(`/api/v1/bots/${profileResult.employee.id}/profile`, {
    headers: { Cookie: `openbot_session=${token}` },
  });
  assert.equal(profileResponse.status, 200);
  const profile = (await profileResponse.json()).profile;
  assert.deepEqual(profile.employee, profileResult.employee);
  assert.deepEqual(profile.details, profileResult.details);
  assert.deepEqual(
    profile.evolution.find((event) => event.id === profileResult.evolution.id),
    profileResult.evolution,
  );
  const taskResult = JSON.parse(await readFile(join(fixtureDirectory, "task-result.json"), "utf8"));
  for (const key of ["messages", "runs"]) {
    const response = await app.request(`/api/v1/channels/${taskResult.message.channelId}/${key}`, {
      headers: { Cookie: `openbot_session=${token}` },
    });
    assert.equal(response.status, 200);
    const actual = (await response.json())[key];
    const expectedTaskRows = key === "messages" ? [taskResult.message] : taskResult.runs;
    assert.deepEqual(
      actual.sort((a, b) => a.id.localeCompare(b.id)),
      expectedTaskRows.sort((a, b) => a.id.localeCompare(b.id)),
      "TS must read all committed Python message/run records identically.",
    );
  }
  const runCommandResult = JSON.parse(
    await readFile(join(fixtureDirectory, "run-command-result.json"), "utf8"),
  );
  const native = new PostgresAgentStore(database.db);
  for (const expectedRun of [runCommandResult.run, ...runCommandResult.descendants]) {
    assert.deepEqual(
      await native.lookup(expectedRun.id),
      expectedRun,
      "TS must project Python cancellation and nullable usage identically.",
    );
  }
  const steeredRun = await native.lookup(runCommandResult.steering.runId);
  assert.deepEqual(
    await readSteering(database.db, steeredRun),
    [runCommandResult.steering],
    "TS must read a committed Python Owner instruction identically.",
  );
  const contextResult = JSON.parse(
    await readFile(join(fixtureDirectory, "context-result.json"), "utf8"),
  );
  assert.deepEqual(
    await native.context(contextResult.run),
    contextResult.context,
    "Actual TS context must use the same cutoff, reference priority and UTF-8 budget.",
  );
  assert.deepEqual(await native.tasks(contextResult.run), contextResult.tasks);
  const executionResult = JSON.parse(
    await readFile(join(fixtureDirectory, "execution-result.json"), "utf8"),
  );
  assert.deepEqual(
    await native.lookup(executionResult.run.id),
    executionResult.run,
    "TS must read the full Python completion identically.",
  );
  const delivery = await app.request(`/api/v1/channels/${executionResult.run.channelId}/messages`, {
    headers: { Cookie: `openbot_session=${token}` },
  });
  assert.equal(delivery.status, 200);
  assert.deepEqual(
    (await delivery.json()).messages.find((value) => value.id === executionResult.message.id),
    executionResult.message,
    "TS must read the Python Bot reply identically.",
  );
  const storedArtifacts =
    await database.client`SELECT id,run_id,storage_key,sha256,metadata FROM artifacts WHERE run_id=${executionResult.run.id}`;
  assert.equal(storedArtifacts.length, 1);
  assert.equal(storedArtifacts[0].storage_key, executionResult.storageKey);
  const bytes = await readFile(join(fixtureDirectory, "artifacts", executionResult.storageKey));
  assert.equal(bytes.length, executionResult.artifacts[0].sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), storedArtifacts[0].sha256);
  assert.equal(storedArtifacts[0].sha256, executionResult.artifacts[0].sha256);
  assert.equal(storedArtifacts[0].metadata.sizeBytes, bytes.length);
  const authResult = JSON.parse(await readFile(join(fixtureDirectory, "auth-result.json"), "utf8"));
  assert.match(authResult.pythonToken, /^[A-Za-z0-9_-]{43}$/);
  const pythonSession = await app.request("/api/v1/auth/session", {
    headers: { Cookie: `openbot_session=${authResult.pythonToken}` },
  });
  assert.equal(
    (await pythonSession.json()).authenticated,
    true,
    "TS must recognize the Python-issued session.",
  );
  const revoked = await app.request("/api/v1/auth/session", {
    headers: { Cookie: `openbot_session=${tsRevocableToken}` },
  });
  assert.deepEqual(
    await revoked.json(),
    { authenticated: false },
    "TS must recognize Python revocation.",
  );
  const logout = await app.request("/api/v1/auth/logout", {
    method: "POST",
    headers: { Cookie: `openbot_session=${authResult.pythonToken}`, Origin: "http://localhost" },
  });
  assert.equal(logout.status, 204);
  const noSession = await auth.authenticate(authResult.pythonToken);
  assert.deepEqual(noSession, { authenticated: false });
  console.log(
    "Python/TypeScript reads, session issuance/revocation and real PostgreSQL/HTTP checks passed.",
  );
} finally {
  try {
    if (database) await database.close();
  } finally {
    removeContainer();
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  }
}
