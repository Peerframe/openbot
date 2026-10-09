// Real child death at production commit seams. Only provider transport and pause hooks are
// synthetic; HTTP, SQL, files, Workflow/Activity retry and process replacement are actual.
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createEntry } from "../apps/server-ts/dist/app.js";
import type { EntryOptions } from "../apps/server-ts/dist/config.js";
import { WorkHandoff } from "../apps/server-ts/dist/work-handoff.js";
import { WorkLedger } from "../apps/server-ts/dist/work-ledger.js";
import { WorkRuntime } from "../apps/server-ts/dist/work-runtime.js";
import { createDatabase } from "../packages/db/dist/index.js";
import {
  modelConnectionResponseSchema,
  workSnapshotWireSchema,
} from "../packages/protocol/dist/index.js";

type Window = "reservation" | "start" | "effect" | "receipt" | "publication" | "resume";
type Fixture = {
  address: string;
  tls: { ca: string; certificate: string; key: string; server_name: string };
};

async function childEntry(options: EntryOptions, window: Window) {
  let paused = false;
  const pause = async () => {
    if (!paused) {
      paused = true;
      process.send?.({ kind: "paused", window });
    }
    await new Promise<never>(() => {});
  };
  if (window === "reservation") {
    const original = WorkHandoff.prototype.reserve;
    WorkHandoff.prototype.reserve = async function (...args) {
      const result = await original.apply(this, args);
      await pause();
      return result;
    };
  }
  if (window === "start") {
    const original = WorkHandoff.prototype.acknowledge;
    WorkHandoff.prototype.acknowledge = async function (...args) {
      await pause();
      return original.apply(this, args);
    };
  }
  if (window === "receipt") {
    const original = WorkLedger.prototype.record;
    WorkLedger.prototype.record = async function (...args) {
      await original.apply(this, args);
      if (args[2] === "model") await pause();
    };
  }
  if (window === "start") {
    const original = WorkRuntime.prototype.advance;
    WorkRuntime.prototype.advance = async function (...args) {
      // Early Activity admission can acknowledge SQL before the original start call returns.
      // Hold the effect seam too, so this window is specifically death after engine acceptance.
      await pause();
      return original.apply(this, args);
    };
  }
  if (window === "publication") {
    const original = WorkRuntime.prototype.advance;
    WorkRuntime.prototype.advance = async function (...args) {
      const result = await original.apply(this, args);
      if (result.state === "completed") await pause();
      return result;
    };
  }
  assert(options.product);
  options.product.modelTransport = async (request) => {
    const body = JSON.parse(request.body!);
    const review = body.messages[0].content.startsWith("Independently review");
    const hasReport = body.messages.some((value: { role: string }) => value.role === "tool");
    process.send?.({ kind: "model", step: review ? "review" : hasReport ? "answer" : "report" });
    if (window === "effect") await pause();
    const message =
      review || hasReport
        ? {
            role: "assistant",
            content: review
              ? JSON.stringify({ accepted: true, reason: "Synthetic recovery evidence verified" })
              : "Recovery report complete.",
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "original-report",
                type: "function",
                function: {
                  name: "write_report",
                  arguments: JSON.stringify({
                    name: "Recovery.md",
                    markdown: "# Original durable recovery report",
                  }),
                },
              },
            ],
          };
    return {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      bytes: Buffer.from(
        JSON.stringify({
          id: "original-process-response",
          object: "chat.completion",
          created: 1,
          model: "synthetic-model",
          choices: [
            { index: 0, finish_reason: "tool_calls" in message ? "tool_calls" : "stop", message },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      ),
    };
  };
  const app = await createEntry(options);
  await app.listen({ host: options.host, port: options.port });
  process.send?.({ kind: "ready" });
  const stop = () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
}
if (process.argv[2] === "--process-child") {
  process.once("message", (message: { options: EntryOptions; window: Window }) => {
    void childEntry(message.options, message.window).catch(() => {
      process.send?.({ kind: "failed" });
      process.exitCode = 1;
      process.disconnect?.();
    });
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, label: string, budget = 90000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error("Process recovery timed out: " + label);
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
export async function qualifyWorkProcessRecovery(dsn: string, fixture: Fixture) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openbot-work-process-")));
  const admin = createDatabase(dsn);
  const databaseName = "recovery_" + randomBytes(6).toString("hex");
  await admin.client.unsafe(`CREATE DATABASE ${databaseName}`);
  const url = new URL(dsn);
  url.pathname = "/" + databaseName;
  const database = createDatabase(url.toString());
  const sql = database.client;
  let child: ChildProcess | undefined;
  const stop = async (signal: "SIGTERM" | "SIGKILL") => {
    if (!child) return;
    const current = child;
    child = undefined;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    current.kill(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned process survived stop")), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await database.migrate();
    await mkdir(join(directory, "work"), { mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`INSERT INTO auth_sessions(id,token_digest,owner_id,expires_at) VALUES(${randomUUID()},${hash},'owner',clock_timestamp()+interval '30 minutes')`;
    const queue = "openbot-work-ts-v1-" + randomUUID();
    for (const window of ["reservation", "start", "effect", "receipt", "publication"] as const) {
      const data = directory;
      const port = await freePort(),
        origin = `http://127.0.0.1:${port}`;
      const options: EntryOptions = {
        host: "127.0.0.1",
        port,
        publicOrigin: origin,
        upstream: "http://127.0.0.1:9",
        product: {
          databaseUrl: url.toString(),
          controlReads: true,
          workerRuntime: { browserRoutes: {}, humanControl: false, legacyHumanControl: false },
          files: { objectRoot: join(data, "objects") },
          models: { keyPath: join(data, "model.key"), customBaseUrls: [] },
          work: {
            address: fixture.address,
            namespace: "default",
            taskQueue: queue,
            executionTimeoutMs: 300000,
            fileRoot: join(data, "work"),
            tls: {
              ca: fixture.tls.ca,
              certificate: fixture.tls.certificate,
              key: fixture.tls.key,
              serverName: fixture.tls.server_name,
            },
          },
        },
      };
      const models: string[] = [];
      let paused = false;
      const start = async (mode: Window) => {
        let ready = false,
          failed = false;
        child = fork(fileURLToPath(import.meta.url), ["--process-child"], {
          execArgv: [],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
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
        await waitFor(() => {
          assert(!failed, "Owned P4 process failed to start");
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
      await start(window);
      const response = await request("/api/v1/model-connections", "POST", {
        name: "Process fixture",
        presetId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: randomBytes(24).toString("hex"),
        defaultModel: "synthetic-model",
      });
      assert.equal(response.status, 201);
      const { connection } = modelConnectionResponseSchema.parse(await response.json());
      const botId = randomUUID();
      await sql`INSERT INTO bots(id,name,role,computer_profile,configuration) VALUES(${botId},${"Process fixture " + window},'Synthetic recovery','model',${JSON.stringify({ model: { connectionId: connection.id, modelId: "synthetic-model" } })}::jsonb)`;
      const admitted = await request("/api/v1/tasks", "POST", {
        botId,
        objective: "Verify " + window,
        requestKey: randomUUID(),
        tokenLimit: 1000000,
      });
      assert.equal(admitted.status, 202);
      const task = workSnapshotWireSchema.parse(await admitted.json());
      await waitFor(() => paused, window + " seam");
      const before =
        await sql`SELECT a.* FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=${task.id}`;
      const receipts =
        await sql`SELECT action_id,sha256 FROM work_model_receipts WHERE task_id=${task.id} ORDER BY action_id`;
      if (window === "receipt") assert.equal(receipts.length, 1);
      if (window === "effect") {
        assert.equal(receipts.length, 0);
        assert.deepEqual(models, ["report"]);
      }
      await stop("SIGKILL");
      await start("resume");
      const snapshot = async () => {
        const value = await request("/api/v1/tasks/" + task.id);
        assert.equal(value.status, 200);
        return workSnapshotWireSchema.parse(await value.json());
      };
      if (window === "reservation") {
        // A durable send reservation with no history is intentionally unconfirmed, never resent.
        await delay(3000);
        const current = await snapshot();
        assert.equal(current.status, "queued");
        assert.equal(models.length, 0);
        assert.equal((await request(`/api/v1/tasks/${task.id}/cancel`, "POST", {})).status, 200);
      } else if (window === "effect") {
        await waitFor(
          async () => (await snapshot()).actions.some((a) => a.status === "unknown"),
          "unknown effect",
        );
        assert.deepEqual(models, ["report"]);
        assert.equal((await snapshot()).artifacts.length, 0);
        const current = await snapshot();
        if (!["completed", "failed", "cancelled"].includes(current.status))
          assert.equal((await request(`/api/v1/tasks/${task.id}/cancel`, "POST", {})).status, 200);
      } else {
        await waitFor(
          async () => {
            const value = await snapshot();
            assert(
              !["failed", "cancelled"].includes(value.status),
              JSON.stringify({
                window,
                status: value.status,
                models,
                events: value.events.filter((e) => e.kind === "task.failed"),
              }),
            );
            return value.status === "completed";
          },
          window + " completion",
          150000,
        );
        const complete = await snapshot();
        assert.equal(complete.artifacts.length, 1);
        assert.deepEqual(models, ["report", "answer", "review"]);
        const content = await request(complete.artifacts[0]!.downloadUrl);
        assert.equal(content.status, 200);
        assert.match(await content.text(), /Original durable recovery report/);
        for (const receipt of receipts) {
          assert.deepEqual(
            Array.from(
              await sql`SELECT action_id,sha256 FROM work_model_receipts WHERE action_id=${receipt.action_id}`,
            ),
            [receipt],
          );
        }
        assert.equal(
          (await sql`SELECT 1 FROM work_events WHERE task_id=${task.id} AND kind='task.completed'`)
            .length,
          1,
        );
      }
      const after =
        await sql`SELECT a.* FROM work_admissions a JOIN work_runs r ON r.id=a.run_id WHERE r.task_id=${task.id}`;
      assert.equal(after[0]!.submission_attempt_id, before[0]!.submission_attempt_id);
      assert.equal(
        (
          await sql`SELECT 1 FROM work_events WHERE task_id=${task.id} AND kind='handoff.submission_attempted'`
        ).length,
        1,
      );
      await stop("SIGTERM");
      console.log(
        `PASS actual SIGKILL/replacement at ${window}; original facts and one-use effects retained`,
      );
    }
  } finally {
    await stop("SIGTERM");
    await database.close();
    await admin.close();
    await rm(directory, { recursive: true, force: true });
  }
}
