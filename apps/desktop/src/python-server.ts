import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedServerProcess } from "./native-server.js";

const format = "openbot.desktop.python-control/v1";
const maximumStartupMs = 30_000;

export async function selectsPythonProduct(runtimeRoot: string): Promise<boolean> {
  const marker = join(runtimeRoot, "python-control.json");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
    throw new Error("Python candidate manifest is invalid.");
  const value: unknown = JSON.parse(await readFile(marker, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join() !== "arch,backend,format,platform,pythonVersion" ||
    !("format" in value && value.format === format) ||
    !("backend" in value && value.backend === "python-product") ||
    !("pythonVersion" in value && value.pythonVersion === "3.12.13") ||
    !("platform" in value && value.platform === "darwin") ||
    !("arch" in value && value.arch === "arm64") ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  )
    throw new Error("Python candidate does not match this reviewed platform.");
  return true;
}

export function pythonProductEnvironment(
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
    throw new Error("Python candidate requires a local PostgreSQL database.");
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
    !/^[0-9a-f]{64}$/u.test(source.OPENBOT_MODEL_ENCRYPTION_KEY ?? "") ||
    !modelPath ||
    !objects ||
    !isAbsolute(runtimeRoot) ||
    !isAbsolute(modelPath) ||
    !isAbsolute(objects) ||
    objects !== join(dirname(modelPath), "objects") ||
    modelPath !== join(dirname(modelPath), "model-settings.json")
  )
    throw new Error("Python candidate bootstrap configuration is invalid.");
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
    throw new Error("Python candidate plugin endpoint configuration is invalid.");
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
    OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY: source.OPENBOT_MODEL_ENCRYPTION_KEY as string,
    OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH: join(dataRoot, "model-connections.key"),
    OPENBOT_CONTROL_PLUGIN_STORE_PATH: join(objects, "plugins", "state.json"),
    OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS: JSON.stringify(localEndpoints),
    OPENBOT_CONTROL_NODE_EXECUTABLE: join(runtimeRoot, "node", "bin", "node"),
    OPENBOT_CONTROL_NODE_MODULE_ROOT: join(runtimeRoot, "node_modules"),
    ...(source.TAVILY_API_KEY ? { TAVILY_API_KEY: source.TAVILY_API_KEY } : {}),
  };
}

/** Only fixed Owner-controlled app-data files select existing engine and execution adapters. */
export async function pythonProductConfigurationEnvironment(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const modelPath = env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH;
  if (!modelPath || !isAbsolute(modelPath))
    throw new Error("Python candidate product configuration is invalid.");
  const dataRoot = dirname(modelPath);
  const directory = await lstat(dataRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    (await realpath(dataRoot)) !== dataRoot
  )
    throw new Error("Python candidate product configuration directory must be private.");
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
      throw new Error("Python candidate product configuration is unavailable.");
    }
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0 ||
      entry.size < 1 ||
      entry.size > 16384
    )
      throw new Error("Python candidate product configuration must be a private owned file.");
    // Python reopens O_NOFOLLOW and validates the descriptor, JSON, route and credentials.
    // This preflight neither reads secrets nor grants cached execution authority.
    result[variable] = path;
  }
  return result;
}

async function containedFile(root: string, name: string): Promise<string> {
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
    throw new Error("Python candidate resource is invalid.");
  return path;
}

async function preparePrivateDirectories(env: Record<string, string>) {
  const dataRoot = dirname(env.OPENBOT_CONTROL_MODEL_SETTINGS_PATH as string);
  if ((await realpath(dataRoot)) !== dataRoot)
    throw new Error("Python candidate data directory must have a canonical private path.");
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
      throw new Error("Python candidate data directory must be private and owner-controlled.");
  }
}

async function fixedProcess(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeout: number,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: "ignore", shell: false });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Python candidate preflight failed."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("Python candidate preflight failed."));
    });
  });
}

async function healthy(origin: string): Promise<boolean> {
  let response: Response | undefined;
  try {
    response = await fetch(`${origin}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.startsWith("application/json") ||
      !response.body
    )
      return false;
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 4096) return false;
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      value?.ok === true &&
      value.service === "openbot-server" &&
      value.phase === "python-product-candidate"
    );
  } catch {
    return false;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

/** Fixed app resources only; all paths and secrets originate in NativeServerController. */
export async function launchPythonProductServer(
  runtimeRoot: string,
  source: Record<string, string>,
): Promise<ManagedServerProcess> {
  if (!(await selectsPythonProduct(runtimeRoot)))
    throw new Error("Python candidate is not selected.");
  const env = pythonProductEnvironment(runtimeRoot, source);
  const python = await containedFile(runtimeRoot, "python/bin/python3.12");
  const node = await containedFile(runtimeRoot, "node/bin/node");
  const verify = await containedFile(
    runtimeRoot,
    "apps/server-python/scripts/verify_environment.py",
  );
  const entry = await containedFile(runtimeRoot, "desktop/python-control-entry.py");
  const migration = await containedFile(runtimeRoot, "desktop/python-control-migrate.mjs");
  await containedFile(runtimeRoot, "apps/server-python/scripts/serve.py");
  // Validate the complete installed Python profile before any database migration.
  await fixedProcess(
    python,
    ["-I", "-B", verify, "--worker"],
    { PATH: "/usr/bin:/bin", LANG: "C" },
    runtimeRoot,
    15_000,
  );
  await preparePrivateDirectories(env);
  Object.assign(env, await pythonProductConfigurationEnvironment(env));
  await fixedProcess(
    node,
    [migration],
    {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      OPENBOT_DATABASE_URL: source.OPENBOT_DATABASE_URL as string,
    },
    runtimeRoot,
    60_000,
  );
  const child = spawn(python, ["-I", "-B", entry], {
    cwd: runtimeRoot,
    env,
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
  });
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
  const managed: ManagedServerProcess = {
    isAlive: () => alive,
    stop() {
      if (stopping) return stopping;
      if (!alive) return Promise.resolve();
      stopping = (async () => {
        child.stdin.end("SHUTDOWN\n");
        const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      })();
      return stopping;
    },
  };
  try {
    const deadline = Date.now() + maximumStartupMs;
    while (alive && Date.now() < deadline) {
      if (await healthy(`http://127.0.0.1:${env.OPENBOT_CONTROL_PORT}`)) {
        if (alive) return managed;
        break;
      }
      await delay(100);
    }
    throw new Error("Python product API did not become ready.");
  } catch (error) {
    await managed.stop();
    throw error;
  }
}
