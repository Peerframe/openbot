import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertMacOSArchitecture,
  assertMacOSBuildVersion,
  assertMacOSPathAbsent,
  type MacOSArchitecture,
  type MacOSRuntimeManifest,
  readMacOSBuildMetadata,
  readMacOSRuntimeManifest,
  writeMacOSFileExclusive,
  writeMacOSInitialMetadata,
} from "./macos-worker-host-metadata.ts";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";

export type {
  MacOSArchitecture,
  MacOSBuildMetadata,
  MacOSCriticalFileRecord,
  MacOSRuntimeManifest,
} from "./macos-worker-host-metadata.ts";
export {
  assertMacOSArchitecture,
  assertMacOSBuildVersion,
  MACOS_CRITICAL_FILES,
  sealMacOSWorkerHostApplicationMetadata,
} from "./macos-worker-host-metadata.ts";

export interface MacOSRuntimeTarget {
  readonly directory: string;
  readonly filename: string;
  readonly sha256: string;
}
export interface MacOSStagingOptions {
  readonly architecture: string;
  readonly buildVersion: string;
  readonly controlBinary: string;
  readonly destination: string;
  readonly enrollmentDocumentation: string;
  readonly enrollmentDocumentationChinese: string;
  readonly infoTemplate: string;
  readonly launchAgentPlist: string;
  readonly nodeBinary: string;
  readonly nodeBundleDirectory: string;
  readonly nodeLicense: string;
  readonly openBotLicense: string;
  readonly sourceCommit: string;
  readonly version: string;
}
export interface MacOSApplicationValidationOptions {
  readonly expectedOwner?: number | undefined;
  readonly allowDistributionArtifacts?: boolean | undefined;
  readonly expectedSigned?: boolean | undefined;
}
export interface MacOSProvisioningProfileOptions {
  readonly accessGroup: unknown;
  readonly now?: Date | undefined;
}
export interface MacOSExtendedAttributeOptions {
  readonly allowProvenance?: boolean | undefined;
}
export interface MacOSDistributionSigningInput {
  readonly applicationPath: string;
  readonly outputPackage: string;
  readonly identities: Readonly<Record<string, unknown>>;
  readonly notaryProfile: unknown;
}
export interface MacOSDistributionSigningStep {
  readonly tool: string;
  readonly target: string;
  readonly role: string;
}
interface InputFileBounds {
  readonly minimum: number;
  readonly maximum: number;
}

export const MACOS_RUNTIME_TARGETS = Object.freeze<Record<MacOSArchitecture, MacOSRuntimeTarget>>({
  arm64: Object.freeze({
    directory: "node-v22.22.2-darwin-arm64",
    filename: "node-v22.22.2-darwin-arm64.tar.gz",
    sha256: "db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000",
  }),
  x64: Object.freeze({
    directory: "node-v22.22.2-darwin-x64",
    filename: "node-v22.22.2-darwin-x64.tar.gz",
    sha256: "12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba",
  }),
});

export const MACOS_NCC_OUTPUTS: readonly string[] = Object.freeze([
  "file.js",
  "index.js",
  "package.json",
  "third-party-licenses.txt",
  "worker.js",
  "worker1.js",
]);

export const MACOS_APP_FILES: readonly string[] = Object.freeze(
  [
    "Contents/Info.plist",
    "Contents/Library/LaunchAgents/com.openbot.worker-host.node.plist",
    "Contents/MacOS/OpenBotWorkerHostControl",
    "Contents/Resources/LICENSE",
    "Contents/Resources/build.json",
    "Contents/Resources/docs/NODE_ENROLLMENT.md",
    "Contents/Resources/docs/NODE_ENROLLMENT.zh-CN.md",
    "Contents/Resources/licenses/NODE_LICENSE",
    "Contents/Resources/manifest.json",
    ...MACOS_NCC_OUTPUTS.map((name) => `Contents/Resources/node/app/${name}`),
    "Contents/Resources/node/bin/node",
  ].sort(),
);

export function assertMacOSAccessGroup(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{10}\.com\.openbot\.worker-host\.shared$/.test(value)
  ) {
    throw new Error("macOS access group must contain one Team ID and the fixed OpenBot suffix.");
  }
  return value;
}

export function assertMacOSDeveloperIdentities(identities: unknown, accessGroup: unknown): string {
  const teamId = assertMacOSAccessGroup(accessGroup).slice(0, 10);
  const patterns = {
    applicationIdentity: /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/,
    installerIdentity: /^Developer ID Installer: .+ \(([A-Z0-9]{10})\)$/,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    const value = field(identities, name);
    if (
      typeof value !== "string" ||
      value.match(pattern)?.[1] !== teamId ||
      value.length > 256 ||
      /[\0\r\n]/.test(value)
    ) {
      throw new Error(`macOS Developer ID identity is invalid: ${name}.`);
    }
  }
  return teamId;
}

export function validateMacOSProvisioningProfile(
  profile: unknown,
  { accessGroup, now = new Date() }: MacOSProvisioningProfileOptions,
): void {
  const group = assertMacOSAccessGroup(accessGroup);
  const teamId = group.slice(0, 10);
  const applicationIdentifier = `${teamId}.com.openbot.worker-host`;
  const expiration = profileDate(field(profile, "ExpirationDate"));
  const entitlements = field(profile, "Entitlements");
  const platforms = field(profile, "Platform");
  const teamIdentifiers = field(profile, "TeamIdentifier");
  const prefixes = field(profile, "ApplicationIdentifierPrefix");
  const accessGroups = field(entitlements, "keychain-access-groups");
  if (
    field(profile, "ProvisionsAllDevices") !== true ||
    !isUnknownArray(platforms) ||
    !platforms.includes("OSX") ||
    !isUnknownArray(teamIdentifiers) ||
    !teamIdentifiers.includes(teamId) ||
    !isUnknownArray(prefixes) ||
    !prefixes.includes(teamId) ||
    !(expiration.getTime() > now.getTime() + 24 * 60 * 60 * 1_000) ||
    field(entitlements, "com.apple.application-identifier") !== applicationIdentifier ||
    field(entitlements, "com.apple.developer.team-identifier") !== teamId ||
    !isUnknownArray(accessGroups) ||
    !accessGroups.some((candidate) => candidate === group || candidate === `${teamId}.*`) ||
    field(entitlements, "get-task-allow") === true
  ) {
    throw new Error("The macOS provisioning profile does not authorize the reviewed application.");
  }
}

export function assertMacOSExtendedAttributes(
  output: unknown,
  { allowProvenance = false }: MacOSExtendedAttributeOptions = {},
): void {
  if (typeof output !== "string" || output.length > 64 * 1024) {
    throw new Error("macOS extended-attribute output is outside the reviewed bound.");
  }
  const entries = output.trim() === "" ? [] : output.trim().split(/\r?\n/);
  for (const entry of entries) {
    const separator = entry.lastIndexOf(": ");
    const attribute = separator === -1 ? "" : entry.slice(separator + 2);
    if (!allowProvenance || attribute !== "com.apple.provenance") {
      throw new Error("The macOS application contains an unexpected extended attribute.");
    }
  }
}

export async function verifyMacOSNodeRuntimeArchive(
  filePath: string,
  architecture: unknown,
): Promise<MacOSRuntimeTarget> {
  const target = MACOS_RUNTIME_TARGETS[assertMacOSArchitecture(architecture)];
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 20 * 1024 * 1024 || metadata.size > 60 * 1024 * 1024) {
    throw new Error("macOS Node runtime archive size is outside the reviewed bound.");
  }
  if ((await sha256File(filePath)) !== target.sha256) {
    throw new Error("macOS Node runtime archive SHA-256 does not match the official pin.");
  }
  return target;
}

export async function stageMacOSWorkerHostApplication(
  options: MacOSStagingOptions,
): Promise<string> {
  const version = assertReleaseVersion(options.version);
  const buildVersion = assertMacOSBuildVersion(options.buildVersion);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  const architecture = assertMacOSArchitecture(options.architecture);
  const destination = path.resolve(options.destination);
  await assertMacOSPathAbsent(destination);
  await assertInputFile(options.controlBinary, { minimum: 16 * 1024, maximum: 32 * 1024 * 1024 });
  await assertInputFile(options.nodeBinary, {
    minimum: 20 * 1024 * 1024,
    maximum: 128 * 1024 * 1024,
  });
  await assertInputFile(options.nodeLicense, { minimum: 1_024, maximum: 1024 * 1024 });

  const bundleNames = (await readdir(options.nodeBundleDirectory)).sort();
  if (JSON.stringify(bundleNames) !== JSON.stringify(MACOS_NCC_OUTPUTS)) {
    throw new Error("macOS Node bundle inventory does not match the reviewed ncc output.");
  }
  for (const name of bundleNames) {
    await assertInputFile(path.join(options.nodeBundleDirectory, name), {
      minimum: 1,
      maximum: 16 * 1024 * 1024,
    });
  }

  const infoTemplate = await readFile(options.infoTemplate, "utf8");
  if (
    count(infoTemplate, "OPENBOT_VERSION") !== 1 ||
    count(infoTemplate, "OPENBOT_BUILD_VERSION") !== 1
  ) {
    throw new Error("macOS Info.plist template placeholders are invalid.");
  }
  const info = infoTemplate
    .replace("OPENBOT_VERSION", escapeXml(version.split("+")[0] ?? version))
    .replace("OPENBOT_BUILD_VERSION", buildVersion);

  await mkdir(destination, { mode: 0o755 });
  await copyChecked(
    options.controlBinary,
    destination,
    "Contents/MacOS/OpenBotWorkerHostControl",
    0o755,
  );
  await copyChecked(options.nodeBinary, destination, "Contents/Resources/node/bin/node", 0o755);
  await copyChecked(options.nodeLicense, destination, "Contents/Resources/licenses/NODE_LICENSE");
  await copyChecked(options.openBotLicense, destination, "Contents/Resources/LICENSE");
  await copyChecked(
    options.enrollmentDocumentation,
    destination,
    "Contents/Resources/docs/NODE_ENROLLMENT.md",
  );
  await copyChecked(
    options.enrollmentDocumentationChinese,
    destination,
    "Contents/Resources/docs/NODE_ENROLLMENT.zh-CN.md",
  );
  await copyChecked(
    options.launchAgentPlist,
    destination,
    "Contents/Library/LaunchAgents/com.openbot.worker-host.node.plist",
  );
  for (const name of bundleNames) {
    await copyChecked(
      path.join(options.nodeBundleDirectory, name),
      destination,
      `Contents/Resources/node/app/${name}`,
    );
  }
  await writeMacOSFileExclusive(path.join(destination, "Contents/Info.plist"), info);
  await writeMacOSInitialMetadata(destination, {
    version,
    buildVersion,
    sourceCommit,
    architecture,
  });
  await validateMacOSWorkerHostApplication(destination, { expectedOwner: process.getuid?.() });
  return destination;
}

export async function validateMacOSWorkerHostApplication(
  applicationPath: string,
  {
    expectedOwner,
    allowDistributionArtifacts = false,
    expectedSigned = allowDistributionArtifacts,
  }: MacOSApplicationValidationOptions = {},
): Promise<MacOSRuntimeManifest> {
  const root = path.resolve(applicationPath);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("macOS application root must be a real directory.");
  }
  const files = await listApplicationFiles(root);
  const expected: readonly string[] = allowDistributionArtifacts
    ? [
        ...MACOS_APP_FILES,
        "Contents/_CodeSignature/CodeResources",
        "Contents/embedded.provisionprofile",
      ].sort()
    : MACOS_APP_FILES;
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error("macOS application inventory does not match the reviewed layout.");
  }

  for (const relativePath of files) {
    const metadata = await lstat(path.join(root, relativePath));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("macOS application contains a non-regular or linked file.");
    }
    if (expectedOwner !== undefined && metadata.uid !== expectedOwner) {
      throw new Error("macOS application contains a file owned by an unexpected user.");
    }
    const executable = [
      "Contents/MacOS/OpenBotWorkerHostControl",
      "Contents/Resources/node/bin/node",
    ].includes(relativePath);
    if ((metadata.mode & 0o777) !== (executable ? 0o755 : 0o644)) {
      throw new Error("macOS application contains an unexpected file mode.");
    }
  }

  const info = await readFile(path.join(root, "Contents/Info.plist"), "utf8");
  for (const fragment of [
    "<string>com.openbot.worker-host</string>",
    "<string>OpenBotWorkerHostControl</string>",
    "<string>APPL</string>",
    "<string>13.0</string>",
  ]) {
    if (!info.includes(fragment)) throw new Error("macOS application Info.plist is invalid.");
  }
  if (/OPENBOT_|credential|token|secret/i.test(info)) {
    throw new Error("macOS application Info.plist contains a placeholder or secret field.");
  }

  const manifest = await readMacOSRuntimeManifest(root);
  for (const record of manifest.files) {
    if (
      record.sha256 !== (await sha256File(path.join(root, record.path))) ||
      record.size !== (await stat(path.join(root, record.path))).size
    ) {
      throw new Error("macOS application runtime manifest does not match its payload.");
    }
  }
  const build = await readMacOSBuildMetadata(root);
  if (
    build.version !== manifest.version ||
    build.sourceCommit !== manifest.sourceCommit ||
    build.architecture !== manifest.architecture ||
    build.signed !== expectedSigned
  ) {
    throw new Error("macOS application build metadata does not match its payload.");
  }
  return manifest;
}

export function expandEntitlementsTemplate(source: string, accessGroup: unknown): string {
  const group = assertMacOSAccessGroup(accessGroup);
  const teamId = group.slice(0, 10);
  const applicationIdentifier = `${teamId}.com.openbot.worker-host`;
  if (
    count(source, "OPENBOT_ACCESS_GROUP") !== 1 ||
    count(source, "OPENBOT_APPLICATION_IDENTIFIER") !== 1 ||
    count(source, "OPENBOT_TEAM_ID") !== 1
  ) {
    throw new Error("macOS entitlement template placeholder is invalid.");
  }
  const expanded = source
    .replace("OPENBOT_ACCESS_GROUP", group)
    .replace("OPENBOT_APPLICATION_IDENTIFIER", applicationIdentifier)
    .replace("OPENBOT_TEAM_ID", teamId);
  if (/OPENBOT_|get-task-allow|app-sandbox|automation|accessibility/i.test(expanded)) {
    throw new Error("macOS entitlements broaden authority or contain placeholders.");
  }
  return expanded;
}

export function distributionSigningPlan({
  applicationPath,
  outputPackage,
  identities,
  notaryProfile,
}: MacOSDistributionSigningInput): MacOSDistributionSigningStep[] {
  const app = path.resolve(applicationPath);
  const output = path.resolve(outputPackage);
  for (const [name, value] of Object.entries({ ...identities, notaryProfile })) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 256 ||
      /[\0\r\n]/.test(value) ||
      value === "-"
    ) {
      throw new Error(`macOS distribution input is invalid: ${name}.`);
    }
  }
  return [
    { tool: "/usr/bin/codesign", target: `${app}/Contents/Resources/node/bin/node`, role: "node" },
    {
      tool: "internal",
      target: `${app}/Contents/Resources/manifest.json`,
      role: "seal-metadata",
    },
    { tool: "/usr/bin/codesign", target: app, role: "application" },
    { tool: "/usr/bin/codesign", target: app, role: "verify-application" },
    { tool: "/usr/bin/productbuild", target: output, role: "package" },
    { tool: "/usr/sbin/pkgutil", target: output, role: "verify-package" },
    { tool: "/usr/bin/xcrun", target: output, role: "notarize" },
    { tool: "/usr/bin/xcrun", target: output, role: "staple" },
    { tool: "/usr/sbin/spctl", target: output, role: "gatekeeper" },
  ];
}

async function assertInputFile(filePath: string, bounds: InputFileBounds): Promise<void> {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < bounds.minimum ||
    metadata.size > bounds.maximum
  ) {
    throw new Error("macOS staging input is outside the reviewed file boundary.");
  }
}

async function copyChecked(
  source: string,
  root: string,
  relativePath: string,
  mode = 0o644,
): Promise<void> {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function listApplicationFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const metadata = await lstat(path.join(directory, name));
      if (metadata.isSymbolicLink()) {
        throw new Error("macOS application cannot contain symbolic links.");
      }
      if (metadata.isDirectory()) await visit(path.join(directory, name), relativePath);
      else if (metadata.isFile()) result.push(relativePath);
      else throw new Error("macOS application contains an unsupported entry.");
      if (result.length > 64) throw new Error("macOS application exceeds the file-count bound.");
    }
  };
  await visit(root, "");
  return result.sort();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function count(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

export function inspectMachOArchitecture(filePath: string): string {
  const output = execFileSync("/usr/bin/lipo", ["-archs", filePath], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const architectures = output.split(/\s+/).sort();
  const [architecture] = architectures;
  if (architectures.length !== 1 || architecture === undefined) {
    throw new Error("macOS candidate inputs must be single-architecture Mach-O files.");
  }
  return architecture === "x86_64" ? "x64" : architecture;
}

/** plutil emits a date string; reject composite values instead of coercing them into dates. */
function profileDate(value: unknown): Date {
  return typeof value === "string" || typeof value === "number" || value instanceof Date
    ? new Date(value)
    : new Date(Number.NaN);
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
