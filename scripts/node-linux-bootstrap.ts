import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type ImportedLinuxReleaseArchive,
  type ImportedLinuxReleaseArchiveCleanup,
  importLinuxReleaseArchive,
  LINUX_ARCHIVE_IMPORT_BOUNDS,
  type LinuxArchiveImportOptions,
  removeImportedLinuxReleaseArchive,
} from "./node-linux-archive-import.ts";
import {
  extractVerifiedLinuxRelease,
  type LinuxArchiveExtractionOptions,
} from "./node-linux-extract.ts";
import {
  type LinuxInstallLease,
  type LinuxInstallLeaseOptions,
  withLinuxInstallLease,
} from "./node-linux-install-lease.ts";
import {
  installStagedLinuxRelease,
  type LinuxInstallRecoveryResult,
  type LinuxStagedInstallOptions,
  recoverLinuxInstallTransaction,
} from "./node-linux-install-transaction.ts";
import {
  type LinuxPrivilegedInstallLayout,
  prepareLinuxPrivilegedInstallerLayout,
} from "./node-linux-privileged-layout.ts";
import {
  type LinuxReleaseProvenanceOptions,
  verifyLinuxReleaseProvenance,
} from "./node-linux-provenance.ts";
import { createLinuxSystemdServiceAdapter } from "./node-linux-systemd.ts";
import { assertReleaseVersion, assertSourceCommit } from "./release-source.ts";

/** Operator-facing install request; every field is validated before any privileged step uses it. */
export interface LinuxPrivilegedInstallOptions {
  readonly architecture: unknown;
  readonly archivePath: unknown;
  readonly githubToken?: unknown;
  readonly importId: unknown;
  readonly now?: (() => unknown) | undefined;
  readonly serviceDeadlineMs?: unknown;
  readonly sourceCommit: unknown;
  readonly transactionId: unknown;
  readonly version: unknown;
}

export interface LinuxReleaseInstallCompositionOptions extends LinuxPrivilegedInstallOptions {
  readonly layout: unknown;
}

export interface LinuxPrivilegedRecoveryOptions {
  readonly now?: (() => unknown) | undefined;
  readonly recoveryId?: unknown;
  readonly serviceDeadlineMs?: unknown;
}

/** Stage adapters; results are untrusted and re-validated by the composition core. */
export interface LinuxReleaseInstallAdapters {
  readonly extractArchive: (request: LinuxArchiveExtractionOptions) => Promise<unknown>;
  readonly importArchive: (request: LinuxArchiveImportOptions) => Promise<unknown>;
  readonly installRelease: (request: LinuxStagedInstallOptions) => Promise<unknown>;
  readonly removeImportedArchive: (request: ImportedLinuxReleaseArchiveCleanup) => Promise<unknown>;
  readonly service: unknown;
  readonly verifyProvenance: (request: LinuxReleaseProvenanceOptions) => Promise<unknown>;
  readonly withLease: (
    options: LinuxInstallLeaseOptions,
    operation: (installLease: LinuxInstallLease) => Promise<unknown>,
  ) => Promise<unknown>;
}

type ValidatedImportedArchive = Omit<ImportedLinuxReleaseArchive, "archiveSha256"> & {
  readonly archiveSha256: unknown;
};

interface ExtractedCandidateResult {
  readonly archiveSha256: unknown;
  readonly candidate: string;
  readonly manifest: Record<string, unknown>;
}

interface ExpectedReleaseIdentity {
  readonly architecture: string;
  readonly sourceCommit: string;
  readonly version: string;
}

const layoutKeys: readonly (keyof LinuxPrivilegedInstallLayout)[] = Object.freeze([
  "importsRoot",
  "installRoot",
  "stagingRoot",
  "stateRoot",
  "versionsRoot",
]);

/**
 * Dormant privileged entry point. Distribution remains disabled until the separately trusted
 * bootstrap channel and native-host evidence are approved.
 */
export async function installPrivilegedLinuxRelease(
  options: LinuxPrivilegedInstallOptions,
): Promise<unknown> {
  if (!isRecord(options)) throw new Error("Linux privileged install options are malformed.");
  const layout = await prepareLinuxPrivilegedInstallerLayout();
  return await composeLinuxReleaseInstall(
    { ...options, layout },
    {
      extractArchive: extractVerifiedLinuxRelease,
      importArchive: importLinuxReleaseArchive,
      installRelease: installStagedLinuxRelease,
      removeImportedArchive: removeImportedLinuxReleaseArchive,
      service: createLinuxSystemdServiceAdapter(),
      verifyProvenance: verifyLinuxReleaseProvenance,
      withLease: withLinuxInstallLease,
    },
  );
}

export async function recoverPrivilegedLinuxInstall(
  options: LinuxPrivilegedRecoveryOptions = {},
): Promise<LinuxInstallRecoveryResult> {
  if (!isRecord(options)) throw new Error("Linux privileged recovery options are malformed.");
  const layout = await prepareLinuxPrivilegedInstallerLayout();
  const service = createLinuxSystemdServiceAdapter();
  return await withLinuxInstallLease({ stateRoot: layout.stateRoot }, async (installLease) =>
    recoverLinuxInstallTransaction({
      installLease,
      installRoot: layout.installRoot,
      now: options.now,
      recoveryId: options.recoveryId,
      service,
      serviceDeadlineMs: options.serviceDeadlineMs,
      stateRoot: layout.stateRoot,
    }),
  );
}

/**
 * Deterministic composition core for policy tests. Only the wrapper above supplies privileged
 * authority: it fixes the real layout and concrete verifier, extractor, service, and transaction.
 */
export async function composeLinuxReleaseInstall(
  options: LinuxReleaseInstallCompositionOptions,
  adapters: LinuxReleaseInstallAdapters,
): Promise<unknown> {
  if (!isRecord(options) || !isRecord(adapters)) {
    throw new Error("Linux bootstrap composition options are malformed.");
  }
  const layout = validateCompositionLayout(options.layout);
  const version = assertReleaseVersion(options.version);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  const architecture: unknown = options.architecture;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("Linux bootstrap architecture must be x64 or arm64.");
  }
  const archivePath = assertAbsoluteInput(options.archivePath, "archive");
  const importId = assertOperationId(options.importId, "import");
  const transactionId = assertOperationId(options.transactionId, "transaction");
  for (const name of [
    "extractArchive",
    "importArchive",
    "installRelease",
    "removeImportedArchive",
    "verifyProvenance",
    "withLease",
  ] as const) {
    if (typeof adapters[name] !== "function") {
      throw new Error(`Linux bootstrap composition adapter is missing: ${name}`);
    }
  }
  if (!isRecord(adapters.service)) {
    throw new Error("Linux bootstrap composition service adapter is missing.");
  }

  return await adapters.withLease({ stateRoot: layout.stateRoot }, async (installLease) => {
    await assertInstallWorkspaceReady(layout);
    const imported = await adapters.importArchive({
      importId,
      installLease,
      sourcePath: archivePath,
      stateRoot: layout.stateRoot,
    });
    validateImportedResult(imported, layout, importId);

    const provenance = await adapters.verifyProvenance({
      archivePath: imported.archivePath,
      githubToken: options.githubToken,
      now: options.now,
      sourceCommit,
      version,
    });
    if (property(provenance, "archiveSha256") !== imported.archiveSha256) {
      throw new Error("Linux bootstrap provenance does not match the private imported archive.");
    }

    const extracted = await adapters.extractArchive({
      architecture,
      archivePath: imported.archivePath,
      sourceCommit,
      stagingRoot: layout.stagingRoot,
      verifiedProvenance: provenance,
      version,
    });
    validateExtractedResult(extracted, imported, layout, { architecture, sourceCommit, version });

    const installed = await adapters.installRelease({
      architecture,
      candidate: extracted.candidate,
      installLease,
      installRoot: layout.installRoot,
      now: options.now,
      service: adapters.service,
      serviceDeadlineMs: options.serviceDeadlineMs,
      stateRoot: layout.stateRoot,
      transactionId,
      verifiedProvenance: provenance,
    });
    await adapters.removeImportedArchive({
      archivePath: imported.archivePath,
      archiveSha256: imported.archiveSha256,
      installLease,
      stateRoot: layout.stateRoot,
    });
    return installed;
  });
}

async function assertInstallWorkspaceReady(layout: LinuxPrivilegedInstallLayout): Promise<void> {
  const [stagingEntries, importEntries, journalExists] = await Promise.all([
    readdir(layout.stagingRoot),
    readdir(layout.importsRoot),
    pathExists(path.join(layout.stateRoot, "transaction.json")),
  ]);
  if (journalExists) {
    throw new Error("Linux bootstrap requires explicit recovery before installation.");
  }
  if (stagingEntries.length !== 0 || importEntries.length !== 0) {
    throw new Error("Linux bootstrap requires empty staging and private import roots.");
  }
}

function validateImportedResult(
  imported: unknown,
  layout: LinuxPrivilegedInstallLayout,
  importId: string,
): asserts imported is ValidatedImportedArchive {
  const expectedPath = path.join(layout.importsRoot, `openbot-node-import-${importId}.tar.xz`);
  if (
    !isRecord(imported) ||
    imported.archivePath !== expectedPath ||
    // Template coercion keeps the original RegExp#test string conversion exactly.
    !/^[0-9a-f]{64}$/u.test(`${imported.archiveSha256 ?? ""}`) ||
    typeof imported.size !== "number" ||
    !Number.isSafeInteger(imported.size) ||
    imported.size < LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes ||
    imported.size > LINUX_ARCHIVE_IMPORT_BOUNDS.maximumBytes
  ) {
    throw new Error("Linux bootstrap importer returned an invalid private archive.");
  }
}

function validateExtractedResult(
  extracted: unknown,
  imported: ValidatedImportedArchive,
  layout: LinuxPrivilegedInstallLayout,
  options: ExpectedReleaseIdentity,
): asserts extracted is ExtractedCandidateResult {
  const expectedCandidate = path.join(
    layout.stagingRoot,
    `openbot-node-${options.version}-linux-${options.architecture}-unsigned`,
  );
  if (
    !isRecord(extracted) ||
    extracted.candidate !== expectedCandidate ||
    extracted.archiveSha256 !== imported.archiveSha256 ||
    !isRecord(extracted.manifest) ||
    extracted.manifest.version !== options.version ||
    extracted.manifest.architecture !== options.architecture ||
    extracted.manifest.sourceCommit !== options.sourceCommit
  ) {
    throw new Error("Linux bootstrap extractor returned an invalid candidate.");
  }
}

function validateCompositionLayout(layout: unknown): LinuxPrivilegedInstallLayout {
  if (
    !isRecord(layout) ||
    JSON.stringify(Object.keys(layout).sort()) !== JSON.stringify([...layoutKeys].sort())
  ) {
    throw new Error("Linux bootstrap composition layout is malformed.");
  }
  assertCompositionLayoutShape(layout);
  if (
    path.dirname(layout.stagingRoot) !== layout.installRoot ||
    path.dirname(layout.versionsRoot) !== layout.installRoot ||
    path.dirname(layout.importsRoot) !== layout.stateRoot ||
    layout.installRoot === layout.stateRoot
  ) {
    throw new Error("Linux bootstrap composition layout relationships are invalid.");
  }
  return layout;
}

/** Validate values once, after the caller has checked the exact layout keys. */
function assertCompositionLayoutShape(
  layout: Record<string, unknown>,
): asserts layout is Record<string, unknown> & LinuxPrivilegedInstallLayout {
  for (const value of Object.values(layout)) {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      path.resolve(value) !== value ||
      value.includes("\0")
    ) {
      throw new Error("Linux bootstrap composition layout must use absolute paths.");
    }
  }
}

function assertAbsoluteInput(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    throw new Error(`Linux bootstrap ${name} path must be canonical and absolute.`);
  }
  return value;
}

function assertOperationId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new Error(`Linux bootstrap ${name} id must be a lowercase UUID.`);
  }
  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (property(error, "code") === "ENOENT") return false;
    throw error;
  }
}

/** Same observable result as optional chaining `value?.[key]` on an untrusted value. */
function property(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(Object(value), key);
}

/** Generic so that narrowing a typed options object keeps its declared optional members. */
function isRecord<T>(value: T): value is T & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
