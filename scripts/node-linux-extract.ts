import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  type BoundedCommandRequest,
  type BoundedCommandRunner,
  isSuccessfulCommandResult,
  runBoundedCommand,
  type SuccessfulCommandResult,
  validateLinuxInstallProvenance,
} from "./node-linux-provenance.ts";
import {
  LINUX_RELEASE_ARCHIVE_BOUNDS,
  type LinuxReleaseManifest,
  verifyCandidateDirectory,
} from "./node-linux-release.ts";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";

export interface LinuxArchiveInventoryEntry {
  readonly directory: boolean;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
}

export interface LinuxArchiveExtractionOptions {
  readonly architecture: unknown;
  readonly archivePath: unknown;
  readonly commandRunner?: BoundedCommandRunner | undefined;
  readonly sourceCommit: unknown;
  readonly stagingRoot: unknown;
  readonly verifiedProvenance: unknown;
  readonly version: unknown;
}

export interface ExtractedLinuxRelease {
  readonly candidate: string;
  readonly manifest: LinuxReleaseManifest;
  readonly archiveSha256: string;
}

export const LINUX_ARCHIVE_EXTRACTION_TOOLS = Object.freeze({
  gnuTar: "/usr/bin/tar",
  gnuTarVersionLine: "tar (GNU tar) 1.35",
  xz: "/usr/bin/xz",
  xzVersionLine: "xz (XZ Utils) 5.4.5",
});

const maximumEntryBytes = 160 * 1024 * 1024;
const maximumExpandedBytes = 256 * 1024 * 1024;
const maximumMembers = 300;
const maximumListingBytes = 256 * 1024;

export function linuxArchiveListArguments(archivePath: unknown): string[] {
  return [
    "--list",
    "--verbose",
    "--numeric-owner",
    "--quoting-style=escape",
    `--use-compress-program=${LINUX_ARCHIVE_EXTRACTION_TOOLS.xz}`,
    `--file=${assertAbsolutePath(archivePath, "archive")}`,
  ];
}

export function linuxArchiveExtractArguments(archivePath: unknown, stagingRoot: unknown): string[] {
  return [
    "--extract",
    `--directory=${assertAbsolutePath(stagingRoot, "staging")}`,
    `--use-compress-program=${LINUX_ARCHIVE_EXTRACTION_TOOLS.xz}`,
    `--file=${assertAbsolutePath(archivePath, "archive")}`,
    "--keep-old-files",
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
    "--no-acls",
    "--no-selinux",
    "--no-xattrs",
    "--restrict",
  ];
}

export function validateLinuxArchiveInventory(
  source: unknown,
  expectedRoot: string,
): LinuxArchiveInventoryEntry[] {
  if (
    typeof source !== "string" ||
    source.length < 1 ||
    !source.endsWith("\n") ||
    Buffer.byteLength(source) > maximumListingBytes ||
    !/^[0-9A-Za-z.+-]{1,128}$/u.test(expectedRoot)
  ) {
    throw new Error("Linux archive inventory is missing, oversized, or malformed.");
  }
  const lines = source.trimEnd().split("\n");
  if (lines.length < 2 || lines.length > maximumMembers) {
    throw new Error("Linux archive inventory has an unsafe member count.");
  }

  const entries: LinuxArchiveInventoryEntry[] = [];
  const paths = new Set<string>();
  let totalSize = 0;
  for (const line of lines) {
    const match =
      /^((?:d|-)r[w-][x-]r[w-][x-]r[w-][x-]) 0\/0 +([0-9]{1,12}) [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} ([0-9A-Za-z._+/-]{1,300})$/u.exec(
        line,
      );
    if (match === null) {
      throw new Error("Linux archive inventory contains an unsafe type, mode, owner, or path.");
    }
    const mode = match[1];
    const size = Number(match[2]);
    const listedPath = match[3];
    if (mode === undefined || listedPath === undefined) {
      throw new Error("Linux archive inventory contains an unsafe type, mode, owner, or path.");
    }
    const directory = mode.startsWith("d");
    if (directory !== listedPath.endsWith("/") || (!directory && listedPath.endsWith("/"))) {
      throw new Error("Linux archive inventory type and path disagree.");
    }
    if (
      (directory && mode !== "drwxr-xr-x") ||
      (!directory && mode !== "-rw-r--r--" && mode !== "-rwxr-xr-x")
    ) {
      throw new Error("Linux archive inventory contains an unapproved permission mode.");
    }
    const relativePath = directory ? listedPath.slice(0, -1) : listedPath;
    assertInventoryPath(relativePath, expectedRoot);
    if (paths.has(relativePath)) {
      throw new Error("Linux archive inventory contains a duplicate path.");
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumEntryBytes) {
      throw new Error("Linux archive inventory contains an oversized member.");
    }
    if (directory && size !== 0) {
      throw new Error("Linux archive directory has an unexpected payload size.");
    }
    if (!directory) {
      totalSize += size;
      if (totalSize > maximumExpandedBytes) {
        throw new Error("Linux archive inventory exceeds the expanded-size bound.");
      }
    }
    paths.add(relativePath);
    entries.push({ directory, mode, path: relativePath, size });
  }
  const rootEntry = entries[0];
  if (rootEntry === undefined || !rootEntry.directory || rootEntry.path !== expectedRoot) {
    throw new Error("Linux archive inventory does not start with the expected root.");
  }
  const sortedPaths = entries.map((entry) => entry.path).sort();
  if (JSON.stringify([...paths]) !== JSON.stringify(sortedPaths)) {
    throw new Error("Linux archive inventory paths are not canonical and sorted.");
  }
  return entries;
}

/**
 * Rootless extraction boundary. A future privileged wrapper must additionally prove root ownership
 * and serialize this operation with the install transaction before exposing it as a command.
 */
export async function extractVerifiedLinuxRelease(
  options: LinuxArchiveExtractionOptions,
): Promise<ExtractedLinuxRelease> {
  if (!isRecord(options)) throw new Error("Linux archive extraction options are malformed.");
  const version = assertReleaseVersion(options.version);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  const architecture: unknown = options.architecture;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error("Linux archive extraction architecture must be x64 or arm64.");
  }
  const archivePath = assertAbsolutePath(options.archivePath, "archive");
  const stagingRoot = assertAbsolutePath(options.stagingRoot, "staging");
  const runner = options.commandRunner ?? runBoundedCommand;
  if (typeof runner !== "function") throw new Error("Linux archive extraction requires a runner.");

  const [archiveMetadata, stagingMetadata] = await Promise.all([
    lstat(archivePath),
    lstat(stagingRoot),
  ]);
  if (
    archiveMetadata.isSymbolicLink() ||
    !archiveMetadata.isFile() ||
    archiveMetadata.size < LINUX_RELEASE_ARCHIVE_BOUNDS.minimumBytes ||
    archiveMetadata.size > LINUX_RELEASE_ARCHIVE_BOUNDS.maximumBytes
  ) {
    throw new Error("Linux release archive is not a reviewed-size regular file.");
  }
  if (
    stagingMetadata.isSymbolicLink() ||
    !stagingMetadata.isDirectory() ||
    (stagingMetadata.mode & 0o777) !== 0o700 ||
    (await readdir(stagingRoot)).length !== 0
  ) {
    throw new Error("Linux archive staging root must be a private empty directory.");
  }

  const expectedRoot = `openbot-node-${version}-linux-${architecture}-unsigned`;
  const candidate = path.join(stagingRoot, expectedRoot);
  const provenance = validateLinuxInstallProvenance(options.verifiedProvenance, {
    sourceCommit,
    version,
  });
  const initialDigest = await sha256File(archivePath);
  if (initialDigest !== provenance.archiveSha256) {
    throw new Error("Linux release archive digest does not match verified provenance.");
  }

  const environment: Readonly<Record<string, string>> = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  await requireToolVersion(
    runner,
    LINUX_ARCHIVE_EXTRACTION_TOOLS.gnuTar,
    LINUX_ARCHIVE_EXTRACTION_TOOLS.gnuTarVersionLine,
    environment,
  );
  await requireToolVersion(
    runner,
    LINUX_ARCHIVE_EXTRACTION_TOOLS.xz,
    LINUX_ARCHIVE_EXTRACTION_TOOLS.xzVersionLine,
    environment,
  );
  await runChecked(
    runner,
    {
      executable: LINUX_ARCHIVE_EXTRACTION_TOOLS.xz,
      arguments: ["--test", archivePath],
      environment,
      maximumBytes: 4 * 1024,
      timeoutMs: 30_000,
    },
    true,
  );
  const inventoryResult = await runChecked(runner, {
    executable: LINUX_ARCHIVE_EXTRACTION_TOOLS.gnuTar,
    arguments: linuxArchiveListArguments(archivePath),
    environment,
    maximumBytes: maximumListingBytes,
    timeoutMs: 30_000,
  });
  const inventory = validateLinuxArchiveInventory(
    inventoryResult.stdout.toString("utf8"),
    expectedRoot,
  );

  let extractionStarted = false;
  try {
    extractionStarted = true;
    await runChecked(
      runner,
      {
        executable: LINUX_ARCHIVE_EXTRACTION_TOOLS.gnuTar,
        arguments: linuxArchiveExtractArguments(archivePath, stagingRoot),
        environment,
        maximumBytes: 64 * 1024,
        timeoutMs: 60_000,
      },
      true,
    );
    if ((await sha256File(archivePath)) !== initialDigest) {
      throw new Error("Linux release archive changed during extraction.");
    }
    await verifyExtractedInventory(candidate, inventory);
    const manifest = await verifyCandidateDirectory(candidate);
    if (
      manifest.version !== version ||
      manifest.architecture !== architecture ||
      manifest.sourceCommit !== sourceCommit
    ) {
      throw new Error("Extracted Linux release identity does not match verified provenance.");
    }
    return { candidate, manifest, archiveSha256: initialDigest };
  } catch (error) {
    if (extractionStarted) await rm(candidate, { recursive: true, force: true });
    throw error;
  }
}

async function verifyExtractedInventory(
  candidate: string,
  expectedEntries: readonly LinuxArchiveInventoryEntry[],
): Promise<void> {
  const actual: LinuxArchiveInventoryEntry[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) {
        throw new Error("Extracted Linux release contains a symbolic link.");
      }
      if (metadata.isDirectory()) {
        actual.push({
          directory: true,
          mode: modeString(metadata.mode, true),
          path: childRelative,
          size: 0,
        });
        await visit(child, childRelative);
      } else if (metadata.isFile() && metadata.nlink === 1) {
        actual.push({
          directory: false,
          mode: modeString(metadata.mode, false),
          path: childRelative,
          size: metadata.size,
        });
      } else {
        throw new Error("Extracted Linux release contains a link or special file.");
      }
    }
  };

  const rootMetadata = await lstat(candidate);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Extracted Linux release root is missing or unsafe.");
  }
  actual.push({
    directory: true,
    mode: modeString(rootMetadata.mode, true),
    path: path.basename(candidate),
    size: 0,
  });
  await visit(candidate, path.basename(candidate));
  actual.sort((left, right) => left.path.localeCompare(right.path));
  const expected = [...expectedEntries].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Extracted Linux release does not match the preflight inventory.");
  }
}

async function requireToolVersion(
  runner: BoundedCommandRunner,
  executable: string,
  expectedLine: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await runChecked(runner, {
    executable,
    arguments: ["--version"],
    environment,
    maximumBytes: 4 * 1024,
    timeoutMs: 5_000,
  });
  if (result.stdout.toString("utf8").split(/\r?\n/u)[0] !== expectedLine) {
    throw new Error("Linux archive extraction tool version is not the reviewed release.");
  }
}

async function runChecked(
  runner: BoundedCommandRunner,
  request: BoundedCommandRequest,
  requireEmptyOutput = false,
): Promise<SuccessfulCommandResult> {
  let result: unknown;
  try {
    result = await runner(request);
  } catch {
    throw new Error("Linux archive extraction command failed.");
  }
  if (
    !isSuccessfulCommandResult(result) ||
    result.stdout.length > request.maximumBytes ||
    result.stderr.length > request.maximumBytes ||
    result.stderr.length !== 0 ||
    (requireEmptyOutput && result.stdout.length !== 0)
  ) {
    throw new Error("Linux archive extraction command failed.");
  }
  return result;
}

function assertInventoryPath(value: string, expectedRoot: string): void {
  if (
    (value !== expectedRoot && !value.startsWith(`${expectedRoot}/`)) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Linux archive inventory contains an escaping path.");
  }
}

function modeString(mode: number, directory: boolean): string {
  const permissions = mode & 0o777;
  if (directory && permissions === 0o755) return "drwxr-xr-x";
  if (!directory && permissions === 0o644) return "-rw-r--r--";
  if (!directory && permissions === 0o755) return "-rwxr-xr-x";
  return `unsafe:${permissions.toString(8)}`;
}

function assertAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Linux archive ${name} path must be absolute.`);
  }
  return path.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
