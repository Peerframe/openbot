import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  LINUX_INSTALL_PROVENANCE_POLICY,
  linuxProvenanceCertificateIdentity,
} from "./node-linux-install-transaction.mjs";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";
import { LINUX_RELEASE_ARCHIVE_BOUNDS } from "./node-linux-release.ts";

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

export function linuxAttestationVerifyArguments({ archivePath, sourceCommit, version }) {
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
export async function verifyLinuxReleaseProvenance(options) {
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

export async function runBoundedCommand(request) {
  assertCommandRequest(request);
  return await new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let timeout;
    const stdout = [];
    const stderr = [];
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
    const capture = (target, channel, chunk) => {
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
    child.stdout.on("data", (chunk) => capture(stdout, "stdout", chunk));
    child.stderr.on("data", (chunk) => capture(stderr, "stderr", chunk));
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

async function invokeRunner(runner, request) {
  try {
    return await runner(request);
  } catch {
    throw new Error("Linux provenance verifier command failed.");
  }
}

function requireSuccessfulCommand(result, maximumBytes) {
  if (
    !isRecord(result) ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr) ||
    result.stdout.length > maximumBytes ||
    result.stderr.length > maximumBytes
  ) {
    throw new Error("Linux provenance verifier command failed.");
  }
}

function validateVerificationJson(output, archiveSha256) {
  let results;
  try {
    results = JSON.parse(output.toString("utf8"));
  } catch {
    throw new Error("Linux provenance verifier returned malformed JSON.");
  }
  if (output.length === 0 || !Array.isArray(results) || results.length !== 1) {
    throw new Error("Linux provenance verifier returned an ambiguous result.");
  }
  const result = results[0];
  const statement = result?.verificationResult?.statement;
  if (!isRecord(result?.attestation) || !isRecord(statement)) {
    throw new Error("Linux provenance verifier result is missing verified statement data.");
  }
  if (statement.predicateType !== LINUX_INSTALL_PROVENANCE_POLICY.predicateType) {
    throw new Error("Linux provenance verifier result has the wrong predicate type.");
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error("Linux provenance verifier result has an ambiguous archive subject.");
  }
  if (statement.subject[0]?.digest?.sha256 !== archiveSha256) {
    throw new Error("Linux provenance verifier result does not match the archive digest.");
  }
}

function verifierEnvironment(githubToken) {
  const environment = {
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

function assertCommandRequest(request) {
  if (
    !isRecord(request) ||
    typeof request.executable !== "string" ||
    !path.isAbsolute(request.executable) ||
    request.executable.includes("\0") ||
    !Array.isArray(request.arguments) ||
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
    (request.signal !== undefined &&
      (typeof request.signal.addEventListener !== "function" ||
        typeof request.signal.removeEventListener !== "function" ||
        typeof request.signal.aborted !== "boolean")) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > maximumCommandDeadlineMs ||
    !Number.isSafeInteger(request.maximumBytes) ||
    request.maximumBytes < 1 ||
    request.maximumBytes > maximumVerificationOutputBytes
  ) {
    throw new Error("Linux provenance verifier command request is invalid.");
  }
}

function assertAbsoluteArchivePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("Linux release archive path must be absolute.");
  }
  return path.resolve(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
