import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../packages/db/dist/index.js";
import { readSteering } from "../tests/oracles/legacy-server/dist/agent-steering.js";
import { createApp } from "../tests/oracles/legacy-server/dist/app.js";
import { OwnerAuthService } from "../tests/oracles/legacy-server/dist/owner-auth.js";
import { PostgresAgentStore } from "../tests/oracles/legacy-server/dist/postgres-agent-store.js";
import { PostgresRequestThrottleStore } from "../tests/oracles/legacy-server/dist/postgres-request-throttle-store.js";
import { PostgresOwnerSessionStore } from "../tests/oracles/legacy-server/dist/postgres-session-store.js";
import { PostgresControlPlaneStore } from "../tests/oracles/legacy-server/dist/postgres-store.js";
import { RequestThrottle } from "../tests/oracles/legacy-server/dist/request-throttle.js";
import { FIXTURE_PASSWORD, FIXTURE_TOKEN, redactFixtureOutput } from "./output-redaction.ts";
import {
  allowlistedEnvironment,
  cleanupOnTerminationSignals,
  createControlDatabase,
  OwnedDockerFixture,
  readWorkerTests,
  runFixtureCommand,
  startControlPostgres,
  writePrivateFixture,
} from "./python-acceptance-fixture.ts";

// Stays JavaScript: the frozen oracle is compiled without declarations and must keep loading
// from dist; typed fixture lifetime and redaction live in the imported TypeScript helpers.
const root = fileURLToPath(new URL("../", import.meta.url));
// The base check excludes exactly these files; this invocation executes them with the Worker closure.
const workerTests = await readWorkerTests(root);
const controlTests = [
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
  "tests/test_product_control.py",
  "tests/test_http_input_lifecycle.py",
  "tests/test_work_sources_postgres.py",
  "tests/test_work_command_codec.py",
  "tests/test_work_command_v2.py",
  "tests/test_model_settings.py",
  "tests/test_model_presets.py",
  "tests/test_skill_yaml.py",
  "tests/test_employee_knowledge.py",
  "tests/test_employee_portability.py",
  "tests/test_automation_store.py",
  "tests/test_conversation_interactions.py",
  "tests/test_identity_lifecycle.py",
  "tests/test_attachment_processing.py",
  "tests/test_plugin_service.py",
  "tests/test_plugin_catalog.py",
  "tests/test_plugin_transport.py",
  "tests/test_worker_host_identity.py",
  "tests/test_worker_host_protocol.py",
  "tests/test_worker_host_socket.py",
  "tests/test_browser_sessions.py",
  "tests/test_knowledge_runtime.py",
  "tests/test_product_extensions.py",
];
const name = `openbot-control-${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const environment = allowlistedEnvironment([
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
]);
const docker = new OwnedDockerFixture(root, environment);
let fixtureDirectory;
let database;
function run(command, args, options = {}) {
  return runFixtureCommand(command, args, { cwd: root, env: environment, ...options });
}
// Prints only redacted pytest output; the caller asserts the status after the log is visible.
function pytest(python, files, env, timeout, redactions) {
  const result = spawnSync(
    python,
    ["-m", "pytest", ...files, "-v", "-o", "faulthandler_timeout=45", "--durations=10"],
    {
      cwd: join(root, "apps/server-python"),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    },
  );
  console.log(
    redactFixtureOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`, redactions).trim(),
  );
  return result;
}
cleanupOnTerminationSignals(() => {
  docker.cleanup();
  if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
});
try {
  assert(
    existsSync(join(root, "packages/harness/.venv/bin/python")),
    "Bootstrap packages/harness before the persisted SDK/control acceptance gate.",
  );
  if (process.env.OPENBOT_TEMPORAL_TEST_PYTHON) {
    // Worker qualification starts a real Node from source; its workspace imports need
    // the complete dependency closure even when the legacy oracle does not use it.
    console.log(
      run(
        process.execPath,
        [join(root, "node_modules/turbo/bin/turbo"), "run", "build", "--filter=@openbot/node^..."],
        {
          // Keep npm's toolchain/platform cache identity through this otherwise scrubbed environment.
          env: { ...environment, npm_config_user_agent: process.env.npm_config_user_agent },
        },
      ),
    );
    console.log(
      run(process.env.OPENBOT_TEMPORAL_TEST_PYTHON, [
        join(root, "apps/server-python/scripts/verify_environment.py"),
        "--worker",
      ]),
    );
  }
  const dsn = await startControlPostgres(docker, name, password);
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
      // Disposable suite exceeds ten minutes; retain the original session through both profiles.
      sessionTtlMs: 1_800_000,
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
  await writePrivateFixture(fixture, {
    dsn,
    token,
    tsRevocableToken,
    ownerPassword,
    ownerName: "验收 Owner",
    expected,
    botId: bot.id,
    channelId: messageChannel.id,
    authResult: join(fixtureDirectory, "auth-result.json"),
    identityResult: join(fixtureDirectory, "identity-result.json"),
    conversationResult: join(fixtureDirectory, "conversation-result.json"),
    profileResult: join(fixtureDirectory, "profile-result.json"),
    taskResult: join(fixtureDirectory, "task-result.json"),
    runCommandResult: join(fixtureDirectory, "run-command-result.json"),
    contextResult: join(fixtureDirectory, "context-result.json"),
    executionResult: join(fixtureDirectory, "execution-result.json"),
    artifactDirectory: join(fixtureDirectory, "artifacts"),
  });
  const result = pytest(
    join(root, "apps/server-python/.venv/bin/python"),
    controlTests,
    {
      ...environment,
      OPENBOT_CONTROL_TEST_FIXTURE: fixture,
      OPENBOT_TS_SOURCE_ROOT: root,
      OPENBOT_PROTOCOL_ORACLE_ROOT: root,
    },
    // The full base profile now contains more than 800 database checks.
    300_000,
    [
      [password, FIXTURE_PASSWORD],
      [token, FIXTURE_TOKEN],
      [tsRevocableToken, FIXTURE_TOKEN],
      [ownerPassword, FIXTURE_PASSWORD],
    ],
  );
  assert.equal(
    result.status,
    0,
    `Python/PostgreSQL compatibility checks failed (code=${result.error?.code ?? "none"}, signal=${result.signal ?? "none"}).`,
  );
  // The full Worker SDK closure is optional in the default control venv. Model-connection
  // tests delete all connections, so their fixture must never share the general database.
  if (process.env.OPENBOT_TEMPORAL_TEST_PYTHON) {
    // Each dedicated database is created, migrated, history-checked, given its own Owner
    // session and closed before the Worker run; only its 0600 descriptor reaches Python.
    const createIsolatedFixture = async (
      databaseName,
      ownerName,
      sessionSeed,
      historyMessage,
      fixturePath,
      describe,
    ) => {
      const isolatedDsn = createControlDatabase(docker, name, dsn, databaseName);
      const isolatedDatabase = createDatabase(isolatedDsn);
      try {
        await isolatedDatabase.migrate();
        assert.deepEqual(
          Array.from(
            await isolatedDatabase.client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          ),
          Array.from(
            await database.client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          ),
          historyMessage,
        );
        const isolatedAuth = new OwnerAuthService(
          new PostgresOwnerSessionStore(isolatedDatabase.db),
          { ownerName, ownerPassword, sessionTtlMs: 1_800_000 },
          new RequestThrottle(new PostgresRequestThrottleStore(isolatedDatabase.db)),
        );
        const { token: isolatedToken } = await isolatedAuth.login(
          ownerPassword,
          createHash("sha256").update(sessionSeed).digest("hex"),
        );
        await writePrivateFixture(
          fixturePath,
          await describe(isolatedDatabase, isolatedDsn, isolatedToken),
        );
        return isolatedToken;
      } finally {
        await isolatedDatabase.close();
      }
    };
    const modelFixture = join(fixtureDirectory, "model-connections.json");
    const modelToken = await createIsolatedFixture(
      "openbot_control_test_model_connections",
      "Model fixture Owner",
      "owned-model-connection-fixture",
      "The dedicated model fixture must have the complete canonical migration history.",
      modelFixture,
      async (modelDatabase, modelDsn, sessionToken) => {
        const modelChannel = await new PostgresControlPlaneStore(modelDatabase.db).createChannel({
          name: "Isolated model fixture",
          description: "Synthetic model-connection tests only",
          botIds: [],
        });
        return { dsn: modelDsn, token: sessionToken, channelId: modelChannel.id };
      },
    );
    // Command authority tests need a dedicated disposable source/profile database too.
    // Reuse this invocation's owned PostgreSQL lifecycle; never share the model-delete fixture.
    const commandFixture = join(fixtureDirectory, "commands.json");
    const commandToken = await createIsolatedFixture(
      "openbot_control_test_commands",
      "Command fixture Owner",
      "owned-command-authority-fixture",
      "The command fixture must have the complete canonical migration history.",
      commandFixture,
      async (_commandDatabase, commandDsn, sessionToken) => ({
        dsn: commandDsn,
        token: sessionToken,
        fixtureKind: "work-command-authority",
      }),
    );
    const temporal = pytest(
      process.env.OPENBOT_TEMPORAL_TEST_PYTHON,
      workerTests,
      {
        ...environment,
        OPENBOT_CONTROL_TEST_FIXTURE: fixture,
        OPENBOT_MODEL_CONNECTION_TEST_FIXTURE: modelFixture,
        OPENBOT_MODEL_CONNECTION_SOURCE_ROOT: root,
        OPENBOT_COMMAND_TEST_FIXTURE: commandFixture,
        PYTHONPATH: [
          join(root, "experiments/work-journey"),
          join(root, "experiments/linux-execution"),
          join(root, "apps/server-python/src"),
        ].join(delimiter),
      },
      // The 1,527-case Worker profile takes 607s on the pinned Node/Python toolchain.
      // Keep a bounded runner and the 45s faulthandler; per-operation limits stay unchanged.
      900_000,
      [
        [password, FIXTURE_PASSWORD],
        [token, FIXTURE_TOKEN],
        [modelToken, FIXTURE_TOKEN],
        [commandToken, FIXTURE_TOKEN],
        [tsRevocableToken, FIXTURE_TOKEN],
        [ownerPassword, FIXTURE_PASSWORD],
      ],
    );
    assert.equal(temporal.status, 0, "Worker/model-connection PostgreSQL checks failed.");
  } else {
    console.log(
      "Worker checks NOT RUN: set OPENBOT_TEMPORAL_TEST_PYTHON to the reviewed Worker interpreter for full acceptance.",
    );
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
    docker.cleanup();
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  }
}
