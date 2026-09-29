import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { parseArgumentPairs } from "./argument-pairs.ts";
import {
  type LinuxArchitecture,
  type PackagedNodeHelloExpectation,
  validateLinuxArchiveToolPaths,
  validatePackagedNodeHello,
} from "./node-linux-release.ts";

/**
 * Candidate delivery lifecycle owned by the three Linux candidate CLIs (build, pack, smoke).
 * Release policy (pins, manifests, SBOM, toolchain and hello validation) stays in
 * node-linux-release.ts; this module only owns argument contracts, scratch/output lifetimes,
 * archive member checks and the packaged-runtime smoke session. It never imports a CLI entry.
 */

export interface CandidateBuildOptions {
  readonly architecture: string;
  readonly nodeArchive: string;
  readonly npmCli: string;
  readonly outputDirectory: string;
  readonly sourceCommit: string;
  readonly sourceDateEpoch: string;
  readonly version: string;
}

export interface CandidateArchiveOptions {
  readonly candidate: string;
  readonly dpkgQuery: "/usr/bin/dpkg-query";
  readonly gnuTar: "/usr/bin/tar";
  readonly outputDirectory: string;
  readonly xz: "/usr/bin/xz";
}

export interface CandidateSmokeOptions {
  readonly architecture: LinuxArchitecture;
  readonly candidate: string;
}

/** Reviewed compressed archive size bound enforced by the pack CLI. */
export const CANDIDATE_ARCHIVE_SIZE_BOUNDS = Object.freeze({
  minimumBytes: 1024 * 1024,
  maximumBytes: 96 * 1024 * 1024,
});
const CANDIDATE_ENTRY_BOUND = 300;
const ARCHIVE_LISTING_BYTES_BOUND = 128 * 1024;
const SMOKE_DEADLINE_MS = 15_000;
const SMOKE_OUTPUT_BYTES_BOUND = 64 * 1024;
const SMOKE_HELLO_BYTES_BOUND = 64 * 1024;
type SmokeChild = ChildProcessByStdio<null, Readable, Readable>;
/** Fail the probe if the kernel has not confirmed exit within the teardown bound. */
const SMOKE_CHILD_REAP_MS = 5_000;

export function parseCandidateBuildArguments(arguments_: readonly string[]): CandidateBuildOptions {
  const values = parseArgumentPairs(
    arguments_,
    "Release arguments must be unique --name value pairs.",
  );
  const allowed = new Set([
    "--arch",
    "--node-archive",
    "--npm-cli",
    "--out-dir",
    "--source-commit",
    "--source-date-epoch",
    "--version",
  ]);
  for (const key of values.keys())
    if (!allowed.has(key)) throw new Error(`Unknown release argument: ${key}.`);
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing release argument: ${key}.`);
    return value;
  };
  return {
    architecture: required("--arch"),
    nodeArchive: path.resolve(required("--node-archive")),
    npmCli: path.resolve(required("--npm-cli")),
    outputDirectory: path.resolve(required("--out-dir")),
    sourceCommit: required("--source-commit"),
    sourceDateEpoch: required("--source-date-epoch"),
    version: required("--version"),
  };
}

export function parseCandidateArchiveArguments(
  arguments_: readonly string[],
): CandidateArchiveOptions {
  const values = parseArgumentPairs(
    arguments_,
    "Archive arguments must be unique --name value pairs.",
  );
  const allowed = new Set(["--candidate", "--dpkg-query", "--gnu-tar", "--out-dir", "--xz"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown archive argument: ${key}.`);
  }
  const requiredAbsolute = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing archive argument: ${key}.`);
    if (!path.isAbsolute(value)) throw new Error(`Archive argument must be absolute: ${key}.`);
    return value;
  };
  const tools = validateLinuxArchiveToolPaths({
    dpkgQuery: requiredAbsolute("--dpkg-query"),
    gnuTar: requiredAbsolute("--gnu-tar"),
    xz: requiredAbsolute("--xz"),
  });
  return {
    candidate: requiredAbsolute("--candidate"),
    dpkgQuery: tools.dpkgQuery,
    gnuTar: tools.gnuTar,
    outputDirectory: requiredAbsolute("--out-dir"),
    xz: tools.xz,
  };
}

export function parseCandidateSmokeArguments(arguments_: readonly string[]): CandidateSmokeOptions {
  const values = parseArgumentPairs(
    arguments_,
    "Smoke arguments must be unique --name value pairs.",
  );
  for (const key of values.keys()) {
    if (key !== "--arch" && key !== "--candidate") {
      throw new Error(`Unknown smoke argument: ${key}.`);
    }
  }
  const architecture = values.get("--arch");
  const candidate = values.get("--candidate");
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("Smoke architecture must be x64 or arm64.");
  }
  if (candidate === undefined || !path.isAbsolute(candidate)) {
    throw new Error("Smoke candidate path must be absolute.");
  }
  return { architecture, candidate };
}

/** Deterministic C/UTC environment for every native release tool invocation. */
export function releaseCommandEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}

export function runReleaseCommand(
  command: string,
  arguments_: readonly string[],
  cwd?: string,
): string {
  return execFileSync(command, arguments_, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: releaseCommandEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Owns one private scratch directory for the lifetime of `body`; it is removed on success and
 * on every failure after creation, including failures before any payload was written.
 */
export async function withOwnedScratch<T>(
  prefix: string,
  body: (scratch: string) => Promise<T>,
  temporaryRoot: string = tmpdir(),
): Promise<T> {
  const scratch = await mkdtemp(path.join(temporaryRoot, prefix));
  try {
    return await body(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Creates `target` exclusively (a pre-existing path fails with EEXIST and is never touched) and
 * removes only that newly created directory when `body` fails, so a failed build cannot leave a
 * partial candidate that blocks the next attempt or is mistaken for output.
 */
export async function withExclusiveOutputDirectory<T>(
  target: string,
  body: () => Promise<T>,
): Promise<T> {
  await mkdir(target);
  try {
    return await body();
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Refuses to proceed when any release output name already exists (including dangling links). */
export async function assertOutputAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Release output already exists: ${path.basename(target)}.`);
}

/**
 * Tracks outputs this process created exclusively. Rollback unlinks only claimed paths, so an
 * exclusive-create collision (EEXIST) with another writer's file is never deleted.
 */
export class ExclusiveOutputs {
  readonly #created: string[] = [];

  async claim<T>(target: string, create: () => Promise<T>): Promise<T> {
    const result = await create();
    this.#created.push(target);
    return result;
  }

  async rollback(): Promise<void> {
    for (const target of this.#created.splice(0)) {
      await unlink(target).catch(() => undefined);
    }
  }
}

export async function assertClampMtimePrecondition(
  root: string,
  sourceDateMilliseconds: number,
): Promise<void> {
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      count += 1;
      if (count > CANDIDATE_ENTRY_BOUND) {
        throw new Error("Release candidate exceeds the archive entry bound.");
      }
      const child = path.join(directory, name);
      const metadata = await lstat(child);
      if (metadata.mtimeMs < sourceDateMilliseconds) {
        throw new Error("Release candidate contains an mtime older than its source date.");
      }
      if (metadata.isDirectory()) await visit(child);
    }
  };
  const rootMetadata = await lstat(root);
  if (rootMetadata.mtimeMs < sourceDateMilliseconds) {
    throw new Error("Release candidate directory mtime is older than its source date.");
  }
  await visit(root);
}

export function validateArchiveMembers(source: unknown, candidateName: string): void {
  if (
    typeof source !== "string" ||
    source.length < 1 ||
    source.length > ARCHIVE_LISTING_BYTES_BOUND
  ) {
    throw new Error("Archive member listing is missing or too large.");
  }
  const members = source.trimEnd().split("\n");
  if (members.length > CANDIDATE_ENTRY_BOUND) {
    throw new Error("Linux archive exceeds the member-count bound.");
  }
  for (const member of members) {
    const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
    if (
      normalized !== candidateName &&
      (!normalized.startsWith(`${candidateName}/`) ||
        normalized.includes("\\") ||
        normalized.split("/").some((part) => part === "" || part === "." || part === ".."))
    ) {
      throw new Error("Linux archive contains a member outside the candidate root.");
    }
  }
}

export type PackagedNodeHelloParse =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false };

/** Structural view of the protocol schema so the session does not depend on a built package. */
export interface PackagedNodeHelloSchema {
  safeParse(value: unknown): PackagedNodeHelloParse;
}

export interface PackagedNodeSmokeSession {
  readonly architecture: LinuxArchitecture;
  readonly executable: string;
  readonly entryPoint: string;
  readonly helloSchema: PackagedNodeHelloSchema;
  readonly protocolVersion: string;
  readonly temporaryRoot?: string;
}

/**
 * Runs the bundled entry point against an isolated loopback gateway. Every resource the session
 * acquires (scratch, gateway, accepted sockets, child) is released in reverse order on success
 * and on every failure. An unconfirmed child exit is reported as a teardown failure.
 */
export async function runPackagedNodeSmoke(session: PackagedNodeSmokeSession): Promise<void> {
  await withOwnedScratch(
    "openbot-node-linux-smoke-",
    async (scratch) => {
      await mkdir(path.join(scratch, "home"));
      await mkdir(path.join(scratch, "work"));
      // Loaded only by the smoke session so build/pack never load the gateway dependency.
      const { WebSocketServer } = await import("ws");
      const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      let child: SmokeChild | undefined;
      try {
        await waitForListening(gateway);
        const address = gateway.address();
        if (address === null || typeof address === "string") {
          throw new Error("Packaged runtime smoke gateway did not bind a TCP port.");
        }
        const nodeId = `release-smoke-${session.architecture}`;
        const credential = `obn_${"s".repeat(43)}`;
        child = spawn(session.executable, [session.entryPoint], {
          cwd: scratch,
          env: {
            HOME: path.join(scratch, "home"),
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            OPENBOT_LOG_LEVEL: "error",
            OPENBOT_NODE_CREDENTIAL: credential,
            OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: "true",
            OPENBOT_NODE_CREDENTIAL_STORE: "file",
            OPENBOT_NODE_ID: nodeId,
            OPENBOT_NODE_MAX_CONCURRENT_RUNS: "1",
            OPENBOT_NODE_SERVER_URL: `ws://127.0.0.1:${address.port}`,
            OPENBOT_NODE_WORK_DIRECTORY: path.join(scratch, "work"),
            PATH: "/usr/bin:/bin",
            TMPDIR: scratch,
            TZ: "UTC",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        await observeHelloAndStop(gateway, child, session, {
          architecture: session.architecture,
          credential,
          nodeId,
          protocolVersion: session.protocolVersion,
        });
      } finally {
        try {
          if (child !== undefined) await killAndReap(child);
        } finally {
          for (const socket of gateway.clients) socket.terminate();
          await closeGateway(gateway);
        }
      }
    },
    session.temporaryRoot,
  );
}

function observeHelloAndStop(
  gateway: WebSocketServer,
  child: SmokeChild,
  session: PackagedNodeSmokeSession,
  expected: PackagedNodeHelloExpectation,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let outputBytes = 0;
    let helloAccepted = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Packaged Node hello or shutdown exceeded the 15-second deadline."));
    }, SMOKE_DEADLINE_MS);

    function finish(error?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      gateway.off("error", onGatewayError);
      if (error === undefined) resolve();
      else reject(error);
    }
    function onGatewayError(error: Error): void {
      finish(new Error("Packaged Node smoke gateway failed.", { cause: error }));
      child.kill("SIGKILL");
    }
    const capture = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > SMOKE_OUTPUT_BYTES_BOUND) {
        child.kill("SIGKILL");
        finish(new Error("Packaged Node smoke output exceeded the 64 KiB bound."));
      }
    };
    gateway.on("error", onGatewayError);
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) =>
      finish(new Error("Packaged Node could not start.", { cause: error })),
    );
    child.once("exit", (code, signal) => {
      if (!helloAccepted) {
        finish(new Error("Packaged Node exited before a valid hello."));
        return;
      }
      if (code !== 0 || signal !== null) {
        finish(new Error("Packaged Node did not terminate cleanly after SIGTERM."));
        return;
      }
      finish();
    });
    gateway.once("connection", (socket: WebSocket) => {
      socket.on("error", (error) => {
        finish(new Error("Packaged Node smoke gateway connection failed.", { cause: error }));
        child.kill("SIGKILL");
      });
      socket.once("message", (raw: RawData) => {
        const payload = rawDataBuffer(raw);
        if (payload.byteLength > SMOKE_HELLO_BYTES_BOUND) {
          finish(new Error("Packaged Node hello exceeded the 64 KiB bound."));
          child.kill("SIGKILL");
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(payload.toString());
        } catch {
          finish(new Error("Packaged Node hello was not valid JSON."));
          child.kill("SIGKILL");
          return;
        }
        const parsed = session.helloSchema.safeParse(decoded);
        if (!parsed.success) {
          finish(new Error("Packaged Node hello did not match the protocol schema."));
          child.kill("SIGKILL");
          return;
        }
        try {
          validatePackagedNodeHello(parsed.data, expected);
        } catch (error) {
          finish(error);
          child.kill("SIGKILL");
          return;
        }
        helloAccepted = true;
        socket.send(
          JSON.stringify({
            type: "server.ack",
            protocolVersion: expected.protocolVersion,
            accepted: true,
            receivedAt: new Date().toISOString(),
          }),
          (error) => {
            if (error != null) {
              finish(new Error("Smoke gateway could not acknowledge the packaged Node."));
              child.kill("SIGKILL");
              return;
            }
            child.kill("SIGTERM");
          },
        );
      });
    });
  });
}

function rawDataBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function waitForListening(gateway: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      gateway.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      gateway.off("listening", onListening);
      reject(error);
    };
    gateway.once("listening", onListening);
    gateway.once("error", onError);
  });
}

function closeGateway(gateway: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => gateway.close(() => resolve()));
}

async function killAndReap(child: SmokeChild): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.off("exit", done);
      reject(new Error("Packaged Node exit could not be confirmed after SIGKILL."));
    }, SMOKE_CHILD_REAP_MS);
    function done(): void {
      clearTimeout(deadline);
      resolve();
    }
    child.once("exit", done);
    child.kill("SIGKILL");
  });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
