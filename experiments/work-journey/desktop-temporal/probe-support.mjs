import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const maximumBytes = 16384;

export function parseArguments(args) {
  const names = new Map([
    ["--runtime", "runtimeRoot"],
    ["--desktop-dist", "desktopDist"],
    ["--temporal-config", "temporalConfigPath"],
  ]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names.get(args[i]);
    if (!key || key in options || !args[i + 1] || !isAbsolute(args[i + 1]))
      throw new Error("Three explicit absolute probe paths are required.");
    options[key] = args[i + 1];
  }
  if (Object.keys(options).length !== names.size)
    throw new Error("Three explicit absolute probe paths are required.");
  return options;
}

/** Read only the explicit trusted input; never copy TLS private-key contents. */
export async function isolatedConfiguration(path) {
  let handle;
  try {
    if (!isAbsolute(path) || !process.getuid) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > maximumBytes
    )
      throw new Error();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== before.size ||
      length > maximumBytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error();
    const config = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof config.queue !== "string"
    )
      throw new Error();
    // Isolate polling authority from other Workers. All other fields survive unchanged so
    // bundled Python, not this test harness, remains the final configuration authority.
    config.queue = `openbot-desktop-probe-${randomUUID()}`;
    const data = JSON.stringify(config);
    if (Buffer.byteLength(data) > maximumBytes) throw new Error();
    return data;
  } catch {
    throw new Error("Explicit probe configuration must be a bounded private owned JSON file.");
  } finally {
    await handle?.close();
  }
}

export async function observeBundledPollers(runtimeRoot, configPath, startedAt) {
  const helper = fileURLToPath(new URL("./observe-pollers.py", import.meta.url));
  const data = await new Promise((resolve, reject) => {
    const child = spawn(
      join(runtimeRoot, "python/bin/python3.12"),
      ["-I", "-B", helper, runtimeRoot, configPath, String(startedAt)],
      {
        cwd: runtimeRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.stdout.on("data", (part) => {
      size += part.length;
      if (size > 4096) child.kill("SIGKILL");
      else chunks.push(part);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Bundled SDK poller observation could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 4096)
        reject(new Error("Bundled SDK did not observe the required fresh pollers."));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  let result;
  try {
    result = JSON.parse(data);
  } catch {
    throw new Error("Invalid SDK probe response.");
  }
  if (
    result?.format !== "openbot.desktop.temporal-pollers/v1" ||
    result.freshWorkflowPollers !== 1 ||
    result.freshActivityPollers !== 1 ||
    result.sameWorkerIdentity !== true ||
    !/^[a-f0-9]{64}$/u.test(result.workerIdentitySha256)
  )
    throw new Error("Required fresh Workflow and Activity pollers were not observed.");
  return result;
}
