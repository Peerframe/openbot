import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import {
  collectProductionPackageGraph,
  type ProductionPackageGraph,
} from "./production-package-graph.ts";

import {
  assertReleaseVersion,
  assertSourceCommit,
  assertSourceDateEpoch,
  sha256File,
} from "./release-source.ts";

export interface ByteBounds {
  readonly maximumBytes: number;
  readonly minimumBytes: number;
}
export type LinuxArchitecture = "x64" | "arm64";
export interface NodeRuntimeTarget {
  readonly directory: string;
  readonly filename: string;
  readonly sha256: string;
}
/** Caller and manifest fields are validated before they become release metadata. */
export interface LinuxReleaseMetadata {
  readonly architecture: unknown;
  readonly version: unknown;
  readonly sourceCommit: unknown;
  readonly sourceDateEpoch: unknown;
}
export interface LinuxReleaseFileEntry {
  readonly path: string;
  readonly size: number;
  readonly mode: string;
  readonly sha256: string;
}
export interface LinuxReleaseManifest {
  readonly schemaVersion: 1;
  readonly product: "openbot-node";
  readonly platform: "linux";
  readonly architecture: LinuxArchitecture;
  readonly version: string;
  readonly sourceCommit: string;
  readonly sourceDate: string;
  readonly runtime: {
    readonly name: "node";
    readonly version: string;
    readonly archiveSha256: string;
  };
  readonly signed: false;
  readonly files: readonly LinuxReleaseFileEntry[];
}
export interface SpdxDocument extends Record<string, unknown> {
  spdxVersion: "SPDX-2.3";
  packages: unknown[];
}
export interface SbomProjectionInput {
  readonly destination: string;
  readonly lockfile: unknown;
  readonly version: unknown;
}
export interface DpkgPackageVersions {
  readonly tar: string;
  readonly "xz-utils": string;
}
export interface LinuxArchiveToolchainInput {
  readonly osRelease: unknown;
  readonly tarVersion: unknown;
  readonly xzVersion: unknown;
  readonly packageVersions: unknown;
}
export interface LinuxArchiveToolchain {
  readonly tar: string;
  readonly xzUtils: string;
}
export interface LinuxArchiveToolPaths {
  readonly dpkgQuery: "/usr/bin/dpkg-query";
  readonly gnuTar: "/usr/bin/tar";
  readonly xz: "/usr/bin/xz";
}
export interface PackagedNodeHelloExpectation {
  readonly architecture: string;
  readonly credential: string;
  readonly nodeId: string;
  readonly protocolVersion: string;
}
export interface DeterministicTarInput {
  readonly candidateName: unknown;
  readonly sourceDateEpoch: unknown;
  readonly tarPath: string;
  readonly parentDirectory: string;
}

export const NODE_RUNTIME_VERSION = "22.22.2";
export const NCC_VERSION = "0.45.0";
export const RELEASE_NPM_VERSION = "10.9.9";
export const LINUX_RELEASE_ARCHIVE_BOUNDS: ByteBounds = Object.freeze({
  maximumBytes: 96 * 1024 * 1024,
  minimumBytes: 20 * 1024 * 1024,
});

export const NODE_RUNTIME_TARGETS: Readonly<Record<LinuxArchitecture, NodeRuntimeTarget>> =
  Object.freeze({
    x64: Object.freeze({
      directory: `node-v${NODE_RUNTIME_VERSION}-linux-x64`,
      filename: `node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.xz`,
      sha256: "88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a",
    }),
    arm64: Object.freeze({
      directory: `node-v${NODE_RUNTIME_VERSION}-linux-arm64`,
      filename: `node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.xz`,
      sha256: "e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe",
    }),
  });

const EXPECTED_NCC_ASSETS = Object.freeze([
  "file.js",
  "index.js",
  "third-party-licenses.txt",
  "worker.js",
  "worker1.js",
]);
const EXPECTED_NCC_OUTPUTS = Object.freeze([...EXPECTED_NCC_ASSETS, "package.json"].sort());
const EXPECTED_OPTIONAL_STUBS = new Set(["bufferutil", "utf-8-validate"]);
const EXPECTED_INTERNAL_LICENSE_WARNINGS = new Set(
  [
    "@openbot/node",
    "@openbot/config",
    "@openbot/logging",
    "@openbot/protocol",
    "@openbot/provider-sdk",
    "@openbot/provider-docker",
    "@openbot/windows-secret-acl",
  ].map(
    (name) =>
      `license-webpack-plugin: could not find any license file for ${name}. Use the licenseTextOverrides option to add the license text if desired.`,
  ),
);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const FORBIDDEN_RELEASE_PACKAGES = new Set([
  "@openbot/provider-coder",
  "@openbot/provider-cua",
  "@openbot/provider-lume",
  "@vercel/ncc",
  "tsx",
  "typescript",
  "vitest",
]);

/**
 * Fixed-bound regular-file SHA-256 for untrusted installer paths.
 *
 * Two-pass read contract (Linux archive import):
 * 1) Pre-digest — hash the reviewed source through this opener
 *    (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`) before the injectable `openFile` hook
 *    runs, so a symlink/FIFO/growing replacement cannot hang or unbounded-read the
 *    process.
 * 2) Import-path digest — hash the exclusive private import the same way and
 *    require equality. Same-size in-place mutation is detected by digest mismatch
 *    without relying on mtime/ctime. Equality only proves both reads observed the
 *    same bytes; source authenticity still requires later attestation.
 *
 * The import source reopen (via injectable `openFile`, defaulting to `fs.open`) must
 * use the same fixed flags; pre-digest alone does not protect that later open from a
 * post-digest FIFO/symlink swap.
 *
 * Rejects non-regular files, out-of-bound sizes, and reads that deliver more bytes
 * than the fstat-declared size or the configured maximum.
 */
export async function sha256BoundedRegularFile(
  filePath: string,
  bounds: ByteBounds = LINUX_RELEASE_ARCHIVE_BOUNDS,
): Promise<string> {
  if (
    !isRecord(bounds) ||
    !Number.isSafeInteger(bounds.minimumBytes) ||
    !Number.isSafeInteger(bounds.maximumBytes) ||
    bounds.minimumBytes < 0 ||
    bounds.maximumBytes < bounds.minimumBytes
  ) {
    throw new Error("Linux bounded file digest bounds are malformed.");
  }
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Linux bounded file digest source is not a regular file.");
    }
    if (metadata.size < bounds.minimumBytes || metadata.size > bounds.maximumBytes) {
      throw new Error("Linux bounded file digest source size is outside the reviewed bound.");
    }
    const expectedSize = metadata.size;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(expectedSize, 1)));
    let total = 0;
    while (total < expectedSize) {
      const toRead = Math.min(buffer.length, expectedSize - total);
      const { bytesRead } = await handle.read(buffer, 0, toRead, null);
      if (bytesRead === 0) {
        throw new Error("Linux bounded file digest source shrank while it was read.");
      }
      total += bytesRead;
      if (total > expectedSize || total > bounds.maximumBytes) {
        throw new Error("Linux bounded file digest exceeded its declared size bound.");
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const afterRead = await handle.stat();
    if (afterRead.size > expectedSize || afterRead.size > bounds.maximumBytes) {
      throw new Error("Linux bounded file digest source grew beyond its declared size.");
    }
    const { bytesRead: extraBytes } = await handle.read(buffer, 0, 1, null);
    if (extraBytes !== 0) {
      throw new Error("Linux bounded file digest source grew beyond its declared size.");
    }
    if (total !== expectedSize) {
      throw new Error("Linux bounded file digest source size mismatched the declared size.");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function verifyNodeRuntimeArchive(
  filePath: string,
  architecture: unknown,
): Promise<NodeRuntimeTarget> {
  if (!isLinuxArchitecture(architecture))
    throw new Error("Linux runtime architecture must be x64 or arm64.");
  const target = NODE_RUNTIME_TARGETS[architecture];
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 20 * 1024 * 1024 || metadata.size > 40 * 1024 * 1024) {
    throw new Error("Node runtime archive size is outside the reviewed bound.");
  }
  const actual = await sha256File(filePath);
  if (actual !== target.sha256)
    throw new Error("Node runtime archive SHA-256 does not match the pin.");
  return target;
}

export async function writeProductionSbomProjection({
  destination,
  lockfile,
  version,
}: SbomProjectionInput): Promise<ProductionPackageGraph> {
  const releaseVersion = assertReleaseVersion(version);
  const graph = collectProductionPackageGraph(lockfile);
  const packages = field(lockfile, "packages");
  if (!isRecord(packages)) {
    throw new Error("Release packaging requires an npm lockfileVersion 3 package graph.");
  }
  const root = {
    name: "openbot-node-linux-runtime",
    version: releaseVersion,
    private: true,
    license: "MIT",
    workspaces: graph.workspaceKeys,
  };
  const projectedPackages: Record<string, unknown> = { "": root };
  for (const workspaceKey of graph.workspaceKeys) {
    const source = packages[workspaceKey];
    const projected = projectPackageEntry(source, true);
    projectedPackages[workspaceKey] = projected;
    projectedPackages[`node_modules/${projected.name}`] = { link: true, resolved: workspaceKey };
    await mkdir(path.join(destination, workspaceKey), { recursive: true });
    await writeJson(path.join(destination, workspaceKey, "package.json"), projected);
  }
  for (const packageKey of graph.packageKeys) {
    projectedPackages[packageKey] = projectPackageEntry(packages[packageKey], false);
  }
  const projectedLock = {
    name: root.name,
    version: releaseVersion,
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(
      Object.entries(projectedPackages).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  await mkdir(destination, { recursive: true });
  await writeJson(path.join(destination, "package.json"), root);
  await writeJson(path.join(destination, "package-lock.json"), projectedLock);
  return graph;
}

export function validateSpdxSbom(
  sbom: unknown,
  graph: ProductionPackageGraph,
  lockfile: unknown,
): SpdxDocument {
  if (!isSpdxDocument(sbom)) throw new Error("Release SBOM must be an SPDX 2.3 document.");
  const actual = new Set<unknown>(
    sbom.packages.map((entry) => field(entry, "name")).filter((name) => typeof name === "string"),
  );
  for (const forbidden of FORBIDDEN_RELEASE_PACKAGES) {
    if (actual.has(forbidden))
      throw new Error(`Release SBOM contains a non-production package: ${forbidden}.`);
  }
  const packages = field(lockfile, "packages");
  if (!isRecord(packages)) {
    throw new Error("Release packaging requires an npm lockfileVersion 3 package graph.");
  }
  for (const packageKey of [...graph.workspaceKeys, ...graph.packageKeys]) {
    const expectedName = field(packages[packageKey], "name") ?? packageNameFromLockKey(packageKey);
    if (!actual.has(expectedName)) throw new Error(`Release SBOM is missing ${expectedName}.`);
  }
  return sbom;
}

function isSpdxDocument(value: unknown): value is SpdxDocument {
  return isRecord(value) && value.spdxVersion === "SPDX-2.3" && Array.isArray(value.packages);
}

export function canonicalizeSpdxSbom(
  sbom: unknown,
  metadata: LinuxReleaseMetadata,
): Record<string, unknown> {
  const version = assertReleaseVersion(metadata.version);
  const sourceCommit = assertSourceCommit(metadata.sourceCommit);
  const sourceDateEpoch = assertSourceDateEpoch(metadata.sourceDateEpoch);
  const architecture = metadata.architecture;
  if (!isLinuxArchitecture(architecture))
    throw new Error("Linux SBOM architecture must be x64 or arm64.");
  const canonical: unknown = structuredClone(sbom);
  const creationInfo = field(canonical, "creationInfo");
  if (!isRecord(canonical) || !isRecord(creationInfo) || !Array.isArray(creationInfo.creators)) {
    throw new Error("Release SBOM creation information is missing.");
  }
  const creators: unknown[] = creationInfo.creators;
  if (!creators.includes(`Tool: npm/cli-${RELEASE_NPM_VERSION}`)) {
    throw new Error(`Release SBOM was not generated by npm ${RELEASE_NPM_VERSION}.`);
  }
  const packages = canonical.packages;
  if (!Array.isArray(packages) || !packages.every((entry) => isRecord(entry))) {
    throw new Error("Release SBOM must be an SPDX 2.3 document.");
  }
  const relationships = canonical.relationships;
  if (Array.isArray(relationships) && !relationships.every((entry) => isRecord(entry))) {
    throw new Error("Release SBOM must be an SPDX 2.3 document.");
  }
  canonical.name = `openbot-node-${version}-linux-${metadata.architecture}`;
  canonical.documentNamespace = `https://openbot.dev/spdx/openbot-node/${version}/linux/${metadata.architecture}/${sourceCommit}`;
  creationInfo.created = new Date(sourceDateEpoch * 1000).toISOString();
  creators.sort();
  packages.sort((left, right) =>
    String(field(left, "SPDXID")).localeCompare(String(field(right, "SPDXID"))),
  );
  if (Array.isArray(relationships)) {
    relationships.sort((left, right) =>
      relationshipKey(left).localeCompare(relationshipKey(right)),
    );
  }
  return canonical;
}

export function validateNccStats(stats: unknown, outputNames: Iterable<string>): void {
  if (!isRecord(stats) || stats.errorsCount !== 0 || !Array.isArray(stats.warnings)) {
    throw new Error("ncc reported build errors or an invalid warning set.");
  }
  const warnings: unknown[] = stats.warnings.map((warning) => field(warning, "message"));
  if (
    stats.warningsCount !== EXPECTED_INTERNAL_LICENSE_WARNINGS.size ||
    warnings.some(
      (warning) => typeof warning !== "string" || !EXPECTED_INTERNAL_LICENSE_WARNINGS.has(warning),
    ) ||
    new Set(warnings).size !== EXPECTED_INTERNAL_LICENSE_WARNINGS.size
  ) {
    throw new Error("ncc reported an unexpected build warning.");
  }
  const assetEntries = stats.assets ?? [];
  if (!Array.isArray(assetEntries)) throw new Error("ncc emitted an unexpected asset set.");
  const assets = assetEntries.map((asset) => field(asset, "name")).sort();
  if (JSON.stringify(assets) !== JSON.stringify(EXPECTED_NCC_ASSETS)) {
    throw new Error("ncc emitted an unexpected asset set.");
  }
  if (JSON.stringify([...outputNames].sort()) !== JSON.stringify(EXPECTED_NCC_OUTPUTS)) {
    throw new Error("ncc output directory contains unexpected files.");
  }
  const modules = stats.modules ?? [];
  if (!Array.isArray(modules)) throw new Error("ncc emitted an unexpected module set.");
  for (const module of modules) {
    const name = field(module, "name");
    if (typeof name !== "string") continue;
    const external = /^external "([^"]+)"$/.exec(name)?.[1];
    if (external !== undefined && !BUILTINS.has(external)) {
      throw new Error(`ncc left a non-builtin dependency external: ${external}.`);
    }
    const missing = /@@notfound\.js\?(.+)$/.exec(name)?.[1];
    if (missing !== undefined && !EXPECTED_OPTIONAL_STUBS.has(missing)) {
      throw new Error(`ncc emitted an unexpected missing-module stub: ${missing}.`);
    }
  }
}

export async function createFileManifest(
  root: string,
  metadata: LinuxReleaseMetadata,
  excludedPaths: Iterable<string> = [],
): Promise<LinuxReleaseManifest> {
  const architecture = metadata.architecture;
  if (!isLinuxArchitecture(architecture)) {
    throw new Error("Linux manifest architecture must be x64 or arm64.");
  }
  const sourceDateEpoch = assertSourceDateEpoch(metadata.sourceDateEpoch);
  const exclusions = new Set(excludedPaths);
  for (const excludedPath of exclusions) assertRelativeArchivePath(excludedPath);
  const files: LinuxReleaseFileEntry[] = [];
  let totalSize = 0;
  await walk(
    root,
    "",
    files,
    (size) => {
      totalSize += size;
      if (totalSize > 256 * 1024 * 1024)
        throw new Error("Release payload exceeds the total size bound.");
    },
    exclusions,
  );
  if (files.length > 256) throw new Error("Release payload exceeds the file-count bound.");
  return {
    schemaVersion: 1,
    product: "openbot-node",
    platform: "linux",
    architecture,
    version: assertReleaseVersion(metadata.version),
    sourceCommit: assertSourceCommit(metadata.sourceCommit),
    sourceDate: new Date(sourceDateEpoch * 1000).toISOString(),
    runtime: {
      name: "node",
      version: NODE_RUNTIME_VERSION,
      archiveSha256: NODE_RUNTIME_TARGETS[architecture].sha256,
    },
    signed: false,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function writeChecksums(
  root: string,
  relativePaths: Iterable<string>,
  destination: string,
): Promise<void> {
  const lines: string[] = [];
  for (const relativePath of [...relativePaths].sort()) {
    assertRelativeArchivePath(relativePath);
    lines.push(`${await sha256File(path.join(root, relativePath))}  ${relativePath}`);
  }
  await writeFile(destination, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
}

export async function copyReleaseFile(
  source: string,
  destination: string,
  mode = 0o644,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

export async function listRegularFiles(root: string): Promise<string[]> {
  const files: LinuxReleaseFileEntry[] = [];
  await walk(root, "", files, () => undefined, new Set());
  return files.map((entry) => entry.path);
}

export function parseOsRelease(source: unknown): Record<string, string> {
  if (typeof source !== "string" || source.length < 1 || source.length > 64 * 1024) {
    throw new Error("OS release metadata is missing or too large.");
  }
  const values: Record<string, string> = {};
  for (const line of source.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    const key = match?.[1];
    let value = match?.[2];
    if (key === undefined || value === undefined || Object.hasOwn(values, key)) {
      throw new Error("OS release metadata is malformed or contains duplicate keys.");
    }
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) {
        throw new Error("OS release metadata contains an unterminated quoted value.");
      }
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    }
    values[key] = value;
  }
  return values;
}

export function parseDpkgPackageVersions(source: unknown): DpkgPackageVersions {
  if (typeof source !== "string" || source.length < 1 || source.length > 4 * 1024) {
    throw new Error("Release package metadata is missing or too large.");
  }
  const versions: Record<string, string> = {};
  for (const line of source.trimEnd().split("\n")) {
    const match = /^(tar|xz-utils)=([^\s=]{1,128})$/.exec(line);
    const name = match?.[1];
    const version = match?.[2];
    if (name === undefined || version === undefined || Object.hasOwn(versions, name)) {
      throw new Error("Release package metadata is malformed or duplicated.");
    }
    versions[name] = version;
  }
  if (!hasDpkgPackageVersions(versions)) {
    throw new Error("Release package metadata must contain tar and xz-utils exactly once.");
  }
  return versions;
}

export function validateLinuxArchiveToolchain({
  osRelease,
  tarVersion,
  xzVersion,
  packageVersions,
}: LinuxArchiveToolchainInput): LinuxArchiveToolchain {
  if (field(osRelease, "ID") !== "ubuntu" || field(osRelease, "VERSION_ID") !== "24.04") {
    throw new Error("Linux archives must be created on Ubuntu 24.04.");
  }
  if (String(tarVersion).split("\n")[0] !== "tar (GNU tar) 1.35") {
    throw new Error("Linux archives require GNU tar 1.35.");
  }
  if (String(xzVersion).split("\n")[0] !== "xz (XZ Utils) 5.4.5") {
    throw new Error("Linux archives require XZ Utils 5.4.5.");
  }
  const tar = field(packageVersions, "tar");
  const xzUtils = field(packageVersions, "xz-utils");
  if (
    typeof tar !== "string" ||
    typeof xzUtils !== "string" ||
    !/^[^\s=]{1,128}$/.test(tar) ||
    !/^[^\s=]{1,128}$/.test(xzUtils)
  ) {
    throw new Error("Linux archive package revisions are missing or invalid.");
  }
  return { tar, xzUtils };
}

export function validateLinuxArchiveToolPaths(paths: unknown): LinuxArchiveToolPaths {
  const expected: LinuxArchiveToolPaths = {
    dpkgQuery: "/usr/bin/dpkg-query",
    gnuTar: "/usr/bin/tar",
    xz: "/usr/bin/xz",
  };
  for (const name of ["dpkgQuery", "gnuTar", "xz"] as const) {
    const expectedPath = expected[name];
    if (field(paths, name) !== expectedPath) {
      throw new Error(`Linux archive tool must use the reviewed path: ${expectedPath}.`);
    }
  }
  return expected;
}

export function validatePackagedNodeHello(
  message: unknown,
  expected: PackagedNodeHelloExpectation,
): Record<string, unknown> {
  if (!isRecord(message) || message.type !== "node.hello") {
    throw new Error("Packaged Node did not send a hello message.");
  }
  if (
    message.protocolVersion !== expected.protocolVersion ||
    message.nodeId !== expected.nodeId ||
    message.credential !== expected.credential
  ) {
    throw new Error("Packaged Node hello identity does not match the smoke fixture.");
  }
  if (
    message.platform !== "linux" ||
    message.architecture !== expected.architecture ||
    message.deviceClass !== "server" ||
    message.isolation !== "unknown" ||
    message.trustTier !== "development"
  ) {
    throw new Error("Packaged Node hello host declaration is unexpected.");
  }
  if (
    message.maxConcurrentRuns !== 1 ||
    !Array.isArray(message.capabilities) ||
    message.capabilities.length !== 0 ||
    !Array.isArray(message.capabilityManifest) ||
    message.capabilityManifest.length !== 0
  ) {
    throw new Error("Packaged Node smoke fixture advertised unexpected authority.");
  }
  return message;
}

export function deterministicTarArguments({
  candidateName,
  sourceDateEpoch,
  tarPath,
  parentDirectory,
}: DeterministicTarInput): string[] {
  assertRelativeArchivePath(candidateName);
  if (candidateName.includes("/")) throw new Error("Candidate name must be one path component.");
  const epoch = assertSourceDateEpoch(sourceDateEpoch);
  return [
    "--sort=name",
    "--format=posix",
    "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
    "--clamp-mtime",
    `--mtime=@${epoch}`,
    "--numeric-owner",
    "--owner=0",
    "--group=0",
    "--mode=go+u,go-w",
    "--create",
    `--file=${tarPath}`,
    `--directory=${parentDirectory}`,
    candidateName,
  ];
}

export function deterministicXzArguments(tarPath: string): string[] {
  return ["--threads=1", "--check=sha256", "--no-adjust", "-6", "--compress", "--stdout", tarPath];
}

export function linuxInstalledReleaseName(manifest: unknown): string {
  if (!isRecord(manifest) || manifest.platform !== "linux") {
    throw new Error("Installed release manifest must declare Linux.");
  }
  const architecture = manifest.architecture;
  if (!isLinuxArchitecture(architecture)) {
    throw new Error("Installed release architecture must be x64 or arm64.");
  }
  return `openbot-node-${assertReleaseVersion(manifest.version)}-linux-${architecture}-${assertSourceCommit(manifest.sourceCommit)}`;
}

export async function verifyCandidateDirectory(candidate: string): Promise<LinuxReleaseManifest> {
  return verifyLinuxReleaseDirectory(
    candidate,
    (manifest) => `openbot-node-${manifest.version}-linux-${manifest.architecture}-unsigned`,
  );
}

export async function verifyInstalledLinuxReleaseDirectory(
  directory: string,
): Promise<LinuxReleaseManifest> {
  return verifyLinuxReleaseDirectory(directory, linuxInstalledReleaseName);
}

async function verifyLinuxReleaseDirectory(
  directory: string,
  expectedNameForManifest: (manifest: Record<string, unknown>) => string,
): Promise<LinuxReleaseManifest> {
  const rootMetadata = await lstat(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Linux release must be a real directory.");
  }
  for (const metadataName of ["manifest.json", "SHA256SUMS"]) {
    const metadata = await lstat(path.join(directory, metadataName));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) {
      throw new Error(`Linux release ${metadataName} must be a bounded regular file.`);
    }
  }
  const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8");
  const manifest: unknown = JSON.parse(manifestText);
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.signed !== false) {
    throw new Error("Release candidate manifest must be schema 1 and explicitly unsigned.");
  }
  const sourceDate = manifest.sourceDate;
  const sourceDateMilliseconds = typeof sourceDate === "string" ? Date.parse(sourceDate) : NaN;
  if (
    !Number.isFinite(sourceDateMilliseconds) ||
    sourceDateMilliseconds % 1000 !== 0 ||
    new Date(sourceDateMilliseconds).toISOString() !== manifest.sourceDate
  ) {
    throw new Error("Release candidate source date is not canonical.");
  }
  const expectedName = expectedNameForManifest(manifest);
  if (path.basename(path.resolve(directory)) !== expectedName) {
    throw new Error("Linux release directory name does not match its manifest.");
  }
  const rebuilt = await createFileManifest(
    directory,
    {
      architecture: manifest.architecture,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      sourceDateEpoch: sourceDateMilliseconds / 1000,
    },
    ["manifest.json", "SHA256SUMS"],
  );
  if (`${JSON.stringify(rebuilt, null, 2)}\n` !== manifestText) {
    throw new Error("Release candidate manifest does not match staged bytes.");
  }
  const checksumText = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  await verifyChecksums(directory, checksumText);
  const expectedChecksumPaths = [
    ...rebuilt.files.map((entry) => entry.path),
    "manifest.json",
  ].sort();
  const actualChecksumPaths = checksumText
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(66));
  if (JSON.stringify(actualChecksumPaths) !== JSON.stringify(expectedChecksumPaths)) {
    throw new Error("Release checksums do not cover the candidate exactly once.");
  }
  return rebuilt;
}

export async function verifyChecksums(root: string, source: unknown): Promise<string[]> {
  if (typeof source !== "string" || !source.endsWith("\n") || source.length > 128 * 1024) {
    throw new Error("Release checksum file is missing, too large, or non-canonical.");
  }
  const paths: string[] = [];
  const canonicalLines: string[] = [];
  for (const line of source.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    const digest = match?.[1];
    const relativePath = match?.[2];
    if (digest === undefined || relativePath === undefined)
      throw new Error("Release checksum entry is malformed.");
    assertRelativeArchivePath(relativePath);
    if (relativePath === "SHA256SUMS" || paths.includes(relativePath)) {
      throw new Error("Release checksum entry is recursive or duplicated.");
    }
    paths.push(relativePath);
    canonicalLines.push(`${digest}  ${relativePath}`);
    if ((await sha256File(path.join(root, relativePath))) !== digest) {
      throw new Error(`Release checksum mismatch: ${relativePath}.`);
    }
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error("Release checksum entries are not sorted.");
  }
  if (`${canonicalLines.join("\n")}\n` !== source) {
    throw new Error("Release checksum file is not canonical.");
  }
  return paths;
}

function projectPackageEntry(entry: unknown, workspace: boolean): Record<string, unknown> {
  if (!isRecord(entry)) throw new Error("Package projection received an invalid lock entry.");
  const projected = { ...entry };
  delete projected.dev;
  delete projected.devDependencies;
  if (workspace) projected.license = "MIT";
  return projected;
}

function packageNameFromLockKey(packageKey: string): string {
  const marker = packageKey.lastIndexOf("node_modules/");
  return packageKey.slice(marker + "node_modules/".length);
}

async function walk(
  root: string,
  relative: string,
  files: LinuxReleaseFileEntry[],
  addSize: (size: number) => void,
  exclusions: ReadonlySet<string>,
): Promise<void> {
  const current = relative === "" ? root : path.join(root, relative);
  for (const name of (await readdir(current)).sort()) {
    const childRelative = relative === "" ? name : `${relative}/${name}`;
    assertRelativeArchivePath(childRelative);
    if (exclusions.has(childRelative)) continue;
    const child = path.join(root, childRelative);
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink())
      throw new Error(`Release payload contains a symbolic link: ${childRelative}.`);
    if (metadata.isDirectory()) {
      await walk(root, childRelative, files, addSize, exclusions);
      continue;
    }
    if (!metadata.isFile() || metadata.size > 160 * 1024 * 1024) {
      throw new Error(`Release payload contains an unsupported file: ${childRelative}.`);
    }
    addSize(metadata.size);
    files.push({
      path: childRelative,
      size: metadata.size,
      mode: (metadata.mode & 0o777).toString(8).padStart(4, "0"),
      sha256: await sha256File(child),
    });
  }
}

function assertRelativeArchivePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    }) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Release payload path is unsafe.");
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
function isLinuxArchitecture(value: unknown): value is LinuxArchitecture {
  return value === "x64" || value === "arm64";
}
function hasDpkgPackageVersions(
  versions: Record<string, string>,
): versions is Record<string, string> & DpkgPackageVersions {
  return (
    Object.keys(versions).length === 2 &&
    versions.tar !== undefined &&
    versions["xz-utils"] !== undefined
  );
}
function relationshipKey(entry: unknown): string {
  return `${field(entry, "spdxElementId")}\0${field(entry, "relationshipType")}\0${field(entry, "relatedSpdxElement")}`;
}
