import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgumentPairs } from "../../../scripts/argument-pairs.ts";

const maximumBytes = 16384;

export interface ProbePaths {
  runtimeRoot: string;
  desktopDist: string;
  temporalConfigPath: string;
}
export interface PollerObservation {
  format: "openbot.desktop.temporal-pollers/v1";
  freshWorkflowPollers: 1;
  freshActivityPollers: 1;
  sameWorkerIdentity: true;
  workerIdentitySha256: string;
}

export function parseArguments(args: readonly string[]): ProbePaths {
  const failure = "Three explicit absolute probe paths are required.";
  const values = parseArgumentPairs(args, failure);
  const runtimeRoot = values.get("--runtime");
  const desktopDist = values.get("--desktop-dist");
  const temporalConfigPath = values.get("--temporal-config");
  if (
    values.size !== 3 ||
    !runtimeRoot ||
    !desktopDist ||
    !temporalConfigPath ||
    ![runtimeRoot, desktopDist, temporalConfigPath].every(isAbsolute)
  )
    throw new Error(failure);
  return { runtimeRoot, desktopDist, temporalConfigPath };
}

/** Read only the explicit trusted input; never copy TLS private-key contents. */
export async function isolatedConfiguration(path: string): Promise<string> {
  let handle: FileHandle | undefined;
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
    const config: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !("queue" in config) ||
      typeof config.queue !== "string"
    )
      throw new Error();
    // Isolate polling authority from other Workers. All other fields survive unchanged so
    // the bundled Server, not this test harness, remains the final configuration authority.
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

export async function observeBundledPollers(
  runtimeRoot: string,
  configPath: string,
  startedAt: number,
): Promise<PollerObservation> {
  const helper = fileURLToPath(new URL("./observe-pollers.ts", import.meta.url));
  const data = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      join(runtimeRoot, "node/bin/node"),
      [helper, runtimeRoot, configPath, String(startedAt)],
      {
        cwd: runtimeRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.stdout.on("data", (part: Buffer) => {
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
  let result: unknown;
  try {
    result = JSON.parse(data);
  } catch {
    throw new Error("Invalid SDK probe response.");
  }
  if (
    !result ||
    typeof result !== "object" ||
    !("format" in result) ||
    result.format !== "openbot.desktop.temporal-pollers/v1" ||
    !("freshWorkflowPollers" in result) ||
    result.freshWorkflowPollers !== 1 ||
    !("freshActivityPollers" in result) ||
    result.freshActivityPollers !== 1 ||
    !("sameWorkerIdentity" in result) ||
    result.sameWorkerIdentity !== true ||
    !("workerIdentitySha256" in result) ||
    typeof result.workerIdentitySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(result.workerIdentitySha256)
  )
    throw new Error("Required fresh Workflow and Activity pollers were not observed.");
  return result as PollerObservation;
}
