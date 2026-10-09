import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { workBrowserRoutesSchema } from "./work-browser-profiles.js";
import { strictCommandJson } from "./work-command-values.js";
import type { WorkOptions } from "./work-service.js";
import type { WorkerRuntimeOptions } from "./worker-runtime.js";

export function readWorkInstallationFile(path: string, privateFile: boolean, maximum: number) {
  if (!isAbsolute(path) || realpathSync(path) !== path)
    throw new Error("work_installation_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.geteuid?.() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > maximum ||
      stat.mode & (privateFile ? 0o077 : 0o022)
    )
      throw new Error("work_installation_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || fstatSync(fd).size !== stat.size)
      throw new Error("work_installation_invalid");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"));
const engineSchema = z.strictObject({
  temporal_address: z.string().min(1).max(320),
  namespace: z.string().min(1).max(64),
  queue: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !value.includes("\0")),
  tls: z.strictObject({
    ca: path,
    certificate: path,
    key: path,
    server_name: z.string().min(1).max(253),
  }),
  limit: z.number().int().min(1).max(64).optional(),
  execution_timeout_seconds: z.number().int().min(1).max(86400).default(3600),
  item_timeout_seconds: z.number().int().min(1).max(30).optional(),
  interval_seconds: z.number().int().min(1).max(30).optional(),
});
const browserSchema = z.strictObject({
  version: z.literal(1),
  routes: workBrowserRoutesSchema.shape.browserRoutes,
  humanControl: z.boolean().default(false),
  pageOrigins: workBrowserRoutesSchema.shape.pageOrigins,
});
/** Read the existing owned deployment files; never rewrite credentials or the Python queue.
 * The new queue has a fixed version prefix and a stable digest of the configured old queue. */
export function loadWorkInstallation(options: {
  temporal: string;
  browser?: string;
  command?: string;
  fileRoot: string;
  tokenLimit: number;
}): { work: WorkOptions; workerRuntime: WorkerRuntimeOptions; legacyQueue: string } {
  try {
    const engine = engineSchema.parse(
      strictCommandJson(readWorkInstallationFile(options.temporal, true, 16384)),
    );
    const browser =
      options.browser === undefined
        ? undefined
        : browserSchema.parse(
            strictCommandJson(readWorkInstallationFile(options.browser, true, 16384)),
          );
    const routes = workBrowserRoutesSchema.parse({
      browserRoutes: browser?.routes ?? {},
      ...(browser?.pageOrigins === undefined ? {} : { pageOrigins: browser.pageOrigins }),
    });
    const queue =
      "openbot-work-ts-v1-" + createHash("sha256").update(engine.queue).digest("hex").slice(0, 32);
    if (queue === engine.queue) throw new Error();
    return {
      legacyQueue: engine.queue,
      work: {
        drainPythonQueue: engine.queue,
        address: engine.temporal_address,
        namespace: engine.namespace,
        taskQueue: queue,
        executionTimeoutMs: engine.execution_timeout_seconds * 1000,
        tokenLimit: options.tokenLimit,
        fileRoot: options.fileRoot,
        tls: {
          ca: engine.tls.ca,
          certificate: engine.tls.certificate,
          key: engine.tls.key,
          serverName: engine.tls.server_name,
        },
      },
      workerRuntime: {
        ...routes,
        humanControl: browser?.humanControl ?? false,
        legacyHumanControl: false,
        ...(options.command === undefined ? {} : { command: path.parse(options.command) }),
      },
    };
  } catch {
    throw new Error("work_installation_invalid");
  }
}
