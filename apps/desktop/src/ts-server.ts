import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { availablePort, type ManagedServerProcess } from "./native-server.js";
import {
  containedProductFile,
  launchPythonProductServer,
  pythonProductEnvironment,
  selectsPythonProduct,
  verifyPythonProductHealth,
} from "./python-server.js";
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
    process.arch !== "arm64" ||
    !(await selectsPythonProduct(runtimeRoot))
  ) {
    throw new Error("TS candidate does not match its reviewed Python/platform composition.");
  }
  return true;
}

/** Resource selection is fixed at package time; malformed TS selection never falls back. */
export async function launchDesktopProductServer(
  runtimeRoot: string,
  source: Record<string, string>,
): Promise<ManagedServerProcess & { readonly processIds: readonly number[] }> {
  return (await selectsTsProduct(runtimeRoot))
    ? launchTsProductServer(runtimeRoot, source)
    : launchPythonProductServer(runtimeRoot, source);
}

export async function launchTsProductServer(
  runtimeRoot: string,
  source: Record<string, string>,
): Promise<ManagedServerProcess & { readonly processIds: readonly number[] }> {
  if (!(await selectsTsProduct(runtimeRoot))) throw new Error("TS candidate is not selected.");
  const env = pythonProductEnvironment(runtimeRoot, source);
  const node = await containedProductFile(runtimeRoot, "node/bin/node");
  const entry = await containedProductFile(runtimeRoot, "apps/server-ts/dist/desktop-entry.js");
  // Refuse incomplete installed payloads before the Python migrator or writer starts.
  for (const name of [
    "apps/server-ts/dist/app.js",
    "apps/server-ts/dist/tls.js",
    "apps/server-ts/dist/transcription-read.js",
    "apps/server-ts/dist/primary-bot-write.js",
    "apps/server-ts/dist/write-input.js",
    "apps/server-ts/dist/owner-auth.js",
    "apps/server-ts/dist/owner-auth-crypto.js",
    "apps/server-ts/dist/owner-auth-store.js",
    "apps/server-ts/dist/channel-read.js",
    "apps/server-ts/dist/channel-read-query.js",
    "apps/server-ts/dist/channel-read-projection.js",
    "node_modules/postgres/package.json",
    "node_modules/fastify/package.json",
    "node_modules/@fastify/reply-from/package.json",
  ])
    await containedProductFile(runtimeRoot, name);
  let privatePort = await availablePort();
  for (let attempt = 0; String(privatePort) === env.OPENBOT_CONTROL_PORT && attempt < 8; attempt++)
    privatePort = await availablePort();
  if (String(privatePort) === env.OPENBOT_CONTROL_PORT)
    throw new Error("Python private forwarding port is unavailable.");
  const python = await launchPythonProductServer(
    runtimeRoot,
    source,
    privatePort,
    TS_CANDIDATE.readGroup,
    TS_CANDIDATE.writeGroup,
    TS_CANDIDATE.authGroup,
    TS_CANDIDATE.channelReadGroup,
  );
  let child: ChildProcessByStdio<Writable, null, null>;
  try {
    child = spawn(node, [entry], {
      cwd: runtimeRoot,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        OPENBOT_TS_READ_GROUP: TS_CANDIDATE.readGroup,
        OPENBOT_TS_WRITE_GROUP: TS_CANDIDATE.writeGroup,
        OPENBOT_TS_AUTH_GROUP: TS_CANDIDATE.authGroup,
        OPENBOT_TS_CHANNEL_READ_GROUP: TS_CANDIDATE.channelReadGroup,
        OPENBOT_TS_OWNER_PASSWORD: env.OPENBOT_CONTROL_OWNER_PASSWORD as string,
        OPENBOT_TS_AUTH_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
        OPENBOT_TS_WRITE_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
        OPENBOT_TS_READ_ALLOWED_ORIGINS: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
        OPENBOT_TS_DATABASE_URL: env.OPENBOT_CONTROL_DATABASE_URL as string,
        OPENBOT_TS_HOST: "127.0.0.1",
        OPENBOT_TS_PORT: env.OPENBOT_CONTROL_PORT as string,
        OPENBOT_TS_PUBLIC_ORIGIN: env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string,
        OPENBOT_TS_PYTHON_ORIGIN: `http://127.0.0.1:${privatePort}`,
      },
      stdio: ["pipe", "ignore", "ignore"],
      shell: false,
    });
  } catch (error) {
    await python.stop();
    throw error;
  }
  let alive = true;
  const closed = new Promise<void>((resolve) => {
    const done = () => {
      alive = false;
      resolve();
    };
    child.once("error", done);
    child.once("close", done);
  });
  child.stdin.on("error", () => undefined);
  let stopping: Promise<void> | undefined;
  const managed: ManagedServerProcess & {
    readonly processIds: readonly number[];
  } = {
    processIds: [...python.processIds, ...(child.pid === undefined ? [] : [child.pid])],
    isAlive: () => !stopping && alive && python.isAlive(),
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          if (alive) {
            child.stdin.end("SHUTDOWN\n");
            const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
            try {
              await closed;
            } finally {
              clearTimeout(timer);
            }
          }
        } finally {
          await python.stop();
        }
      })();
      return stopping;
    },
  };
  // A child's terminal event closes its partner; no supervisor retry or second writer.
  void Promise.race([closed, python.closed])
    .then(() => managed.stop())
    .catch(() => undefined);
  try {
    const deadline = Date.now() + 30000;
    while (managed.isAlive() && Date.now() < deadline) {
      if (await verifyPythonProductHealth(env.OPENBOT_CONTROL_ALLOWED_ORIGINS as string)) {
        if (managed.isAlive()) return managed;
        break;
      }
      await delay(100);
    }
    throw new Error("TS product entry did not become ready.");
  } catch (error) {
    await managed.stop();
    throw error;
  }
}
