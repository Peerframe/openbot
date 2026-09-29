// One owner for the isolated Python child that every server-python comparator starts.
//
// Each caller keeps its own program, `-u` choice, working directory, stdin, deadline, output
// bound, assertions and diagnostics. This module fixes only how the child is spawned: the package
// interpreter `.venv/bin/python`, `-I`, the pinned `src` path as the program's first argument, and
// a PATH-only environment, so no ambient variable or credential reaches the child.
import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { fileURLToPath } from "node:url";

export const COMPARATOR_PATH = "/usr/bin:/bin";
export const TEN_SECONDS = 10_000;
export const THIRTY_SECONDS = 30_000;
export const ONE_MIB = 1_048_576;
export const TWO_MIB = 2_097_152;

export type ComparatorTimeout = typeof TEN_SECONDS | typeof THIRTY_SECONDS;
export type ComparatorOutputLimit = typeof ONE_MIB | typeof TWO_MIB;

export interface ComparatorPaths {
  readonly interpreter: URL;
  readonly source: URL;
}

export interface PythonComparatorRun {
  /** The apps/server-python directory URL, ending in "/". */
  readonly packageRoot: URL;
  readonly program: string;
  /** Adds `-u` directly after `-I`. */
  readonly unbuffered: boolean;
  /** Arguments after the source path, such as fixture files. */
  readonly programArguments?: readonly string[];
  /** Absent: the child inherits this process's working directory. */
  readonly cwd?: URL;
  /** Absent: stdin is ignored. Present: written to a piped stdin. */
  readonly stdin?: string;
  readonly timeoutMs: ComparatorTimeout;
  readonly maxBufferBytes: ComparatorOutputLimit;
}

export function comparatorPaths(packageRoot: URL): ComparatorPaths {
  return {
    interpreter: new URL(".venv/bin/python", packageRoot),
    source: new URL("src", packageRoot),
  };
}

export function pythonComparatorArguments(run: PythonComparatorRun): string[] {
  return [
    "-I",
    ...(run.unbuffered ? ["-u"] : []),
    "-c",
    run.program,
    fileURLToPath(comparatorPaths(run.packageRoot).source),
    ...(run.programArguments ?? []),
  ];
}

export function runPythonComparator(run: PythonComparatorRun): SpawnSyncReturns<string> {
  // Untyped JavaScript callers are held to the same two deadlines and two output bounds.
  if (run.timeoutMs !== TEN_SECONDS && run.timeoutMs !== THIRTY_SECONDS)
    throw new TypeError("Comparator timeout must be 10 or 30 seconds.");
  if (run.maxBufferBytes !== ONE_MIB && run.maxBufferBytes !== TWO_MIB)
    throw new TypeError("Comparator output limit must be 1 or 2 MiB.");
  const options: SpawnSyncOptionsWithStringEncoding = {
    env: { PATH: COMPARATOR_PATH },
    encoding: "utf8",
    stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: run.timeoutMs,
    maxBuffer: run.maxBufferBytes,
  };
  if (run.cwd !== undefined) options.cwd = fileURLToPath(run.cwd);
  if (run.stdin !== undefined) options.input = run.stdin;
  return spawnSync(
    fileURLToPath(comparatorPaths(run.packageRoot).interpreter),
    pythonComparatorArguments(run),
    options,
  );
}

/** The Node error code of a failed spawn (ENOENT, ETIMEDOUT, ENOBUFS), when it has one. */
export function spawnErrorCode(error: Error | undefined): string | undefined {
  if (error === undefined || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
