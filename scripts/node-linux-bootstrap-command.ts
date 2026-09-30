import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  installPrivilegedLinuxRelease,
  type LinuxPrivilegedInstallOptions,
  type LinuxPrivilegedRecoveryOptions,
  recoverPrivilegedLinuxInstall,
} from "./node-linux-bootstrap.ts";
import { assertReleaseVersion, assertSourceCommit } from "./release-source.ts";

export interface LinuxBootstrapCommandAdapters {
  readonly generateId: () => unknown;
  readonly install: (request: LinuxPrivilegedInstallOptions) => Promise<unknown>;
  readonly recover: (request: LinuxPrivilegedRecoveryOptions) => Promise<unknown>;
}

/** Raw operator input; every field is validated before any adapter runs. */
export interface LinuxBootstrapCommandRequest {
  readonly arguments: unknown;
  readonly environment: unknown;
  readonly runtime: unknown;
}

export interface LinuxBootstrapCliRequest extends LinuxBootstrapCommandRequest {
  readonly writeError: (value: string) => unknown;
  readonly writeOutput: (value: string) => unknown;
}

export type LinuxBootstrapCommand =
  | { readonly operation: "recover" }
  | {
      readonly archivePath: string;
      readonly operation: "install";
      readonly sourceCommit: string;
      readonly version: string;
    };

interface ValidatedCommandRequest {
  readonly arguments: string[];
  readonly environment: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
}

interface ExpectedInstallIdentity {
  readonly sourceCommit: string;
  readonly version: string;
}

const genericFailure = Object.freeze({ error: "bootstrap-failed", ok: false });
const maximumArgumentCount = 8;
const maximumArgumentLength = 4_096;
const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const installedReleasePattern =
  /^openbot-node-([0-9A-Za-z.+-]{1,64})-linux-(x64|arm64)-([0-9a-f]{40})$/u;

const privilegedAdapters: LinuxBootstrapCommandAdapters = Object.freeze({
  generateId: randomUUID,
  install: installPrivilegedLinuxRelease,
  recover: recoverPrivilegedLinuxInstall,
});

/**
 * Strict operator surface for a separately trusted bootstrap. Tests inject adapters, but the thin
 * executable supplies only the fixed privileged install and recovery functions below.
 */
export async function executeLinuxBootstrapCommand(
  request: LinuxBootstrapCommandRequest,
  adapters: LinuxBootstrapCommandAdapters = privilegedAdapters,
): Promise<Readonly<Record<string, unknown>>> {
  validateCommandRequest(request);
  validateCommandAdapters(adapters);
  const command = parseLinuxBootstrapArguments(request.arguments);
  const architecture = validateCommandRuntime(request.runtime);

  if (command.operation === "install") {
    const githubToken = readGitHubToken(request.environment);
    const importId = generateOperationId(adapters);
    const transactionId = generateOperationId(adapters);
    const result = await adapters.install({
      architecture,
      archivePath: command.archivePath,
      githubToken,
      importId,
      sourceCommit: command.sourceCommit,
      transactionId,
      version: command.version,
    });
    return allowlistedInstallResult(result, command, architecture);
  }

  const result = await adapters.recover({ recoveryId: generateOperationId(adapters) });
  return allowlistedRecoveryResult(result);
}

export async function runPrivilegedLinuxBootstrapCli(
  request: LinuxBootstrapCliRequest,
  adapters: LinuxBootstrapCommandAdapters = privilegedAdapters,
): Promise<number> {
  if (
    !isRecord(request) ||
    typeof request.writeOutput !== "function" ||
    typeof request.writeError !== "function"
  ) {
    throw new Error("Linux bootstrap CLI output adapters are malformed.");
  }
  try {
    const result = await executeLinuxBootstrapCommand(request, adapters);
    request.writeOutput(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    request.writeError(`${JSON.stringify(genericFailure)}\n`);
    return 1;
  }
}

export function parseLinuxBootstrapArguments(arguments_: unknown): LinuxBootstrapCommand {
  validateArguments(arguments_);
  const parsed = parseArgs({
    allowNegative: false,
    allowPositionals: true,
    args: arguments_,
    options: {
      archive: { type: "string" },
      "source-commit": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
    tokens: true,
  });
  if (
    parsed.tokens.some((token) => token.kind === "option-terminator") ||
    parsed.positionals.length !== 1
  ) {
    throw new Error("Linux bootstrap command must select exactly one operation.");
  }

  const operation = parsed.positionals[0];
  if (operation === "recover") {
    if (Object.keys(parsed.values).length !== 0) {
      throw new Error("Linux bootstrap recovery does not accept install options.");
    }
    return Object.freeze({ operation });
  }
  if (operation !== "install") {
    throw new Error("Linux bootstrap command operation is invalid.");
  }

  const required = ["archive", "source-commit", "version"];
  if (
    JSON.stringify(Object.keys(parsed.values).sort()) !== JSON.stringify([...required].sort()) ||
    required.some(
      (name) =>
        parsed.tokens.filter((token) => token.kind === "option" && token.name === name).length !==
        1,
    )
  ) {
    throw new Error("Linux bootstrap install options are missing or duplicated.");
  }
  const archivePath = parsed.values.archive;
  if (
    typeof archivePath !== "string" ||
    !path.isAbsolute(archivePath) ||
    path.resolve(archivePath) !== archivePath
  ) {
    throw new Error("Linux bootstrap archive path must be canonical and absolute.");
  }
  return Object.freeze({
    archivePath,
    operation,
    sourceCommit: assertSourceCommit(parsed.values["source-commit"]),
    version: assertReleaseVersion(parsed.values.version),
  });
}

function validateCommandRequest(
  request: LinuxBootstrapCommandRequest,
): asserts request is LinuxBootstrapCommandRequest & ValidatedCommandRequest {
  if (!isRecord(request) || !isRecord(request.environment) || !isRecord(request.runtime)) {
    throw new Error("Linux bootstrap command request is malformed.");
  }
  validateArguments(request.arguments);
}

function validateArguments(arguments_: unknown): asserts arguments_ is string[] {
  if (
    !isUnknownArray(arguments_) ||
    arguments_.length < 1 ||
    arguments_.length > maximumArgumentCount ||
    arguments_.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > maximumArgumentLength ||
        argument.includes("\0"),
    )
  ) {
    throw new Error("Linux bootstrap command arguments are malformed.");
  }
}

function validateCommandAdapters(adapters: LinuxBootstrapCommandAdapters): void {
  if (
    !isRecord(adapters) ||
    typeof adapters.generateId !== "function" ||
    typeof adapters.install !== "function" ||
    typeof adapters.recover !== "function"
  ) {
    throw new Error("Linux bootstrap command adapters are malformed.");
  }
}

function validateCommandRuntime(runtime: Record<string, unknown>): "x64" | "arm64" {
  if (
    runtime.platform !== "linux" ||
    (runtime.architecture !== "x64" && runtime.architecture !== "arm64")
  ) {
    throw new Error("Linux bootstrap command requires a supported native Linux architecture.");
  }
  return runtime.architecture;
}

function readGitHubToken(environment: Record<string, unknown>): string | undefined {
  const token = environment.GH_TOKEN;
  if (token === undefined) return undefined;
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > maximumArgumentLength ||
    /[\0\r\n]/u.test(token)
  ) {
    throw new Error("Linux bootstrap GitHub token is malformed.");
  }
  return token;
}

function generateOperationId(adapters: LinuxBootstrapCommandAdapters): string {
  const value = adapters.generateId();
  if (typeof value !== "string" || !operationIdPattern.test(value)) {
    throw new Error("Linux bootstrap generated an invalid operation id.");
  }
  return value;
}

function allowlistedInstallResult(
  result: unknown,
  command: ExpectedInstallIdentity,
  architecture: string,
): Readonly<Record<string, unknown>> {
  const expectedRelease = `openbot-node-${command.version}-linux-${architecture}-${command.sourceCommit}`;
  if (
    !isRecord(result) ||
    result.releaseName !== expectedRelease ||
    typeof result.alreadyInstalled !== "boolean" ||
    typeof result.restarted !== "boolean" ||
    result.rolledBack !== false
  ) {
    throw new Error("Linux bootstrap install returned an invalid result.");
  }
  return Object.freeze({
    alreadyInstalled: result.alreadyInstalled,
    ok: true,
    operation: "install",
    releaseName: result.releaseName,
    restarted: result.restarted,
  });
}

function allowlistedRecoveryResult(result: unknown): Readonly<Record<string, unknown>> {
  if (
    !isRecord(result) ||
    (result.outcome !== "recovered-before-switch" && result.outcome !== "recovered-previous") ||
    typeof result.restarted !== "boolean" ||
    !isInstalledReleaseName(result.releaseName)
  ) {
    throw new Error("Linux bootstrap recovery returned an invalid result.");
  }
  return Object.freeze({
    ok: true,
    operation: "recover",
    outcome: result.outcome,
    releaseName: result.releaseName,
    restarted: result.restarted,
  });
}

function isInstalledReleaseName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = installedReleasePattern.exec(value);
  if (match === null) return false;
  try {
    assertReleaseVersion(match[1]);
    assertSourceCommit(match[3]);
    return true;
  } catch {
    return false;
  }
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
