import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  Connection,
  createWorkWorker,
  currentBinding,
  dispatchOne,
  type EngineSettings,
  TemporalEngine,
  type WorkStart,
  type WorkWorker,
} from "@openbot/work";
import type { ModelConnections } from "./model-connections.js";
import type { ModelTransport } from "./model-network.js";
import type { OwnerFiles } from "./owner-files.js";
import type { Plugins } from "./product-plugins.js";
import { acceptedWork } from "./work-execution.js";
import { WorkFiles } from "./work-files.js";
import { WorkHandoff, workTransactions } from "./work-handoff.js";
import { WorkRuntime } from "./work-runtime.js";
import { WorkTerminal } from "./work-terminal.js";
import { cascadeWork, workTree } from "./work-tree.js";
import type { WorkWebOptions } from "./work-web.js";

export type WorkOptions = EngineSettings & {
  web?: WorkWebOptions;
  address: string;
  fileRoot: string;
  tls: { ca: string; certificate: string; key: string; serverName: string };
};
export function validateWorkOptions(value: WorkOptions) {
  const url = new URL("tls://" + value.address);
  if (
    value.address.length > 320 ||
    /\s/.test(value.address) ||
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !url.port ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$/.test(value.tls.serverName) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.namespace) ||
    !/^openbot-work-ts-v1-[A-Za-z0-9_-]{1,96}$/.test(value.taskQueue) ||
    !Number.isSafeInteger(value.executionTimeoutMs) ||
    value.executionTimeoutMs < 1000 ||
    value.executionTimeoutMs > 86400000 ||
    [value.fileRoot, value.tls.ca, value.tls.certificate, value.tls.key].some(
      (p) => !isAbsolute(p) || p.includes("\0") || p.length > 4096,
    )
  )
    throw new Error("Invalid explicit TS Work configuration.");
}
function engineFile(path: string, privateKey = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.geteuid?.() ||
      stat.size < 1 ||
      stat.size > 65536 ||
      stat.mode & (privateKey ? 0o077 : 0o022)
    )
      throw new Error("Unsafe engine credential file.");
    const data = readFileSync(fd);
    if (data.length < 1 || data.length > 65536) throw new Error("Invalid engine credential file.");
    return data;
  } finally {
    closeSync(fd);
  }
}
/** One service owns the TS queue. Python keeps its disjoint persisted admissions and histories. */
export class WorkService {
  readonly transactions;
  readonly files: WorkFiles;
  readonly runtime: WorkRuntime;
  readonly handoff: WorkHandoff;
  readonly terminal: WorkTerminal;
  private readonly stopped = new AbortController();
  private connection: Connection | undefined;
  private worker: WorkWorker | undefined;
  private loop: Promise<void> | undefined;
  private workerRun: Promise<void> | undefined;
  private failed = false;
  private wakeAfter = "";
  private pendingAfter = "";
  private unconfirmedAfter = "";
  private readonly wakeRevisions = new Map<string, string>();
  constructor(
    databaseUrl: string,
    readonly options: WorkOptions,
    models: ModelConnections,
    transport?: ModelTransport,
    attachments?: OwnerFiles,
    plugins?: Plugins,
  ) {
    validateWorkOptions(options);
    this.transactions = workTransactions(databaseUrl);
    this.files = new WorkFiles(options.fileRoot);
    this.runtime = new WorkRuntime(
      this.transactions,
      this.files,
      models,
      transport,
      attachments,
      plugins,
      options.web,
    );
    this.handoff = new WorkHandoff(this.transactions);
    this.terminal = new WorkTerminal(this.transactions, this.runtime.ledger);
  }
  async start() {
    this.files.verify();
    const tls = {
      serverNameOverride: this.options.tls.serverName,
      serverRootCACertificate: engineFile(this.options.tls.ca),
      clientCertPair: {
        crt: engineFile(this.options.tls.certificate),
        key: engineFile(this.options.tls.key, true),
      },
    };
    try {
      this.connection = await Connection.connect({
        address: this.options.address,
        tls,
        connectTimeout: 10000,
        interceptors: [],
      });
      const engine = new TemporalEngine(
        new Client({ connection: this.connection, namespace: this.options.namespace }),
      );
      this.worker = await createWorkWorker({
        address: this.options.address,
        tls,
        settings: this.options,
        admission: async (input: WorkStart) => {
          const binding = await currentBinding(engine, this.options, input);
          await this.transactions.run((db) => acceptedWork(db, binding, true));
        },
        inspectTree: async (input) => {
          const binding = await currentBinding(engine, this.options, input);
          return this.transactions.run(async (db) => {
            const task = await acceptedWork(db, binding, true),
              tree = workTree(task);
            return {
              watch:
                !!tree.deadline ||
                !!tree.scopes.get(task.id)?.value.request.collaboratorBotIds.length,
              deadline: tree.deadline ? Date.parse(tree.deadline) + 1 : null,
            };
          });
        },
        closeTree: async (input) => {
          const binding = await currentBinding(engine, this.options, input);
          await this.transactions.run(async (db) => {
            const task = await acceptedWork(db, binding, true),
              tree = workTree(task);
            if (!tree.deadline || tree.live) throw new Error("Tree deadline has not expired.");
            await cascadeWork(db, tree.rootTaskId, "expired");
          });
        },
        repair: (input, signal) =>
          this.terminal.repair.execute(engine, this.options, input, signal),
        advance: async (input, signal) =>
          this.runtime.advance(await currentBinding(engine, this.options, input), signal),
      });
      this.workerRun = this.worker.run().catch(() => {
        this.failed = true;
        this.stopped.abort();
      });
      this.loop = this.poll(engine);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async poll(engine: TemporalEngine) {
    while (!this.stopped.signal.aborted) {
      try {
        // A broken old submission cannot permanently hide newer rows behind a first-page limit.
        const unconfirmed = await this.handoff.unconfirmedBatch(8, this.unconfirmedAfter);
        const pending = await this.handoff.pending(8, this.pendingAfter);
        this.unconfirmedAfter = unconfirmed.length === 8 ? unconfirmed.at(-1)!.runId : "";
        this.pendingAfter = pending.length === 8 ? pending.at(-1)!.runId : "";
        for (const work of [...unconfirmed, ...pending]) {
          if (this.stopped.signal.aborted) break;
          try {
            await dispatchOne(work, this.options, this.handoff, engine);
          } catch {
            /* Persisted submission remains lookup-only on the next bounded pass. */
          }
        }
        await this.wakeChanged(engine);
        await this.terminal.poll(engine, this.options, this.stopped.signal);
      } catch {
        /* Database outages retain durable obligations; no synthetic success is projected. */
      }
      try {
        await delay(1000, undefined, { signal: this.stopped.signal });
      } catch {
        break;
      }
    }
  }
  private async wakeChanged(engine: TemporalEngine) {
    const rows = await this.transactions.run(
      (db) => db`
      SELECT r.id,t.id AS task_id,t.revision,a.submission_attempt_id,a.engine_first_run_id
      FROM work_runs r JOIN work_tasks t ON t.id=r.task_id JOIN work_admissions a ON a.run_id=r.id
      WHERE a.execution_owner='typescript-v1' AND a.state='acknowledged' AND r.id>${this.wakeAfter}
      AND t.status IN ('queued','open') AND r.status IN ('queued','running') ORDER BY r.id LIMIT 16`,
    );
    for (const row of rows) {
      if (this.stopped.signal.aborted) break;
      this.wakeAfter = row.id;
      if (this.wakeRevisions.get(row.id) === String(row.revision)) continue;
      try {
        await engine.client.withAbortSignal(this.stopped.signal, async () => {
          const workflowId = "openbot-work-ts-v1-" + row.id;
          const start = await engine.inspectStart(workflowId);
          if (
            !start ||
            start.taskQueue !== this.options.taskQueue ||
            start.firstRunId !== row.engine_first_run_id ||
            start.input.taskId !== row.task_id ||
            start.input.runId !== row.id ||
            start.input.attemptId !== row.submission_attempt_id
          )
            return;
          await engine.client.withDeadline(Date.now() + 3000, () =>
            engine.client.workflow.getHandle(workflowId).signal("workChanged"),
          );
          this.wakeRevisions.delete(row.id);
          this.wakeRevisions.set(row.id, String(row.revision));
          if (this.wakeRevisions.size > 1024)
            this.wakeRevisions.delete(this.wakeRevisions.keys().next().value!);
        });
      } catch {
        /* Wakeup is only a hint; the durable workflow timer reads the same SQL facts. */
      }
    }
    if (rows.length < 16) this.wakeAfter = "";
  }
  healthy() {
    return !this.failed && !this.stopped.signal.aborted && this.worker !== undefined;
  }
  async close() {
    this.stopped.abort();
    await Promise.all([this.loop, this.worker?.close()]);
    await this.workerRun;
    await this.connection?.close();
    await this.transactions.close();
  }
}
