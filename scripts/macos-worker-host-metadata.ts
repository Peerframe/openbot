import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";

/**
 * Owner of the macOS Worker Host metadata files: exact manifest/build schemas, the single
 * critical-file record collector shared by staging and sealing, and exact-byte JSON writes
 * (`JSON.stringify(value, null, 2)` plus one trailing newline).
 */
export type MacOSArchitecture = "arm64" | "x64";
export type MacOSCriticalFileMode = "0755" | "0644";

export interface MacOSCriticalFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: MacOSCriticalFileMode;
}

export interface MacOSRuntimeManifest {
  readonly format: "openbot.macos-worker-host-manifest/v1";
  readonly version: string;
  readonly sourceCommit: string;
  readonly architecture: MacOSArchitecture;
  readonly files: readonly MacOSCriticalFileRecord[];
}

export interface MacOSBuildMetadata {
  readonly format: "openbot.macos-worker-host-build/v1";
  readonly version: string;
  readonly buildVersion: string;
  readonly sourceCommit: string;
  readonly architecture: MacOSArchitecture;
  readonly nodeVersion: "22.22.2";
  readonly signed: boolean;
}

export interface MacOSInitialMetadataInput {
  readonly version: string;
  readonly buildVersion: string;
  readonly sourceCommit: string;
  readonly architecture: MacOSArchitecture;
}

export const MACOS_CRITICAL_FILES: readonly string[] = Object.freeze([
  "Contents/Resources/node/app/index.js",
  "Contents/Resources/node/bin/node",
]);

const MANIFEST_RELATIVE_PATH = "Contents/Resources/manifest.json";
const BUILD_RELATIVE_PATH = "Contents/Resources/build.json";
const MANIFEST_KEYS: readonly string[] = Object.freeze([
  "architecture",
  "files",
  "format",
  "sourceCommit",
  "version",
]);
const RECORD_KEYS: readonly string[] = Object.freeze(["mode", "path", "sha256", "size"]);
const BUILD_KEYS: readonly string[] = Object.freeze([
  "architecture",
  "buildVersion",
  "format",
  "nodeVersion",
  "signed",
  "sourceCommit",
  "version",
]);

export function assertMacOSArchitecture(value: unknown): MacOSArchitecture {
  if (value !== "arm64" && value !== "x64") {
    throw new Error("macOS architecture must be arm64 or x64.");
  }
  return value;
}

export function assertMacOSBuildVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error("macOS package build version must be a positive bounded integer.");
  }
  return value;
}

function assertMacOSRuntimeManifest(value: unknown): asserts value is MacOSRuntimeManifest {
  const files = field(value, "files");
  if (
    !isRecord(value) ||
    value.format !== "openbot.macos-worker-host-manifest/v1" ||
    !hasExactKeys(value, MANIFEST_KEYS) ||
    assertReleaseVersion(value.version) !== value.version ||
    assertSourceCommit(value.sourceCommit) !== value.sourceCommit ||
    assertMacOSArchitecture(value.architecture) !== value.architecture ||
    !isUnknownArray(files) ||
    JSON.stringify(files.map((record) => field(record, "path"))) !==
      JSON.stringify(MACOS_CRITICAL_FILES)
  ) {
    throw new Error("macOS application runtime manifest is invalid.");
  }
  for (const record of files) {
    const recordPath = field(record, "path");
    if (!isRecord(record) || typeof recordPath !== "string") {
      throw new Error("macOS application runtime manifest is invalid.");
    }
    const executable = recordPath.endsWith("/node");
    if (
      !hasExactKeys(record, RECORD_KEYS) ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.size !== "number" ||
      !Number.isSafeInteger(record.size) ||
      record.size < 1 ||
      record.size > (executable ? 128 * 1024 * 1024 : 16 * 1024 * 1024) ||
      record.mode !== (executable ? "0755" : "0644")
    ) {
      throw new Error("macOS application runtime manifest is invalid.");
    }
  }
}

function assertMacOSBuildMetadata(value: unknown): asserts value is MacOSBuildMetadata {
  if (
    !isRecord(value) ||
    value.format !== "openbot.macos-worker-host-build/v1" ||
    !hasExactKeys(value, BUILD_KEYS) ||
    assertReleaseVersion(value.version) !== value.version ||
    assertMacOSBuildVersion(value.buildVersion) !== value.buildVersion ||
    assertSourceCommit(value.sourceCommit) !== value.sourceCommit ||
    assertMacOSArchitecture(value.architecture) !== value.architecture ||
    value.nodeVersion !== "22.22.2" ||
    typeof value.signed !== "boolean"
  ) {
    throw new Error("macOS application build metadata is invalid.");
  }
}

/** The only producer of critical-file records, for both unsigned staging and post-sign sealing. */
async function collectMacOSCriticalFileRecords(root: string): Promise<MacOSCriticalFileRecord[]> {
  const records: MacOSCriticalFileRecord[] = [];
  for (const relativePath of MACOS_CRITICAL_FILES) {
    const filePath = path.join(root, relativePath);
    const metadata = await stat(filePath);
    records.push({
      path: relativePath,
      sha256: await sha256File(filePath),
      size: metadata.size,
      mode: relativePath.endsWith("/node") ? "0755" : "0644",
    });
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function writeMacOSInitialMetadata(
  root: string,
  { version, buildVersion, sourceCommit, architecture }: MacOSInitialMetadataInput,
): Promise<void> {
  const manifest: MacOSRuntimeManifest = {
    format: "openbot.macos-worker-host-manifest/v1",
    version,
    sourceCommit,
    architecture,
    files: await collectMacOSCriticalFileRecords(root),
  };
  await writeMacOSJsonExclusive(path.join(root, MANIFEST_RELATIVE_PATH), manifest);
  const build: MacOSBuildMetadata = {
    format: "openbot.macos-worker-host-build/v1",
    version,
    buildVersion,
    sourceCommit,
    architecture,
    nodeVersion: "22.22.2",
    signed: false,
  };
  await writeMacOSJsonExclusive(path.join(root, BUILD_RELATIVE_PATH), build);
}

export async function readMacOSRuntimeManifest(root: string): Promise<MacOSRuntimeManifest> {
  const manifest: unknown = JSON.parse(
    await readFile(path.join(root, MANIFEST_RELATIVE_PATH), "utf8"),
  );
  assertMacOSRuntimeManifest(manifest);
  return manifest;
}

export async function readMacOSBuildMetadata(root: string): Promise<MacOSBuildMetadata> {
  const build: unknown = JSON.parse(await readFile(path.join(root, BUILD_RELATIVE_PATH), "utf8"));
  assertMacOSBuildMetadata(build);
  return build;
}

export async function sealMacOSWorkerHostApplicationMetadata(
  applicationPath: string,
): Promise<void> {
  const root = path.resolve(applicationPath);
  const manifestPath = path.join(root, MANIFEST_RELATIVE_PATH);
  const manifest = await readMacOSRuntimeManifest(root);
  const files = await collectMacOSCriticalFileRecords(root);
  await replaceMacOSJsonFile(manifestPath, { ...manifest, files });

  const buildPath = path.join(root, BUILD_RELATIVE_PATH);
  const build = await readMacOSBuildMetadata(root);
  await replaceMacOSJsonFile(buildPath, { ...build, signed: true });
}

export async function writeMacOSFileExclusive(destination: string, source: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, source, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

async function writeMacOSJsonExclusive(destination: string, value: unknown): Promise<void> {
  await writeMacOSFileExclusive(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function replaceMacOSJsonFile(destination: string, value: unknown): Promise<void> {
  const metadata = await lstat(destination);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o644
  ) {
    throw new Error("macOS metadata file is outside the reviewed boundary.");
  }
  const replacement = `${destination}.next`;
  await assertMacOSPathAbsent(replacement);
  await writeMacOSJsonExclusive(replacement, value);
  await rename(replacement, destination);
}

export async function assertMacOSPathAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error("macOS staging destination already exists.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
