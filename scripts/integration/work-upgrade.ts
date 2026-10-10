/** Actual TS Work histories across engine upgrade/restore; provider responses are synthetic. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@temporalio/client";
import { Worker, type WorkflowBundle } from "@temporalio/worker";
import { createDatabase } from "@openbot/db";
import { workSnapshotWireSchema } from "@openbot/protocol";
import { WORKFLOW_ID_PREFIX } from "@openbot/work";
import type { EntryOptions } from "../../apps/server/dist/config.js";
import type { startUpgradeTemporalFixture } from "../temporal-upgrade-fixture.ts";
type WorkSnapshotWire = ReturnType<typeof workSnapshotWireSchema.parse>;
type Engine = Awaited<ReturnType<typeof startUpgradeTemporalFixture>>;
type Stage = "approval" | "effect" | "publication";
async function until(check: () => Promise<boolean> | boolean, label: string, budget = 150000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error("Upgrade Work wait expired: " + label);
}
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function heldWork(dsn: string, engine: Engine, stage: Stage) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-upgrade-work-")));
  const admin = createDatabase(dsn),
    name = "upgrade_" + randomBytes(8).toString("hex");
  await admin.client.unsafe("CREATE DATABASE " + name);
  const url = new URL(dsn);
  url.pathname = "/" + name;
  const db = createDatabase(url.toString());
  const sql = db.client;
  let child: ChildProcess | undefined;
  const models: string[] = [];
  let paused = false;
  const stop = async (signal: "SIGKILL" | "SIGTERM" = "SIGTERM") => {
    const current = child;
    child = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    current.kill(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            current.kill("SIGKILL");
            reject(new Error("Owned Work child failed to stop."));
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    try {
      await stop();
    } finally {
      await Promise.all([db.close(), admin.close()]);
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await db.migrate();
    await mkdir(join(directory, "work"), { mode: 0o700 });
    const token = randomBytes(32).toString("base64url"),
      digest = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${randomUUID()},${digest},'owner',clock_timestamp()+interval '30 minutes')`;
    const bindPort = await port(),
      origin = "http://127.0.0.1:" + bindPort;
    const options: EntryOptions = {
      host: "127.0.0.1",
      port: bindPort,
      publicOrigin: origin,
      product: {
        databaseUrl: url.toString(),
        controlReads: true,
        workerRuntime: { browserRoutes: {}, humanControl: false, legacyHumanControl: false },
        files: { objectRoot: join(directory, "objects") },
        models: { keyPath: join(directory, "model.key"), customBaseUrls: [] },
        work: {
          address: engine.settings.address,
          namespace: "default",
          taskQueue: "openbot-work-ts-v1-" + randomUUID(),
          executionTimeoutMs: 1200000,
          fileRoot: join(directory, "work"),
          tls: {
            ca: engine.settings.tls.ca,
            certificate: engine.settings.tls.certificate,
            key: engine.settings.tls.key,
            serverName: engine.settings.tls.server_name,
          },
        },
      },
    };
    const start = async (mode: Stage | "resume") => {
      assert(!child);
      let ready = false,
        failed = false;
      child = fork(
        fileURLToPath(new URL("./work-process.ts", import.meta.url)),
        ["--process-child"],
        {
          execArgv: [],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      child.on("message", (message: { kind: string; step?: string }) => {
        if (message.kind === "ready") ready = true;
        else if (message.kind === "paused") paused = true;
        else if (message.kind === "model") models.push(message.step!);
        else failed = true;
      });
      child.once("exit", () => {
        failed = true;
      });
      child.send({ options, window: mode });
      await until(() => {
        assert(!failed, "Owned upgrade Work child exited.");
        return ready;
      }, "startup");
    };
    const request = (path: string, method = "GET", body?: unknown) =>
      fetch(origin + path, {
        method,
        headers: {
          Cookie: "openbot_session=" + token,
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
    await start(stage);
    const modelResponse = await request("/api/v1/model-connections", "POST", {
      name: "Upgrade model",
      presetId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: randomBytes(24).toString("hex"),
      defaultModel: "synthetic-model",
    });
    assert.equal(modelResponse.status, 201);
    const { connection } = (await modelResponse.json()) as { connection: { id: string } };
    const botId = randomUUID();
    await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${botId},${"Upgrade " + stage},'Owned fixture','model',${JSON.stringify({ model: { connectionId: connection.id, modelId: "synthetic-model" } })}::jsonb)`;
    let scope: unknown;
    if (stage === "approval") {
      const upload = await fetch(origin + "/api/v1/task-attachments", {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: "openbot_session=" + token,
          "Content-Type": "application/octet-stream",
          "X-OpenBot-Filename": "Evidence.txt",
        },
        body: "Owned upgrade evidence",
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(upload.status, 201);
      const { attachment } = (await upload.json()) as { attachment: { id: string } };
      scope = {
        version: 1,
        attachmentIds: [attachment.id],
        collaboratorBotIds: [],
        knowledge: false,
        plugins: false,
        web: false,
      };
      const policy = (await (await request("/api/v1/settings/approvals")).json()) as {
        revision: number;
      };
      assert.equal(
        (
          await request("/api/v1/settings/approvals", "PUT", {
            expectedRevision: policy.revision,
            productRead: "required",
            publicWeb: "inherit",
            exceptions: [],
          })
        ).status,
        200,
      );
    }
    const admitted = await request("/api/v1/tasks", "POST", {
      botId,
      objective: "Verify upgrade " + stage,
      requestKey: randomUUID(),
      tokenLimit: 1000000,
      ...(scope ? { scope } : {}),
    });
    assert.equal(admitted.status, 202);
    const initial = workSnapshotWireSchema.parse(await admitted.json());
    const snapshot = async () => {
      const response = await request("/api/v1/tasks/" + initial.id);
      assert.equal(response.status, 200);
      return workSnapshotWireSchema.parse(await response.json());
    };
    await until(() => paused, stage + " seam");
    const before = await snapshot();
    if (stage === "approval") assert(before.actions.some((a) => a.decision === "pending"));
    if (stage === "publication") {
      assert.equal(before.status, "completed");
      assert.equal(before.artifacts.length, 1);
    }
    if (stage === "effect") assert.deepEqual(models, ["report"]);
    const [admission] =
      await sql`SELECT a.* FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=${initial.id}`;
    assert(admission?.engine_first_run_id);
    const runId = initial.runs[0]!.id,
      workflowId = WORKFLOW_ID_PREFIX + runId;
    const facts = async () =>
      JSON.stringify({
        task: Array.from(await sql`SELECT * FROM work_tasks WHERE id=${initial.id}`),
        actions: Array.from(
          await sql`SELECT * FROM work_actions WHERE task_id=${initial.id} ORDER BY id`,
        ),
        artifacts: Array.from(
          await sql`SELECT * FROM work_artifacts WHERE task_id=${initial.id} ORDER BY id`,
        ),
        models,
      });
    await stop("SIGKILL");
    return {
      stage,
      initial,
      before,
      admission,
      workflowId,
      models,
      snapshot,
      start,
      stop,
      close,
      request,
      facts,
      verifyAdmission: async () => {
        const [after] =
          await sql`SELECT a.* FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=${initial.id}`;
        assert.equal(after!.submission_attempt_id, admission.submission_attempt_id);
        assert.equal(after!.engine_first_run_id, admission.engine_first_run_id);
        assert.equal(
          (
            await sql`SELECT 1 FROM work_events WHERE task_id=${initial.id} AND kind='handoff.submission_attempted'`
          ).length,
          1,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function qualifyWorkUpgrade(
  dsn: string,
  engine: Engine,
  workflowBundle: WorkflowBundle,
) {
  const held: Awaited<ReturnType<typeof heldWork>>[] = [];
  const client = new Client({ connection: engine.connection, namespace: "default" });
  const replay = async (item: (typeof held)[number], label: string) => {
    const before = await item.facts();
    await Worker.runReplayHistory(
      { workflowBundle },
      await client.workflow.getHandle(item.workflowId).fetchHistory(),
    );
    assert.equal(await item.facts(), before, "Offline replay changed product facts or effects.");
    console.log("PASS offline replay " + label + " " + item.stage);
  };
  try {
    for (const stage of ["approval", "effect", "publication"] as const)
      held.push(await heldWork(dsn, engine, stage));
    for (const item of held) await replay(item, "before upgrade");
    engine.backup();
    await engine.upgrade();
    const firstResults = new Map<Stage, WorkSnapshotWire>();
    for (const phase of ["original-volume", "restored-volume"] as const) {
      if (phase === "restored-volume") await engine.restore();
      for (const item of held) {
        const handle = client.workflow.getHandle(item.workflowId);
        assert.equal((await handle.describe()).runId, item.admission.engine_first_run_id);
        await replay(item, phase + " before Worker");
        const beforeModels = [...item.models];
        await item.start("resume");
        if (item.stage === "approval" && phase === "original-volume") {
          const pending = await item.snapshot();
          const action = pending.actions.find((a) => a.decision === "pending");
          assert(action);
          assert.equal(
            (
              await item.request(`/api/v1/actions/${action.id}/decision`, "POST", {
                intentDigest: "0".repeat(64),
                approved: true,
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await item.request(`/api/v1/actions/${action.id}/decision`, "POST", {
                intentDigest: action.intentDigest,
                approved: true,
              })
            ).status,
            200,
          );
        }
        await until(
          async () => {
            const value = await item.snapshot();
            return item.stage === "effect"
              ? value.actions.some((a) => a.status === "unknown")
              : value.status === "completed";
          },
          phase + " " + item.stage,
        );
        if (item.stage !== "effect")
          await until(
            async () => (await handle.describe()).status.name !== "RUNNING",
            "engine closure",
          );
        else await delay(3000);
        const result = await item.snapshot();
        await item.verifyAdmission();
        if (item.stage === "effect") {
          assert.deepEqual(item.models, ["report"]);
          assert.equal(result.artifacts.length, 0);
        } else {
          assert.equal(result.artifacts.length, 1);
          assert.equal(result.events.filter((e) => e.kind === "task.completed").length, 1);
          const download = await item.request(result.artifacts[0]!.downloadUrl);
          assert.equal(download.status, 200);
          assert.match(await download.text(), /Original durable recovery report/);
          assert.deepEqual(
            item.models,
            item.stage === "approval"
              ? ["read", "report", "answer", "review"]
              : ["report", "answer", "review"],
          );
        }
        if (phase === "restored-volume") {
          assert.deepEqual(
            item.models,
            beforeModels,
            "Stale engine history repeated a provider call.",
          );
          const prior = firstResults.get(item.stage)!;
          assert.deepEqual(result.artifacts, prior.artifacts);
          assert.deepEqual(result.usage, prior.usage);
          assert.equal(result.status, prior.status);
        } else firstResults.set(item.stage, result);
        await item.stop();
        await replay(item, phase + " after Worker");
        console.log(
          JSON.stringify({
            case: "upgrade-" + phase + "-" + item.stage,
            engineRunIdentityRetained: true,
            status: result.status,
            providerCalls: item.models.length,
            artifacts: result.artifacts.length,
          }),
        );
      }
    }
  } finally {
    const outcomes = await Promise.allSettled(held.map((item) => item.close()));
    assert(
      outcomes.every((result) => result.status === "fulfilled"),
      "Owned Work process cleanup failed.",
    );
  }
}
