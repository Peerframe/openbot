import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { LINUX_RELEASE_ARCHIVE_BOUNDS } from "./node-linux-release.ts";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";

export interface LinuxInstallProvenancePolicy {
  readonly issuer: string;
  readonly predicateType: string;
  readonly repository: string;
  readonly runnerEnvironment: string;
  readonly signerWorkflow: string;
  readonly verifier: string;
}

/**
 * The single owner of the reviewed Linux release provenance policy. The verifier derives gh
 * arguments from it; extraction and the install transaction re-check verified provenance against
 * it. Receipt and journal validation deliberately stay with the transaction.
 */
export const LINUX_INSTALL_PROVENANCE_POLICY: LinuxInstallProvenancePolicy = Object.freeze({
  issuer: "https://token.actions.githubusercontent.com",
  predicateType: "https://slsa.dev/provenance/v1",
  repository: "yxflc11/openbot",
  runnerEnvironment: "github-hosted",
  signerWorkflow: "yxflc11/openbot/.github/workflows/node-linux-release.yml",
  verifier: "gh/2.93.0",
});

export function linuxProvenanceCertificateIdentity(version: string): string {
  return `https://github.com/${LINUX_INSTALL_PROVENANCE_POLICY.signerWorkflow}@refs/tags/node-v${version}`;
}

export interface VerifiedLinuxProvenance extends LinuxInstallProvenancePolicy {
  readonly schemaVersion: 1;
  readonly certificateIdentity: string;
  readonly sourceCommit: string;
  readonly sourceRef: string;
  readonly archiveSha256: string;
  readonly verifiedAt: string;
}

// The legacy validator accepts string-coercible digests. Keep that boundary honest in types;
// concrete verification below produces a string, and consumers still compare exact digest values.
type ValidatedLinuxProvenance = Omit<VerifiedLinuxProvenance, "archiveSha256"> & {
  readonly archiveSha256: unknown;
};

/** Release identity that verified provenance must be bound to (a manifest satisfies it). */
export interface LinuxProvenanceSubject {
  readonly sourceCommit: string;
  readonly version: string;
}

export function validateLinuxInstallProvenance(
  provenance: unknown,
  subject: LinuxProvenanceSubject,
): ValidatedLinuxProvenance {
  assertVerifiedLinuxProvenance(provenance, subject);
  return provenance;
}

function assertVerifiedLinuxProvenance(
  provenance: unknown,
  manifest: LinuxProvenanceSubject,
): asserts provenance is ValidatedLinuxProvenance {
  if (!isRecord(provenance) || provenance.schemaVersion !== 1) {
    throw new Error("Linux install provenance is missing or malformed.");
  }
  for (const [key, expected] of Object.entries(LINUX_INSTALL_PROVENANCE_POLICY)) {
    if (provenance[key] !== expected) {
      throw new Error(`Linux install provenance does not satisfy ${key} policy.`);
    }
  }
  if (provenance.sourceCommit !== manifest.sourceCommit) {
    throw new Error("Linux install provenance source commit does not match the manifest.");
  }
  if (provenance.sourceRef !== `refs/tags/node-v${manifest.version}`) {
    throw new Error("Linux install provenance source ref does not match the release version.");
  }
  if (provenance.certificateIdentity !== linuxProvenanceCertificateIdentity(manifest.version)) {
    throw new Error("Linux install provenance certificate identity does not match the release.");
  }
  // Template coercion keeps the original RegExp#test/Date.parse string conversion exactly.
  if (!/^[0-9a-f]{64}$/.test(`${provenance.archiveSha256 ?? ""}`)) {
    throw new Error("Linux install provenance archive digest is missing or malformed.");
  }
  const verifiedAt = Date.parse(`${provenance.verifiedAt}`);
  if (
    !Number.isFinite(verifiedAt) ||
    new Date(verifiedAt).toISOString() !== provenance.verifiedAt
  ) {
    throw new Error("Linux install provenance verification time is not canonical.");
  }
}

export interface BoundedCommandRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface BoundedCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** Injected runners are untrusted: every result is re-validated by its caller. */
export type BoundedCommandRunner = (request: BoundedCommandRequest) => Promise<unknown>;

export interface SuccessfulCommandResult {
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/**
 * Shared structural success check. Callers keep their own output bounds, empty-output rules, and
 * error messages because they sit at different trust boundaries.
 */
export function isSuccessfulCommandResult(value: unknown): value is SuccessfulCommandResult {
  return (
    isRecord(value) &&
    value.exitCode === 0 &&
    value.signal === null &&
    Buffer.isBuffer(value.stdout) &&
    Buffer.isBuffer(value.stderr)
  );
}

export interface LinuxReleaseProvenanceOptions {
  readonly archivePath: unknown;
  readonly commandRunner?: BoundedCommandRunner | undefined;
  readonly executable?: unknown;
  readonly githubToken?: unknown;
  readonly now?: (() => unknown) | undefined;
  readonly sourceCommit: unknown;
  readonly version: unknown;
}

export interface LinuxAttestationSubject {
  readonly archivePath: unknown;
  readonly sourceCommit: unknown;
  readonly version: unknown;
}

export const LINUX_PROVENANCE_VERIFIER = Object.freeze({
  executable: "/usr/bin/gh",
  version: "2.93.0",
  versionLine: "gh version 2.93.0 (2026-05-27)",
});

const maximumVersionOutputBytes = 4 * 1024;
const maximumVerificationOutputBytes = 2 * 1024 * 1024;
const versionDeadlineMs = 5_000;
const verificationDeadlineMs = 30_000;
const maximumCommandDeadlineMs = 60_000;

export function linuxAttestationVerifyArguments({
  archivePath,
  sourceCommit,
  version,
}: LinuxAttestationSubject): string[] {
  const releaseVersion = assertReleaseVersion(version);
  const commit = assertSourceCommit(sourceCommit);
  const archive = assertAbsoluteArchivePath(archivePath);
  const sourceRef = `refs/tags/node-v${releaseVersion}`;

  return [
    "attestation",
    "verify",
    archive,
    "--repo",
    LINUX_INSTALL_PROVENANCE_POLICY.repository,
    "--cert-identity",
    linuxProvenanceCertificateIdentity(releaseVersion),
    "--source-ref",
    sourceRef,
    "--source-digest",
    commit,
    "--predicate-type",
    LINUX_INSTALL_PROVENANCE_POLICY.predicateType,
    "--cert-oidc-issuer",
    LINUX_INSTALL_PROVENANCE_POLICY.issuer,
    "--deny-self-hosted-runners",
    "--digest-alg",
    "sha256",
    "--hostname",
    "github.com",
    "--format",
    "json",
    "--limit",
    "30",
  ];
}

/**
 * Verifies the archive before extraction. Repository, workflow, ref, commit, and runner policy are
 * command inputs enforced by gh, not authority derived from workflow-controlled predicate data.
 */
export async function verifyLinuxReleaseProvenance(
  options: LinuxReleaseProvenanceOptions,
): Promise<VerifiedLinuxProvenance> {
  if (!isRecord(options)) {
    throw new Error("Linux provenance verifier options are missing or malformed.");
  }
  const version = assertReleaseVersion(options.version);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  const archivePath = assertAbsoluteArchivePath(options.archivePath);
  const executable = options.executable ?? LINUX_PROVENANCE_VERIFIER.executable;
  if (typeof executable !== "string" || !path.isAbsolute(executable) || executable.includes("\0")) {
    throw new Error("Linux provenance verifier executable must be an absolute path.");
  }
  const runner = options.commandRunner ?? runBoundedCommand;
  if (typeof runner !== "function") {
    throw new Error("Linux provenance verifier requires a command runner.");
  }
  const now = options.now ?? (() => new Date());
  const environment = verifierEnvironment(options.githubToken);

  const metadata = await lstat(archivePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size < LINUX_RELEASE_ARCHIVE_BOUNDS.minimumBytes ||
    metadata.size > LINUX_RELEASE_ARCHIVE_BOUNDS.maximumBytes
  ) {
    throw new Error("Linux release archive is not a reviewed-size regular file.");
  }

  const archiveSha256 = await sha256File(archivePath);
  const versionResult = await invokeRunner(runner, {
    executable,
    arguments: ["--version"],
    environment,
    timeoutMs: versionDeadlineMs,
    maximumBytes: maximumVersionOutputBytes,
  });
  requireSuccessfulCommand(versionResult, maximumVersionOutputBytes);
  const versionOutput = versionResult.stdout.toString("utf8").split(/\r?\n/u);
  if (versionOutput[0] !== LINUX_PROVENANCE_VERIFIER.versionLine) {
    throw new Error("Linux provenance verifier version does not match the reviewed release.");
  }

  const verificationResult = await invokeRunner(runner, {
    executable,
    arguments: linuxAttestationVerifyArguments({ archivePath, sourceCommit, version }),
    environment,
    timeoutMs: verificationDeadlineMs,
    maximumBytes: maximumVerificationOutputBytes,
  });
  requireSuccessfulCommand(verificationResult, maximumVerificationOutputBytes);
  validateVerificationJson(verificationResult.stdout, archiveSha256);
  if ((await sha256File(archivePath)) !== archiveSha256) {
    throw new Error("Linux release archive changed during provenance verification.");
  }

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.valueOf())) {
    throw new Error("Linux provenance verifier clock returned an invalid time.");
  }
  const sourceRef = `refs/tags/node-v${version}`;
  return {
    schemaVersion: 1,
    ...LINUX_INSTALL_PROVENANCE_POLICY,
    certificateIdentity: linuxProvenanceCertificateIdentity(version),
    sourceCommit,
    sourceRef,
    archiveSha256,
    verifiedAt: verifiedAt.toISOString(),
  };
}

export async function runBoundedCommand(request: unknown): Promise<BoundedCommandResult> {
  assertCommandRequest(request);
  return await new Promise<BoundedCommandResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", fail);
      child?.kill("SIGKILL");
      reject(new Error("Linux provenance verifier command failed."));
    };
    const capture = (target: Buffer[], channel: "stdout" | "stderr", chunk: unknown) => {
      if (finished) return;
      if (!Buffer.isBuffer(chunk)) return fail();
      if (channel === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > request.maximumBytes || stderrBytes > request.maximumBytes) return fail();
      target.push(chunk);
    };

    try {
      child = spawn(request.executable, request.arguments, {
        env: request.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail();
      return;
    }

    timeout = setTimeout(fail, request.timeoutMs);
    request.signal?.addEventListener("abort", fail, { once: true });
    if (request.signal?.aborted) return fail();
    child.stdout.on("data", (chunk: unknown) => capture(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk: unknown) => capture(stderr, "stderr", chunk));
    child.once("error", fail);
    child.once("close", (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", fail);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });
  });
}

async function invokeRunner(
  runner: BoundedCommandRunner,
  request: BoundedCommandRequest,
): Promise<unknown> {
  try {
    return await runner(request);
  } catch {
    throw new Error("Linux provenance verifier command failed.");
  }
}

function requireSuccessfulCommand(
  result: unknown,
  maximumBytes: number,
): asserts result is SuccessfulCommandResult {
  if (
    !isSuccessfulCommandResult(result) ||
    result.stdout.length > maximumBytes ||
    result.stderr.length > maximumBytes
  ) {
    throw new Error("Linux provenance verifier command failed.");
  }
}

function validateVerificationJson(output: Buffer, archiveSha256: string): void {
  let results: unknown;
  try {
    results = JSON.parse(output.toString("utf8"));
  } catch {
    throw new Error("Linux provenance verifier returned malformed JSON.");
  }
  if (output.length === 0 || !isUnknownArray(results) || results.length !== 1) {
    throw new Error("Linux provenance verifier returned an ambiguous result.");
  }
  const result = results[0];
  const statement = property(property(result, "verificationResult"), "statement");
  if (!isRecord(property(result, "attestation")) || !isRecord(statement)) {
    throw new Error("Linux provenance verifier result is missing verified statement data.");
  }
  if (statement.predicateType !== LINUX_INSTALL_PROVENANCE_POLICY.predicateType) {
    throw new Error("Linux provenance verifier result has the wrong predicate type.");
  }
  if (!isUnknownArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error("Linux provenance verifier result has an ambiguous archive subject.");
  }
  if (property(property(statement.subject[0], "digest"), "sha256") !== archiveSha256) {
    throw new Error("Linux provenance verifier result does not match the archive digest.");
  }
}

function verifierEnvironment(githubToken: unknown): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GH_CONFIG_DIR: "/var/empty/openbot-gh",
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  if (githubToken === undefined) return environment;
  if (
    typeof githubToken !== "string" ||
    githubToken.length < 8 ||
    githubToken.length > 4_096 ||
    /[\0\r\n]/u.test(githubToken)
  ) {
    throw new Error("Linux provenance verifier token is malformed.");
  }
  return { ...environment, GH_TOKEN: githubToken };
}

/** Structural view used only to probe a caller-supplied signal; see assertCommandRequest. */
interface EventTargetLike {
  readonly addEventListener?: unknown;
  readonly aborted?: unknown;
  readonly removeEventListener?: unknown;
}

function assertCommandRequest(request: unknown): asserts request is BoundedCommandRequest {
  // Deliberately typed as non-null: a null signal must still hit native property access (and throw
  // a TypeError) exactly as the original unchecked `request.signal.addEventListener` did.
  const signal = isRecord(request) ? (request.signal as EventTargetLike) : undefined;
  if (
    !isRecord(request) ||
    typeof request.executable !== "string" ||
    !path.isAbsolute(request.executable) ||
    request.executable.includes("\0") ||
    !isUnknownArray(request.arguments) ||
    request.arguments.length > 64 ||
    request.arguments.some(
      (argument) =>
        typeof argument !== "string" || argument.length > 4_096 || argument.includes("\0"),
    ) ||
    !isRecord(request.environment) ||
    Object.entries(request.environment).length > 16 ||
    Object.entries(request.environment).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(key) ||
        typeof value !== "string" ||
        value.length > 4_096 ||
        value.includes("\0"),
    ) ||
    (signal !== undefined &&
      (typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function" ||
        typeof signal.aborted !== "boolean")) ||
    typeof request.timeoutMs !== "number" ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > maximumCommandDeadlineMs ||
    typeof request.maximumBytes !== "number" ||
    !Number.isSafeInteger(request.maximumBytes) ||
    request.maximumBytes < 1 ||
    request.maximumBytes > maximumVerificationOutputBytes
  ) {
    throw new Error("Linux provenance verifier command request is invalid.");
  }
}

function assertAbsoluteArchivePath(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("Linux release archive path must be absolute.");
  }
  return path.resolve(value);
}

/** Same observable result as optional chaining `value?.[key]` on an untrusted value. */
function property(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(Object(value), key);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
