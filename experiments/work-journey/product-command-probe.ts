/** Actual TS product journey with an explicit native CI Host or the existing synthetic local peer. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@temporalio/client";
import proto from "@temporalio/proto";
import { createDatabase } from "@openbot/db";
import { z } from "zod";
import {
  commandPreparationBindingSchema,
  nodeEnrollmentTokenResponseSchema,
  workSnapshotWireSchema,
} from "../../packages/protocol/dist/index.js";
import { Profile } from "../../deploy/temporal/maintain.ts";
import { DevProcessOwner } from "../../scripts/dev-processes.ts";
import {
  allowlistedEnvironment,
  OwnedDockerFixture,
  startControlPostgres,
} from "../../scripts/python-acceptance-fixture.ts";
import {
  startCommandHost,
  commandArguments,
  commandCsv,
} from "../../scripts/integration/command-host.ts";
import { startTemporalFixture } from "../../scripts/temporal-fixture.ts";
import { NativeProductController, reserveLoopbackPort } from "./product-native-controller.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SUMMARY =
  "The supplied values 12, 8 and 5 total 25. The command output and report are attached.";
const REPORT =
  "# Synthetic command result\n\nThe supplied CSV contains 12, 8 and 5; their sum is **25**.\n";
const emit = (value: unknown) => console.log(JSON.stringify(value));
const record = z.record(z.string(), z.unknown());
const privateJson = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value), { mode: 0o600 });
const idAt = (value: unknown, key: string) =>
  z.object({ id: z.string() }).parse(record.parse(value)[key]).id;
export async function qualifyCommand(options: {
  directory: string;
  bundle: string;
  nativeConfig?: string;
  claimApprovalRace: boolean;
}) {
  process.umask(0o077);
  const directory = resolve(options.directory);
  await mkdir(directory, { mode: 0o700 });
  for (const name of ["artifacts", "objects", "provider", "work-files", "api"])
    await mkdir(join(directory, name), { mode: 0o700 });
  const environment = allowlistedEnvironment([
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
  ]);
  const docker = new OwnedDockerFixture(ROOT, environment),
    logs: number[] = [];
  const processes = new DevProcessOwner({
    cwd: ROOT,
    createChild(command, args, settings) {
      const log = openSync(join(directory, `process-${logs.length}.log`), "wx", 0o600);
      logs.push(log);
      return spawn(command, [...args], { ...settings, stdio: ["pipe", log, log] });
    },
  });
  const nodeProcesses = new DevProcessOwner({
    cwd: ROOT,
    createChild(command, args, settings) {
      const log = openSync(join(directory, "node.log"), "wx", 0o600);
      logs.push(log);
      return spawn(command, [...args], { ...settings, stdio: ["pipe", log, log] });
    },
  });
  const route = {
    nodeId: "command-product-" + randomBytes(6).toString("hex"),
    providerId: "linux-command",
    enforcementKeyId: "product-enforcer-key",
    ledgerId: randomUUID(),
  };
  const timing = {
    prepareBudgetMs: 30000,
    challengeBudgetMs: 5000,
    runtimeMaxMs: 50000,
    stopAllowanceMs: 5000,
    clockRateErrorPpm: 1000,
    clockQuantizationMs: 100,
    policyDigest: "e".repeat(64),
  };
  const control = generateKeyPairSync("ed25519"),
    enforcer = generateKeyPairSync("ed25519");
  const publicControl = control.publicKey.export({ type: "spki", format: "pem" }).toString();
  const controlPath = join(directory, "control.pem"),
    commandConfig = join(directory, "command.json");
  await writeFile(controlPath, control.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  let database: ReturnType<typeof createDatabase> | undefined,
    engine: Awaited<ReturnType<typeof startTemporalFixture>> | undefined;
  let remote: NativeProductController | undefined,
    host: Awaited<ReturnType<typeof startCommandHost>> | undefined;
  let reservation: Awaited<ReturnType<typeof reserveLoopbackPort>> | undefined,
    server: ChildProcess | undefined;
  let enrollmentIssued = false,
    cookie = "",
    origin = "",
    failing = true;
  const api = async (path: string, body?: unknown, expected = 200) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `Owned product HTTP status: ${path}`);
    if (path === "/api/v1/auth/login") {
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert(cookie);
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  const until = async <T>(read: () => Promise<T | undefined | false>, seconds = 75): Promise<T> => {
    const deadline = performance.now() + seconds * 1000;
    while (performance.now() < deadline) {
      assert(
        server && server.exitCode === null && server.signalCode === null,
        "Owned product Server exited; private log retained.",
      );
      const value = await read();
      if (value !== undefined && value !== false) return value;
      await delay(200);
    }
    throw new Error("Product command checkpoint timed out; private evidence retained.");
  };
  try {
    const dsn = await startControlPostgres(
      docker,
      "openbot-command-" + randomUUID(),
      randomBytes(24).toString("hex"),
    );
    database = createDatabase(dsn);
    await database.migrate();
    const [migrations] =
      await database.client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations`;
    reservation = await reserveLoopbackPort();
    const port = reservation.port;
    origin = `http://127.0.0.1:${port}`;
    let enforcementPublic = enforcer.publicKey.export({ type: "spki", format: "pem" }).toString();
    if (options.nativeConfig) {
      remote = await NativeProductController.open(options.nativeConfig, directory);
      const ownedReservation = reservation;
      reservation = undefined;
      enforcementPublic = await remote.stage(
        route,
        timing,
        publicControl,
        options.bundle,
        ownedReservation,
      );
    }
    const pin = join(directory, "enforcer.pub");
    await writeFile(pin, enforcementPublic, { mode: 0o600 });
    await privateJson(commandConfig, {
      version: 1,
      route,
      timing,
      policy: {
        id: "offline-command",
        image: "python@sha256:6e13e65c55e33adf203d77ee371cf8bf5d81bd4902ef07565721f46bf44917af",
        limits: {
          nanoCPUs: 1000000000,
          memoryMiB: 256,
          pids: 128,
          nofile: 64,
          tmpMiB: 16,
          wallSeconds: 60,
          outputMiB: 64,
          capturedOutputKiB: 1024,
        },
      },
      control: {
        issuer: "product-control",
        keyId: "product-control-key",
        privateKeyPath: controlPath,
      },
      enforcement: {
        issuer: "product-enforcer",
        keyId: route.enforcementKeyId,
        publicKeyPath: pin,
      },
    });
    engine = await startTemporalFixture({
      createProfile: async (env, project) => {
        const profile = new Profile(env, project, true),
          command = profile.command;
        profile.command = (args, input) =>
          command(
            [
              "--file",
              join(ROOT, "experiments/work-journey/terminal-recovery/resources.yaml"),
              ...args,
            ],
            input,
          );
        return { profile, close: () => profile.command(["down", "--volumes", "--remove-orphans"]) };
      },
    });
    emit({ stage: "engine-ready", actualPostgres: true, mutualTLS: true });
    const enginePath = join(directory, "engine.json"),
      providerPath = join(directory, "provider.json"),
      password = randomBytes(24).toString("hex");
    await privateJson(enginePath, {
      temporal_address: engine.settings.address,
      namespace: "default",
      queue: "product-command-" + randomBytes(6).toString("hex"),
      tls: engine.settings.tls,
      interval_seconds: 1,
      execution_timeout_seconds: 600,
    });
    await privateJson(providerPath, {
      directory: join(directory, "provider"),
      claimApprovalRace: options.claimApprovalRace,
    });
    if (remote) await remote.releaseServerPort();
    else {
      assert(reservation);
      await reservation.close();
      reservation = undefined;
    }
    server = processes.start(
      process.execPath,
      ["--import", "tsx", "experiments/work-journey/product_command_ts_server.ts"],
      {
        ...environment,
        OPENBOT_CONTROL_DATABASE_URL: dsn,
        OPENBOT_CONTROL_PORT: String(port),
        OPENBOT_CONTROL_OWNER_PASSWORD: password,
        OPENBOT_CONTROL_AUTHORITY: "product",
        OPENBOT_CONTROL_WORK_TOKEN_LIMIT: "1000000",
        OPENBOT_CONTROL_OBJECT_ROOT: join(directory, "objects"),
        OPENBOT_CONTROL_ARTIFACT_ROOT: join(directory, "artifacts"),
        OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH: enginePath,
        OPENBOT_CONTROL_COMMAND_CONFIG_PATH: commandConfig,
        OPENBOT_COMMAND_PROBE_CONFIG: providerPath,
      },
    );
    await until(async () => {
      try {
        return record.parse(await api("/health")).ok === true;
      } catch (error) {
        if (
          error instanceof TypeError &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause &&
          error.cause.code === "ECONNREFUSED"
        )
          return false;
        throw error;
      }
    }, 45);
    await api("/api/v1/auth/login", { password });
    const connectionId = idAt(
      await api(
        "/api/v1/model-connections",
        {
          name: "Synthetic command model",
          presetId: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "synthetic-command-key",
        },
        201,
      ),
      "connection",
    );
    const botId = idAt(
      await api(
        "/api/v1/bots",
        {
          name: "Command product fixture",
          role: "Synthetic evidence analyst",
          computerProfile: "docker-linux",
          model: { connectionId, modelId: "synthetic-command-model" },
        },
        201,
      ),
      "bot",
    );
    const channelId = idAt(
      await api("/api/v1/channels", { name: "Command qualification", botIds: [botId] }, 201),
      "channel",
    );
    const upload = await fetch(`${origin}/api/v1/channels/${channelId}/attachments`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/octet-stream",
        "X-OpenBot-Filename": "evidence.csv",
      },
      body: new Uint8Array(commandCsv),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(upload.status, 201);
    const attachmentId = idAt(await upload.json(), "attachment");
    const enrolled = nodeEnrollmentTokenResponseSchema.parse(
      await api("/api/v1/nodes/enrollment-tokens", { nodeId: route.nodeId }, 201),
    );
    enrollmentIssued = true;
    if (remote) await remote.start(enrolled.token, port);
    else {
      host = await startCommandHost({
        directory: join(directory, "host"),
        route,
        timing,
        controlPublic: publicControl,
        enforcerPrivate: enforcer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      });
      const node = nodeProcesses.start(process.execPath, [options.bundle], environment);
      assert(node.stdin);
      node.stdin.on("error", () => {});
      node.stdin.end(
        JSON.stringify({
          version: 1,
          nodeId: route.nodeId,
          serverUrl: origin.replace("http:", "ws:") + "/ws/nodes",
          socketPath: host.socketPath,
          selection: route,
          enrollmentToken: enrolled.token,
        }),
      );
    }
    await until(
      async () =>
        z
          .object({ nodes: z.array(z.object({ id: z.string() })) })
          .parse(await api("/api/v1/nodes"))
          .nodes.some((v) => v.id === route.nodeId),
      15,
    );
    emit({
      stage: "actual-node-connected",
      ephemeralEnrollment: true,
      realWebSocket: true,
      syntheticNative: !remote,
    });
    const sourceRunId = idAt(
      await api(
        `/api/v1/channels/${channelId}/messages`,
        {
          botId,
          content:
            "Copy the authorized CSV to result.csv using run_command, then calculate the sum and write a Markdown report. Preserve all source rows. [OpenBot attachment: " +
            attachmentId +
            "]",
        },
        201,
      ),
      "run",
    );
    const [identity] =
      await database.client`SELECT s.task_id,r.id FROM work_sources s JOIN work_runs r ON r.task_id=s.task_id WHERE s.legacy_run_id=${sourceRunId}`;
    assert(identity);
    const taskId = z.string().parse(identity.task_id),
      runId = z.string().parse(identity.id);
    await privateJson(join(directory, "identity.json"), { taskId, runId, sourceRunId, route });
    const snapshot = async () => {
      const value = workSnapshotWireSchema.parse(await api("/api/v1/tasks/" + taskId));
      await privateJson(join(directory, "latest-snapshot.json"), value);
      assert(
        !["failed", "cancelled"].includes(value.status),
        "Product Task failed; private snapshot retained.",
      );
      return value;
    };
    const action = await until(async () =>
      (await snapshot()).actions.find((a) => a.intent.tool === "run_command"),
    );
    assert.equal(action.status, "proposed");
    assert.equal(action.decision, "pending");
    assert.deepEqual(action.intent.arguments, commandArguments);
    if (remote) await remote.assertUnprepared();
    else {
      assert(host);
      assert.deepEqual(host.state().calls, []);
    }
    if (options.claimApprovalRace)
      await until(async () => {
        try {
          await access(join(directory, "provider/claim-before-approval"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }, 40);
    await api(`/api/v1/actions/${action.id}/decision`, {
      intentDigest: action.intentDigest,
      approved: true,
    });
    if (options.claimApprovalRace)
      await writeFile(join(directory, "provider/owner-approved"), "", { mode: 0o600 });
    emit({ stage: "owner-approved-original-intent", noExecutionBeforeApproval: true });
    const completed = await until(async () => {
      const value = await snapshot();
      await privateJson(join(directory, "latest-snapshot.json"), value);
      return value.status === "completed" ? value : false;
    });
    assert.equal(completed.resultSummary, SUMMARY);
    assert.equal(completed.artifacts.length, 2);
    const expected: Record<string, Buffer> = {
      "result.csv": commandCsv,
      "command-report.md": Buffer.from(REPORT),
    };
    assert.deepEqual(completed.artifacts.map((v) => v.name).sort(), Object.keys(expected).sort());
    for (const artifact of completed.artifacts) {
      const response = await fetch(origin + artifact.downloadUrl, {
        headers: { Origin: origin, Cookie: cookie },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert(response.headers.get("content-disposition")?.startsWith("attachment;"));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected[artifact.name]);
    }
    const counts = JSON.parse(
      await readFile(join(directory, "provider/provider-count.json"), "utf8"),
    );
    assert.deepEqual(counts, { command: 1, report: 1, final: 1, review: 1 });
    if (host)
      for (const name of ["execute", "reserve"])
        assert.equal(host.state().calls.filter((v) => v === name).length, 1);
    const client = new Client({ connection: engine.connection, namespace: "default" }),
      handle = client.workflow.getHandle("openbot-work-ts-v1-" + runId);
    assert.equal(
      await engine.connection.withDeadline(Date.now() + 20000, () => handle.result()),
      undefined,
    );
    const rows =
      await database.client`SELECT binding FROM work_command_preparations WHERE task_id=${taskId} AND action_id=${action.id}`;
    assert.equal(rows.length, 1);
    const binding = commandPreparationBindingSchema.parse(rows[0]?.binding);
    for (const [key, value] of Object.entries({
      taskId,
      runId,
      actionId: action.id,
      intentDigest: action.intentDigest,
      ...route,
    }))
      assert.equal(Reflect.get(binding, key), value);
    const [preparations] =
      await database.client`SELECT count(*)::integer AS count FROM work_command_preparations WHERE task_id=${taskId}`;
    const [permits] =
      await database.client`SELECT count(*)::integer AS count FROM work_events WHERE task_id=${taskId} AND kind='command.permit_issued'`;
    const [applied] = await database.client`SELECT status FROM work_actions WHERE id=${action.id}`;
    assert.equal(preparations?.count, 1);
    assert.equal(permits?.count, 1);
    assert.equal(applied?.status, "applied");
    const history = await handle.fetchHistory(),
      historyPath = join(directory, "history.bin");
    await writeFile(historyPath, proto.temporal.api.history.v1.History.encode(history).finish(), {
      mode: 0o600,
    });
    await privateJson(
      join(directory, "history.json"),
      proto.temporal.api.history.v1.History.toObject(
        proto.temporal.api.history.v1.History.create(history),
        { longs: String, enums: String, bytes: String },
      ),
    );
    const replay = processes.start(
      process.execPath,
      [
        "--import",
        "tsx",
        "experiments/work-journey/product_command_ts_server.ts",
        "--replay",
        historyPath,
      ],
      environment,
    );
    const timeout = setTimeout(() => replay.kill("SIGKILL"), 30000);
    try {
      await processes.waitSuccess(replay);
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "provider/provider-count.json"), "utf8")),
      counts,
    );
    if (host) assert.equal(host.state().calls.filter((v) => v === "execute").length, 1);
    if (remote)
      await privateJson(join(directory, "remote-result.json"), await remote.finish(binding));
    const result = {
      entry: "ts",
      approvalWhileOriginalClaimHeld: options.claimApprovalRace,
      case: remote ? "product-command-native-ci" : "product-command-local-composition",
      actualOwnerHTTP: true,
      actualWorkApproval: true,
      actualPostgres: true,
      canonicalMigrations: migrations?.count,
      mutualTLS: true,
      actualProductEntry: true,
      actualNodeClient: true,
      actualWebSocket: true,
      actualUnixTransport: true,
      actualHostCrypto: true,
      syntheticNative: !remote,
      syntheticPeerIdentity: !remote,
      linuxIsolationQualified: !!remote,
      oneOriginalCommand: true,
      fullOutputSha256: createHash("sha256").update(commandCsv).digest("hex"),
      independentlyReviewed: true,
      artifactsDownloaded: 2,
      offlineReplay: true,
      modelCounts: counts,
    };
    await privateJson(join(directory, "result.json"), result);
    emit(result);
    failing = false;
  } catch (error) {
    await writeFile(
      join(directory, "failure-private.log"),
      error instanceof Error ? (error.stack ?? error.message) : "Qualification failed",
      { mode: 0o600 },
    ).catch(() => {});
    throw error;
  } finally {
    const errors: string[] = [];
    const cleanup = async (label: string, operation: () => unknown | Promise<unknown>) => {
      try {
        await operation();
      } catch {
        errors.push(label);
      }
    };
    await cleanup("node", () => nodeProcesses.stop());
    await cleanup("remote-original-run", () => remote?.close());
    if (server && enrollmentIssued)
      await cleanup("node-revocation", async () => {
        const identities = z
          .object({ identities: z.array(z.object({ nodeId: z.string(), status: z.string() })) })
          .parse(await api("/api/v1/node-identities"))
          .identities.filter((v) => v.nodeId === route.nodeId);
        assert(identities.length <= 1);
        if (identities[0]?.status === "active")
          await api(`/api/v1/nodes/${route.nodeId}/revoke`, {}, 204);
      });
    await cleanup("host", () => host?.close());
    await cleanup("api", () => processes.stop());
    await cleanup("database-client", () => database?.close());
    await cleanup("engine", () => engine?.close());
    await cleanup("postgres", () => docker.cleanup());
    await cleanup("port", () => reservation?.close());
    await cleanup("control-key", () => rm(controlPath, { force: true }));
    for (const fd of logs) await cleanup("log", () => closeSync(fd));
    emit({
      stage: "owned-resources-closed",
      controlPrivateKeyRemoved: !errors.includes("control-key"),
      cleanupComplete: errors.length === 0,
      cleanupFailures: errors,
    });
    if (!failing) assert.deepEqual(errors, [], "Owned cleanup failed.");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "node-bundle": { type: "string" },
      "native-ci-config": { type: "string" },
      "claim-approval-race": { type: "boolean", default: false },
    },
  });
  assert(values.output && values["node-bundle"]);
  qualifyCommand({
    directory: values.output,
    bundle: resolve(values["node-bundle"]),
    claimApprovalRace: values["claim-approval-race"],
    ...(values["native-ci-config"] ? { nativeConfig: resolve(values["native-ci-config"]) } : {}),
  }).catch(() => {
    console.error("Product command qualification failed; private evidence retained.");
    process.exitCode = 1;
  });
}
