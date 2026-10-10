/** Bounded fixed-argv CLI boundary. Truncated output, timeout and incomplete drain stay unknown. */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
export type CommandResult = {
  argv: readonly string[];
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  capturedBytes: number;
  ok: boolean;
  uncertain: boolean;
};
export type Commander = {
  run: (argv: readonly string[], timeoutMs: number) => Promise<CommandResult>;
};
export class DockerUnavailable extends Error {}
export class SubprocessCommander implements Commander {
  readonly binary: string;
  readonly captureLimit: number;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly namespaceDescriptors: readonly number[];
  constructor(options: {
    binary: string;
    environment?: Record<string, string>;
    captureLimit?: number;
    arguments?: readonly string[];
    namespaceDescriptors?: readonly [number, number];
  }) {
    const limit = options.captureLimit ?? 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2 * 1024 * 1024)
      throw new Error("invalid capture limit");
    const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.environment };
    const paths = options.binary.includes("/")
      ? [resolve(options.binary)]
      : environment.PATH.split(delimiter).map((p) => join(p, options.binary));
    const found = paths.find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
    if (!found || !isAbsolute(found)) throw new DockerUnavailable("fixed executable unavailable");
    if (
      options.namespaceDescriptors &&
      !options.namespaceDescriptors.every((fd) => Number.isSafeInteger(fd) && fd >= 0)
    )
      throw new Error("invalid namespace descriptors");
    this.namespaceDescriptors = Object.freeze([...(options.namespaceDescriptors ?? [])]);
    this.binary = found;
    this.captureLimit = limit;
    this.arguments = Object.freeze([...(options.arguments ?? [])]);
    this.environment = Object.freeze(environment);
  }
  run(argv: readonly string[], timeoutMs: number): Promise<CommandResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000)
      throw new Error("invalid command deadline");
    if (!argv.every((v) => typeof v === "string" && !v.includes("\0")))
      throw new Error("invalid command argv");
    const args = [this.binary, ...this.arguments, ...argv];
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.binary, [...this.arguments, ...argv], {
        env: this.environment,
        stdio: ["ignore", "pipe", "pipe", ...this.namespaceDescriptors],
        detached: process.platform !== "win32",
        shell: false,
      });
      const stdout = child.stdout!,
        stderr = child.stderr!;
      const captured: [Buffer[], Buffer[]] = [[], []];
      let size = 0,
        timedOut = false,
        truncated = false,
        settled = false,
        reaper: NodeJS.Timeout | undefined;
      const finish = (status: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (reaper) clearTimeout(reaper);
        const uncertain = timedOut || truncated;
        resolveResult({
          argv: args,
          status: uncertain ? null : status,
          stdout: Buffer.concat(captured[0]).toString("utf8"),
          stderr: Buffer.concat(captured[1]).toString("utf8"),
          timedOut,
          outputTruncated: truncated,
          capturedBytes: size,
          ok: !uncertain && status === 0,
          uncertain,
        });
      };
      const stop = () => {
        if (child.pid)
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              timedOut = true;
            }
          }
        // Never wait forever for an inherited pipe after the owned CLI group is terminated.
        reaper ??= setTimeout(() => {
          stdout.destroy();
          stderr.destroy();
          child.unref();
          finish(null);
        }, 5000);
      };
      const deadline = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      for (const [index, stream] of [stdout, stderr].entries())
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = this.captureLimit - size,
            keep = Math.min(room, chunk.length);
          if (keep) {
            captured[index]!.push(Buffer.from(chunk.subarray(0, keep)));
            size += keep;
          }
          if (chunk.length > room && !truncated) {
            truncated = true;
            stop();
          }
        });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (reaper) clearTimeout(reaper);
        reject(new DockerUnavailable("fixed executable failed to spawn", { cause: error }));
      });
      // close means both pipes reached EOF, unlike exit (a descendant can still hold a pipe).
      child.once("close", finish);
    });
  }
}
