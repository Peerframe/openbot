/** Preserves owned profile paths and validates fixed Server resources before launch. */
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardBody, isJsonContentType, readBoundedText } from "./bounded-response.js";
import type { ManagedServerProcess } from "./native-server.js";

export function productEnvironment(
  runtimeRoot: string,
  source: Record<string, string>,
): Record<string, string> {
  const port = source.OPENBOT_PORT;
  const origin = `http://127.0.0.1:${port}`;
  const modelPath = source.OPENBOT_MODEL_SETTINGS_PATH;
  const objects = source.OPENBOT_OBJECT_STORE_PATH;
  let database: URL;
  try {
    database = new URL(source.OPENBOT_DATABASE_URL ?? "");
  } catch {
    throw new Error("Server requires a local PostgreSQL database.");
  }
  if (
    source.OPENBOT_HOST !== "127.0.0.1" ||
    !port ||
    !/^[0-9]{1,5}$/u.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    source.OPENBOT_ALLOWED_ORIGINS !== origin ||
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname !== "127.0.0.1" ||
    !database.username ||
    !database.password ||
    !database.port ||
    database.search ||
    database.hash ||
    !source.OPENBOT_OWNER_PASSWORD ||
    source.OPENBOT_OWNER_PASSWORD.length < 15 ||
    source.OPENBOT_OWNER_PASSWORD.length > 1024 ||
    (source.OPENBOT_MODEL_ENCRYPTION_KEY !== undefined &&
      !/^[0-9a-f]{64}$/u.test(source.OPENBOT_MODEL_ENCRYPTION_KEY)) ||
    !modelPath ||
    !objects ||
    !isAbsolute(runtimeRoot) ||
    !isAbsolute(modelPath) ||
    !isAbsolute(objects) ||
    objects !== join(dirname(modelPath), "objects") ||
    modelPath !== join(dirname(modelPath), "model-settings.json")
  )
    throw new Error("Server bootstrap configuration is invalid.");
  const localEndpointText = source.OPENBOT_PLUGIN_LOCAL_ENDPOINTS ?? "";
  const localEndpoints = localEndpointText
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    localEndpointText.length > 32768 ||
    localEndpoints.length > 16 ||
    localEndpoints.some((value) => {
      try {
        new URL(value);
        return value.length > 2048;
      } catch {
        return true;
      }
    })
  )
    throw new Error("Server plugin endpoint configuration is invalid.");
  const dataRoot = dirname(modelPath);
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    OPENBOT_CONTROL_AUTHORITY: "product",
    OPENBOT_CONTROL_COOKIE_MODE: "loopback",
    OPENBOT_CONTROL_PORT: port,
    OPENBOT_CONTROL_DATABASE_URL: source.OPENBOT_DATABASE_URL as string,
    OPENBOT_CONTROL_OWNER_PASSWORD: source.OPENBOT_OWNER_PASSWORD,
    OPENBOT_CONTROL_ALLOWED_ORIGINS: origin,
    OPENBOT_CONTROL_OBJECT_ROOT: objects,
    OPENBOT_CONTROL_ARTIFACT_ROOT: join(objects, "work-artifacts"),
    OPENBOT_CONTROL_MODEL_SETTINGS_PATH: modelPath,
    ...(source.OPENBOT_MODEL_ENCRYPTION_KEY
      ? {
          OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY: source.OPENBOT_MODEL_ENCRYPTION_KEY,
        }
      : {}),
    OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH: join(dataRoot, "model-connections.key"),
    OPENBOT_CONTROL_PLUGIN_STORE_PATH: join(objects, "plugins", "state.json"),
    OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS: JSON.stringify(localEndpoints),
    OPENBOT_CONTROL_NODE_EXECUTABLE: join(runtimeRoot, "node", "bin", "node"),
    OPENBOT_CONTROL_NODE_MODULE_ROOT: join(runtimeRoot, "node_modules"),
    ...(source.TAVILY_API_KEY ? { TAVILY_API_KEY: source.TAVILY_API_KEY } : {}),
  };
}

/** Only fixed Owner-controlled app-data files select existing engine and execution adapters. */
export async function productConfigurationEnvironment(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const modelPath = env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH;
  if (!modelPath || !isAbsolute(modelPath))
    throw new Error("Server product configuration is invalid.");
  const dataRoot = dirname(modelPath);
  const directory = await lstat(dataRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(dataRoot)) !== dataRoot
  )
    throw new Error("Server product configuration directory must be private.");
  const result: Record<string, string> = {};
  for (const [name, variable] of [
    ["temporal.json", "OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH"],
    ["browser.json", "OPENBOT_CONTROL_BROWSER_CONFIG_PATH"],
    ["command.json", "OPENBOT_CONTROL_COMMAND_CONFIG_PATH"],
  ] as const) {
    const path = join(dataRoot, name);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Server product configuration is unavailable.");
    }
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0 ||
      entry.size < 1 ||
      entry.size > 16384
    )
      throw new Error("Server product configuration must be a private owned file.");
    // Server reopens O_NOFOLLOW and validates the descriptor, JSON, route and credentials.
    // This preflight neither reads secrets nor grants cached execution authority.
    result[variable] = path;
  }
  return result;
}

export async function containedProductFile(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const entry = await lstat(path);
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(path);
  const child = relative(resolvedRoot, resolved);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error("Server resource is invalid.");
  return path;
}

export async function preparePrivateDirectories(env: Record<string, string>) {
  const dataRoot = dirname(env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH as string);
  if ((await realpath(dataRoot)) !== dataRoot)
    throw new Error("Server data directory must have a canonical private path.");
  for (const path of [
    dataRoot,
    env.OPENBOT_CONTROL_OBJECT_ROOT as string,
    join(env.OPENBOT_CONTROL_OBJECT_ROOT as string, "attachments"),
    join(env.OPENBOT_CONTROL_OBJECT_ROOT as string, "plugins"),
    env.OPENBOT_CONTROL_ARTIFACT_ROOT as string,
  ]) {
    if (path !== dataRoot)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error("Server data directory must be private and owner-controlled.");
  }
}

/** Exit 75 is emitted only by the bundled Desktop entry's Temporal connection phase. */
export class TemporalUnavailableError extends Error {
  constructor() {
    super("Temporal connection is unavailable.");
  }
}

export async function fixedProcess(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: "ignore",
      shell: false,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Server preflight failed."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else
        reject(
          code === 75 ? new TemporalUnavailableError() : new Error("Server preflight failed."),
        );
    });
  });
}

export async function verifyProductHealth(
  origin: string,
  phase = "typescript-product-candidate",
): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${origin}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || !isJsonContentType(response.headers.get("content-type")) || !response.body)
      return false;
    const value: unknown = JSON.parse(await readBoundedText(response, 4096));
    return (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === true &&
      "service" in value &&
      "phase" in value &&
      value.service === "openbot-server" &&
      value.phase === phase
    );
  } catch {
    return false;
  } finally {
    discardBody(response?.body);
  }
}
