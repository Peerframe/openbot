import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ManagedServerProcess, NativeServerController } from "../src/native-server.ts";
import type { launchPythonProductServer } from "../src/python-server.ts";
import type { launchDesktopProductServer } from "../src/ts-server.ts";

type DesktopModules = {
  readonly NativeServerController: typeof NativeServerController;
  readonly launchPythonProductServer: typeof launchPythonProductServer;
  readonly launchDesktopProductServer: typeof launchDesktopProductServer;
};
type ParentRequest = { runtimeRoot: string; desktopDist: string; env: Record<string, string> };
const readinessTimeoutMs = 90_000;
const shutdownDeadlineMs = 15_000;
const healthFetchTimeoutMs = 500;
const healthIntervalMs = 100;

async function loadPythonLauncher(desktopDist: string): Promise<typeof launchPythonProductServer> {
  const launcher = (await import(
    pathToFileURL(join(desktopDist, "python-server.js")).href
  )) as typeof import("../src/python-server.ts");
  return launcher.launchPythonProductServer;
}

async function loadProductLauncher(
  desktopDist: string,
): Promise<typeof launchDesktopProductServer> {
  const launcher = (await import(
    pathToFileURL(join(desktopDist, "ts-server.js")).href
  )) as typeof import("../src/ts-server.ts");
  return launcher.launchDesktopProductServer;
}

/** Loads only compiled Desktop output; type-only imports describe the matching source build. */
export async function loadDesktopModules(desktopDist: string): Promise<DesktopModules> {
  const controller = (await import(
    pathToFileURL(join(desktopDist, "native-server.js")).href
  )) as typeof import("../src/native-server.ts");
  return {
    NativeServerController: controller.NativeServerController,
    launchPythonProductServer: await loadPythonLauncher(desktopDist),
    launchDesktopProductServer: await loadProductLauncher(desktopDist),
  };
}

function readyProcessIds(message: unknown): readonly number[] | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("ready" in message) ||
    message.ready !== true ||
    !("processIds" in message) ||
    !Array.isArray(message.processIds) ||
    message.processIds.length < 1 ||
    message.processIds.length > 2 ||
    !message.processIds.every((pid) => Number.isInteger(pid) && pid > 1) ||
    new Set(message.processIds).size !== message.processIds.length
  )
    return undefined;
  return message.processIds as number[];
}

function waitForReady(parent: ChildProcess, request: ParentRequest): Promise<readonly number[]> {
  return new Promise<readonly number[]>((resolve, reject) => {
    const settle = (failure: Error | undefined, ids: readonly number[] = []): void => {
      clearTimeout(timer);
      parent.off("error", onError);
      parent.off("close", onClose);
      parent.off("message", onMessage);
      if (failure === undefined) resolve(ids);
      else reject(failure);
    };
    const onError = (): void => settle(new Error("Disposable parent failed."));
    const onClose = (): void => settle(new Error("Disposable parent exited."));
    const onMessage = (message: unknown): void => {
      const ids = readyProcessIds(message);
      settle(ids ? undefined : new Error("Disposable API failed."), ids);
    };
    const timer = setTimeout(
      () => settle(new Error("Disposable candidate parent timed out.")),
      readinessTimeoutMs,
    );
    parent.once("error", onError);
    parent.once("close", onClose);
    parent.once("message", onMessage);
    try {
      parent.send(request);
    } catch {
      settle(new Error("Disposable parent failed."));
    }
  });
}

export async function confirmProcessesStopped(ids: readonly number[]): Promise<void> {
  const deadline = Date.now() + shutdownDeadlineMs;
  while (Date.now() < deadline) {
    if (
      ids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      })
    )
      return;
    await delay(healthIntervalMs);
  }
  throw new Error("Product process survived its disposable parent.");
}

async function confirmHealthUnreachable(port: string | undefined): Promise<void> {
  const deadline = Date.now() + shutdownDeadlineMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(healthFetchTimeoutMs),
      });
    } catch {
      return;
    }
    await delay(healthIntervalMs);
  }
  throw new Error("Product API survived its disposable parent.");
}

/**
 * This disposable parent owns the selected product's inherited pipes. Killing it exercises EOF
 * cleanup in the actual launcher. Probe credentials travel only over IPC, not argv or env.
 */
export async function launchThroughDisposableParent(
  runtimeRoot: string,
  desktopDist: string,
  env: Record<string, string>,
): Promise<ManagedServerProcess & { readonly processIds: readonly number[] }> {
  const parent = fork(fileURLToPath(import.meta.url), ["--parent-child"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let alive = true;
  const closed = new Promise<void>((resolve) =>
    parent.once("close", () => {
      alive = false;
      resolve();
    }),
  );
  let processIds: readonly number[];
  try {
    processIds = await waitForReady(parent, { runtimeRoot, desktopDist, env });
  } catch (error: unknown) {
    parent.kill("SIGKILL");
    await closed;
    throw error;
  }
  return {
    processIds,
    isAlive: () => alive,
    async stop() {
      parent.kill("SIGKILL");
      await closed;
      await confirmHealthUnreachable(env.OPENBOT_PORT);
      await confirmProcessesStopped(processIds);
    },
  };
}

function parseParentRequest(message: unknown): ParentRequest | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  if (!("runtimeRoot" in message) || !("desktopDist" in message) || !("env" in message))
    return undefined;
  const { runtimeRoot, desktopDist, env } = message;
  if (
    typeof runtimeRoot !== "string" ||
    typeof desktopDist !== "string" ||
    typeof env !== "object" ||
    env === null ||
    Array.isArray(env)
  )
    return undefined;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") return undefined;
    Object.defineProperty(values, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { runtimeRoot, desktopDist, env: values };
}

function runParentChild(send: NonNullable<typeof process.send>): void {
  process.once("message", async (message: unknown) => {
    try {
      const request = parseParentRequest(message);
      if (request === undefined) throw new Error("invalid request");
      const launch = await loadProductLauncher(request.desktopDist);
      const managed = await launch(request.runtimeRoot, request.env);
      send({ ready: true, processIds: managed.processIds });
    } catch {
      send({ ready: false });
      process.exitCode = 1;
      process.disconnect?.();
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === "--parent-child" &&
  process.send
) {
  runParentChild(process.send.bind(process));
}
