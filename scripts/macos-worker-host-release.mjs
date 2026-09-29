import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertReleaseVersion, assertSourceCommit, sha256File } from "./release-source.ts";

export const MACOS_RUNTIME_TARGETS = Object.freeze({
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

export const MACOS_NCC_OUTPUTS = Object.freeze([
  "file.js",
  "index.js",
  "package.json",
  "third-party-licenses.txt",
  "worker.js",
  "worker1.js",
]);

export const MACOS_CRITICAL_FILES = Object.freeze([
  "Contents/Resources/node/app/index.js",
  "Contents/Resources/node/bin/node",
]);

export const MACOS_APP_FILES = Object.freeze(
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

export function assertMacOSArchitecture(value) {
  if (value !== "arm64" && value !== "x64") {
    throw new Error("macOS architecture must be arm64 or x64.");
  }
  return value;
}

export function assertMacOSBuildVersion(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error("macOS package build version must be a positive bounded integer.");
  }
  return value;
}

export function assertMacOSAccessGroup(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{10}\.com\.openbot\.worker-host\.shared$/.test(value)
  ) {
    throw new Error("macOS access group must contain one Team ID and the fixed OpenBot suffix.");
  }
  return value;
}

export function assertMacOSDeveloperIdentities(identities, accessGroup) {
  const teamId = assertMacOSAccessGroup(accessGroup).slice(0, 10);
  const patterns = {
    applicationIdentity: /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/,
    installerIdentity: /^Developer ID Installer: .+ \(([A-Z0-9]{10})\)$/,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    const value = identities?.[name];
    const match = typeof value === "string" ? value.match(pattern) : null;
    if (match?.[1] !== teamId || value.length > 256 || /[\0\r\n]/.test(value)) {
      throw new Error(`macOS Developer ID identity is invalid: ${name}.`);
    }
  }
  return teamId;
}

export function validateMacOSProvisioningProfile(profile, { accessGroup, now = new Date() }) {
  const teamId = assertMacOSAccessGroup(accessGroup).slice(0, 10);
  const applicationIdentifier = `${teamId}.com.openbot.worker-host`;
  const expiration = new Date(profile?.ExpirationDate);
  const entitlements = profile?.Entitlements;
  if (
    profile?.ProvisionsAllDevices !== true ||
    !Array.isArray(profile?.Platform) ||
    !profile.Platform.includes("OSX") ||
    !Array.isArray(profile?.TeamIdentifier) ||
    !profile.TeamIdentifier.includes(teamId) ||
    !Array.isArray(profile?.ApplicationIdentifierPrefix) ||
    !profile.ApplicationIdentifierPrefix.includes(teamId) ||
    !(expiration.getTime() > now.getTime() + 24 * 60 * 60 * 1_000) ||
    entitlements?.["com.apple.application-identifier"] !== applicationIdentifier ||
    entitlements?.["com.apple.developer.team-identifier"] !== teamId ||
    !Array.isArray(entitlements?.["keychain-access-groups"]) ||
    !entitlements["keychain-access-groups"].some(
      (group) => group === accessGroup || group === `${teamId}.*`,
    ) ||
    entitlements?.["get-task-allow"] === true
  ) {
    throw new Error("The macOS provisioning profile does not authorize the reviewed application.");
  }
}

export function assertMacOSExtendedAttributes(output, { allowProvenance = false } = {}) {
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

export async function verifyMacOSNodeRuntimeArchive(filePath, architecture) {
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

export async function stageMacOSWorkerHostApplication(options) {
  const version = assertReleaseVersion(options.version);
  const buildVersion = assertMacOSBuildVersion(options.buildVersion);
  const sourceCommit = assertSourceCommit(options.sourceCommit);
  const architecture = assertMacOSArchitecture(options.architecture);
  const destination = path.resolve(options.destination);
  await assertAbsent(destination);
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
    .replace("OPENBOT_VERSION", escapeXml(version.split("+")[0]))
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
  await writeExclusive(path.join(destination, "Contents/Info.plist"), info);

  const criticalFiles = [];
  for (const relativePath of MACOS_CRITICAL_FILES) {
    const metadata = await stat(path.join(destination, relativePath));
    criticalFiles.push({
      path: relativePath,
      sha256: await sha256File(path.join(destination, relativePath)),
      size: metadata.size,
      mode: relativePath.endsWith("/node") ? "0755" : "0644",
    });
  }
  criticalFiles.sort((left, right) => left.path.localeCompare(right.path));
  await writeJsonExclusive(path.join(destination, "Contents/Resources/manifest.json"), {
    format: "openbot.macos-worker-host-manifest/v1",
    version,
    sourceCommit,
    architecture,
    files: criticalFiles,
  });
  await writeJsonExclusive(path.join(destination, "Contents/Resources/build.json"), {
    format: "openbot.macos-worker-host-build/v1",
    version,
    buildVersion,
    sourceCommit,
    architecture,
    nodeVersion: "22.22.2",
    signed: false,
  });
  await validateMacOSWorkerHostApplication(destination, { expectedOwner: process.getuid?.() });
  return destination;
}

export async function validateMacOSWorkerHostApplication(
  applicationPath,
  {
    expectedOwner,
    allowDistributionArtifacts = false,
    expectedSigned = allowDistributionArtifacts,
  } = {},
) {
  const root = path.resolve(applicationPath);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("macOS application root must be a real directory.");
  }
  const files = await listApplicationFiles(root);
  const expected = allowDistributionArtifacts
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

  const manifest = JSON.parse(
    await readFile(path.join(root, "Contents/Resources/manifest.json"), "utf8"),
  );
  assertRuntimeManifestShape(manifest);
  for (const record of manifest.files) {
    if (
      record.sha256 !== (await sha256File(path.join(root, record.path))) ||
      record.size !== (await stat(path.join(root, record.path))).size
    ) {
      throw new Error("macOS application runtime manifest does not match its payload.");
    }
  }
  const build = JSON.parse(
    await readFile(path.join(root, "Contents/Resources/build.json"), "utf8"),
  );
  assertBuildMetadataShape(build);
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

export async function sealMacOSWorkerHostApplicationMetadata(applicationPath) {
  const root = path.resolve(applicationPath);
  const manifestPath = path.join(root, "Contents/Resources/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertRuntimeManifestShape(manifest);
  const files = [];
  for (const relativePath of MACOS_CRITICAL_FILES) {
    const filePath = path.join(root, relativePath);
    const metadata = await stat(filePath);
    files.push({
      path: relativePath,
      sha256: await sha256File(filePath),
      size: metadata.size,
      mode: relativePath.endsWith("/node") ? "0755" : "0644",
    });
  }
  await replaceJsonFile(manifestPath, { ...manifest, files });

  const buildPath = path.join(root, "Contents/Resources/build.json");
  const build = JSON.parse(await readFile(buildPath, "utf8"));
  assertBuildMetadataShape(build);
  await replaceJsonFile(buildPath, { ...build, signed: true });
}

export function expandEntitlementsTemplate(source, accessGroup) {
  const teamId = assertMacOSAccessGroup(accessGroup).slice(0, 10);
  const applicationIdentifier = `${teamId}.com.openbot.worker-host`;
  if (
    count(source, "OPENBOT_ACCESS_GROUP") !== 1 ||
    count(source, "OPENBOT_APPLICATION_IDENTIFIER") !== 1 ||
    count(source, "OPENBOT_TEAM_ID") !== 1
  ) {
    throw new Error("macOS entitlement template placeholder is invalid.");
  }
  const expanded = source
    .replace("OPENBOT_ACCESS_GROUP", accessGroup)
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
}) {
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

async function assertInputFile(filePath, bounds) {
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

async function copyChecked(source, root, relativePath, mode = 0o644) {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
  await chmod(destination, mode);
}

async function writeExclusive(destination, source) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, source, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

async function writeJsonExclusive(destination, value) {
  await writeExclusive(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function replaceJsonFile(destination, value) {
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
  await assertAbsent(replacement);
  await writeJsonExclusive(replacement, value);
  await rename(replacement, destination);
}

function assertRuntimeManifestShape(manifest) {
  if (
    manifest?.format !== "openbot.macos-worker-host-manifest/v1" ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["architecture", "files", "format", "sourceCommit", "version"]) ||
    assertReleaseVersion(manifest.version) !== manifest.version ||
    assertSourceCommit(manifest.sourceCommit) !== manifest.sourceCommit ||
    assertMacOSArchitecture(manifest.architecture) !== manifest.architecture ||
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files.map((record) => record?.path)) !==
      JSON.stringify(MACOS_CRITICAL_FILES)
  ) {
    throw new Error("macOS application runtime manifest is invalid.");
  }
  for (const record of manifest.files) {
    const executable = record.path.endsWith("/node");
    if (
      JSON.stringify(Object.keys(record).sort()) !==
        JSON.stringify(["mode", "path", "sha256", "size"]) ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      !Number.isSafeInteger(record.size) ||
      record.size < 1 ||
      record.size > (executable ? 128 * 1024 * 1024 : 16 * 1024 * 1024) ||
      record.mode !== (executable ? "0755" : "0644")
    ) {
      throw new Error("macOS application runtime manifest is invalid.");
    }
  }
}

function assertBuildMetadataShape(build) {
  if (
    build?.format !== "openbot.macos-worker-host-build/v1" ||
    JSON.stringify(Object.keys(build).sort()) !==
      JSON.stringify([
        "architecture",
        "buildVersion",
        "format",
        "nodeVersion",
        "signed",
        "sourceCommit",
        "version",
      ]) ||
    assertReleaseVersion(build.version) !== build.version ||
    assertMacOSBuildVersion(build.buildVersion) !== build.buildVersion ||
    assertSourceCommit(build.sourceCommit) !== build.sourceCommit ||
    assertMacOSArchitecture(build.architecture) !== build.architecture ||
    build.nodeVersion !== "22.22.2" ||
    typeof build.signed !== "boolean"
  ) {
    throw new Error("macOS application build metadata is invalid.");
  }
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("macOS staging destination already exists.");
}

async function listApplicationFiles(root) {
  const result = [];
  const visit = async (directory, prefix) => {
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

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function count(source, fragment) {
  return source.split(fragment).length - 1;
}

export function inspectMachOArchitecture(filePath) {
  const output = execFileSync("/usr/bin/lipo", ["-archs", filePath], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const architectures = output.split(/\s+/).sort();
  if (architectures.length !== 1) {
    throw new Error("macOS candidate inputs must be single-architecture Mach-O files.");
  }
  return architectures[0] === "x86_64" ? "x64" : architectures[0];
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
