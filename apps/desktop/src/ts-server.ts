/** Supervises one app-owned TS Server; unavailable resources fail closed before startup. */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedServerProcess, NativeStartupContext } from "./native-server.js";
import {
  containedProductFile,
  fixedProcess,
  preparePrivateDirectories,
  productConfigurationEnvironment,
  productEnvironment,
  TemporalUnavailableError,
  verifyProductHealth,
} from "./server-bootstrap.js";
import { waitForProductDependencies } from "./startup-dependencies.js";
import { TS_CANDIDATE } from "./ts-product-manifest.js";

export async function selectsTsProduct(runtimeRoot: string): Promise<boolean> {
  const marker = join(runtimeRoot, "ts-control.json");
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096)
    throw new Error("TS candidate manifest is invalid.");
  const value: unknown = JSON.parse(await readFile(marker, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== Object.keys(TS_CANDIDATE).length ||
    !Object.entries(TS_CANDIDATE).every(
      ([key, expected]) => (value as Record<string, unknown>)[key] === expected,
    ) ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  ) {
    throw new Error("Server payload does not match its reviewed platform composition.");
  }
  return true;
}

/** Resource selection is fixed at package time; malformed TS selection never falls back. */
export async function launchDesktopProductServer(
  runtimeRoot: string,
  source: Record<string, string>,
  startup?: NativeStartupContext,
): Promise<ManagedServerProcess & { readonly processIds: readonly number[] }> {
  return launchTsProductServer(runtimeRoot, source, startup);
}

export async function launchTsProductServer(
  runtimeRoot: string,
  source: Record<string, string>,
  startup?: NativeStartupContext,
): Promise<ManagedServerProcess & { readonly processIds: readonly number[] }> {
  if (!(await selectsTsProduct(runtimeRoot))) throw new Error("TS candidate is not selected.");
  const env = productEnvironment(runtimeRoot, source);
  const configuration = await productConfigurationEnvironment(env);
  if (!configuration.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH)
    throw new Error("Server requires the existing private Temporal installation configuration.");
  const node = await containedProductFile(runtimeRoot, "node/bin/node");
  const entry = await containedProductFile(runtimeRoot, "apps/server/dist/desktop-entry.js");
  // Refuse incomplete installed payloads before migration or a product writer starts.
  for (const name of [
    "apps/server/dist/app.js",
    "apps/server/dist/work-installation.js",
    "deploy/server/legacy-work-preflight.ts",
    "deploy/server/prepare-product.ts",
    "apps/server/dist/work-service.js",
    "apps/server/dist/work-runtime.js",
    "apps/server/dist/work-command.js",
    "apps/server/dist/worker-runtime.js",
    "packages/work/dist/workflows.js",
    "node_modules/@temporalio/worker/package.json",
    "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin/index.node",
    "node_modules/jose/package.json",
    "node_modules/canonicalize/package.json",

    "apps/server/dist/tls.js",
    "apps/server/dist/transcription-read.js",
    "apps/server/dist/primary-bot-write.js",
    "apps/server/dist/write-input.js",
    "apps/server/dist/owner-auth.js",
    "apps/server/dist/owner-auth-crypto.js",
    "apps/server/dist/owner-auth-store.js",
    "apps/server/dist/owner-transaction.js",
    "apps/server/dist/product-http.js",
    "apps/server/dist/database-fence.js",
    "apps/server/dist/product-workspace.js",
    "apps/server/dist/product-events.js",
    "apps/server/dist/product-nodes.js",
    "apps/server/dist/product-browser.js",
    "apps/server/dist/employee-portability.js",
    "apps/server/dist/employee-publisher.js",
    "apps/server/dist/employee-knowledge.js",
    "apps/server/dist/employee-records.js",
    "apps/server/dist/employee-source-lock.js",
    "apps/server/dist/identity-create.js",
    "apps/server/dist/identity-lifecycle.js",
    "apps/server/dist/bot-greeting.js",
    "apps/server/dist/greeting-network.js",
    "apps/server/dist/greeting-text.js",
    "apps/server/dist/product-plugins.js",
    "apps/server/dist/plugin-store.js",
    "apps/server/dist/plugin-transport.js",
    "apps/server/dist/owner-files.js",
    "apps/server/dist/attachment-processing.js",
    "apps/server/dist/attachment-parser.js",
    "apps/server/dist/attachment-transcription.js",
    "apps/server/dist/storage-service.js",
    "apps/server/dist/storage-usage.js",
    "apps/server/dist/product-approvals.js",
    "apps/server/dist/product-automations.js",
    "apps/server/dist/plugin_catalog.json",
    "apps/server/dist/parser-worker.js",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/entities/package.json",
    "packages/employee-publisher/dist/employee-package.js",
    "apps/server/dist/product-identity.js",
    "apps/server/dist/model-connections.js",
    "apps/server/dist/model-network.js",
    "apps/server/dist/model-credential-cipher.js",
    "apps/server/dist/posix-files.js",
    "node_modules/koffi/package.json",
    "node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node",
    "node_modules/openai/package.json",
    "node_modules/@anthropic-ai/sdk/package.json",
    "apps/server/dist/channel-read.js",
    "apps/server/dist/channel-read-query.js",
    "apps/server/dist/channel-read-projection.js",
    "node_modules/postgres/package.json",
    "node_modules/fastify/package.json",
    "node_modules/@fastify/static/package.json",
  ])
    await containedProductFile(runtimeRoot, name);
  await containedProductFile(runtimeRoot, "apps/web/dist/index.html");
  const migration = await containedProductFile(runtimeRoot, "desktop/product-migrate.mjs");
  await preparePrivateDirectories(env);
  const serverEnvironment = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENBOT_TS_WORK_FILE_ROOT: env.OPENBOT_CONTROL_ARTIFACT_ROOT as string,
    ...configuration,
    ...(source.TAVILY_API_KEY === undefined ? {} : { TAVILY_API_KEY: source.TAVILY_API_KEY }),
    OPENBOT_TS_OBJECT_ROOT: env.OPENBOT_CONTROL_OBJECT_ROOT as string,
    OPENBOT_TS_ARTIFACT_ROOT: env.OPENBOT_CONTROL_ARTIFACT_ROOT as string,
    OPENBOT_TS_PLUGIN_STORE_PATH: env.OPENBOT_CONTROL_PLUGIN_STORE_PATH as string,
    OPENBOT_TS_PLUGIN_LOCAL_ENDPOINTS: env.OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS as string,
    OPENBOT_TS_PARSER_WORKER_PATH: join(runtimeRoot, "apps/server/dist/parser-worker.js"),
    OPENBOT_TS_NODE_MODULE_ROOT: join(runtimeRoot, "node_modules"),
    OPENBOT_TS_MODEL_CONNECTION_KEY_PATH: env.OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH as string,
    OPENBOT_TS_OWNER_PASSWORD: env.OPENBOT_CONTROL_OWNER_PASSWORD as string,
    OPENBOT_TS_AUTH_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
    OPENBOT_TS_WRITE_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
    OPENBOT_TS_READ_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
    OPENBOT_TS_DATABASE_URL: env.OPENBOT_CONTROL_DATABASE_URL as string,
    OPENBOT_TS_HOST: "127.0.0.1",
    OPENBOT_CONTROL_WEB_ROOT: join(runtimeRoot, "apps/web/dist"),
    OPENBOT_TS_PORT: env.OPENBOT_CONTROL_PORT as string,
    OPENBOT_TS_PUBLIC_ORIGIN: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
  };
  const launch = async () => {
    startup?.signal.throwIfAborted();
    await fixedProcess(
      node,
      [migration],
      { ...serverEnvironment, OPENBOT_DATABASE_URL: env.OPENBOT_CONTROL_DATABASE_URL as string },
      runtimeRoot,
      60000,
      startup?.signal,
    );
    const child: ChildProcessByStdio<Writable, null, null> = spawn(node, [entry], {
      cwd: runtimeRoot,
      env: serverEnvironment,
      stdio: ["pipe", "ignore", "ignore"],
      shell: false,
    });
    let alive = true;
    let exitCode: number | null = null;
    const closed = new Promise<void>((resolve) => {
      const done = () => {
        alive = false;
        resolve();
      };
      child.once("error", done);
      child.once("close", (code) => {
        exitCode = code;
        done();
      });
    });
    child.stdin.on("error", () => undefined);
    let stopping: Promise<void> | undefined;
    const managed: ManagedServerProcess & {
      readonly processIds: readonly number[];
    } = {
      processIds: child.pid === undefined ? [] : [child.pid],
      isAlive: () => !stopping && alive,
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          if (alive) {
            child.stdin.end("SHUTDOWN\n");
            const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
            try {
              await closed;
            } finally {
              clearTimeout(timer);
            }
          }
        })();
        return stopping;
      },
    };
    try {
      const deadline = Date.now() + 30000;
      while (managed.isAlive() && Date.now() < deadline) {
        startup?.signal.throwIfAborted();
        if (
          await verifyProductHealth(
            env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
            "typescript-product-candidate",
          )
        ) {
          if (managed.isAlive()) return managed;
          break;
        }
        await delay(100);
      }
      if (exitCode === 75) throw new TemporalUnavailableError();
      throw new Error("TS product entry did not become ready.");
    } catch (error) {
      await managed.stop();
      throw error;
    }
  };
  return waitForProductDependencies(
    launch,
    configuration.OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH,
    startup,
  );
}
