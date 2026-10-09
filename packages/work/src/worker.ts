import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { TLSConfig } from "@temporalio/worker";
import {
  type EngineSettings,
  type RepairStart,
  WorkConflict,
  type WorkStart,
} from "./contracts.js";
import type { WorkStep } from "./workflows.js";

export type WorkWorkerOptions = {
  address: string;
  tls: TLSConfig;
  settings: EngineSettings;
  admission(input: WorkStart): Promise<unknown>;
  repair(input: RepairStart, signal: AbortSignal): Promise<void>;
  advance(input: WorkStart, signal: AbortSignal): Promise<WorkStep>;
  inspectTree(input: WorkStart): Promise<{ watch: boolean; deadline: number | null }>;
  closeTree(input: WorkStart): Promise<void>;
};
let runtimeInstallation: Promise<void> | undefined;
export function installWorkRuntime(): Promise<void> {
  if (!runtimeInstallation)
    runtimeInstallation = import("@temporalio/worker").then(({ Runtime, DefaultLogger }) => {
      // SDK metadata includes completion tokens and Activity errors. Product logs retain only
      // severity; durable public Work events provide the bounded, redacted failure reason.
      Runtime.install({
        logger: new DefaultLogger("WARN", (entry) => {
          process.stderr.write(
            entry.level === "ERROR"
              ? "[openbot-work] Temporal runtime error\n"
              : "[openbot-work] Temporal runtime warning\n",
          );
        }),
      });
    });
  return runtimeInstallation;
}
export async function createWorkWorker(options: WorkWorkerOptions) {
  await installWorkRuntime();
  const { NativeConnection, Worker } = await import("@temporalio/worker");
  const connection = await NativeConnection.connect({ address: options.address, tls: options.tls });
  try {
    const checked = async <T>(operation: () => Promise<T>) => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof WorkConflict)
          throw ApplicationFailure.nonRetryable(error.message, "WorkConflict");
        throw error;
      }
    };
    const worker = await Worker.create({
      connection,
      namespace: options.settings.namespace,
      taskQueue: options.settings.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      maxConcurrentActivityTaskExecutions: 4,
      shutdownGraceTime: 5000,
      shutdownForceTime: 7000,
      activities: {
        repairClosedWork: (input: RepairStart) =>
          checked(() => options.repair(input, Context.current().cancellationSignal)),
        awaitWorkAdmission: (input: WorkStart) => checked(() => options.admission(input)),
        inspectWorkTree: (input: WorkStart) => checked(() => options.inspectTree(input)),
        closeWorkTree: (input: WorkStart) => checked(() => options.closeTree(input)),
        advanceWork: (input: WorkStart) =>
          checked(async () => {
            const context = Context.current();
            context.heartbeat();
            const heartbeat = setInterval(() => context.heartbeat(), 2000);
            try {
              return await options.advance(input, context.cancellationSignal);
            } finally {
              clearInterval(heartbeat);
            }
          }),
      },
    });
    let running: Promise<void> | undefined;
    return {
      run: () => (running ??= worker.run()),
      close: async () => {
        if (worker.getState() === "RUNNING") worker.shutdown();
        try {
          await running;
        } finally {
          await connection.close();
        }
      },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
export type WorkWorker = Awaited<ReturnType<typeof createWorkWorker>>;
