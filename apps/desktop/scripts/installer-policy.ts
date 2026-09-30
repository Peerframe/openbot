import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
export const DESKTOP_INSTALLER_FORMAT = "openbot.desktop-installers/v1";
type InstallerTarget = {
  readonly builderPlatform: "mac" | "win" | "linux";
  readonly targets: readonly string[];
  readonly extensions: readonly string[];
};
export const DESKTOP_INSTALLER_TARGETS = Object.freeze({
  "darwin-arm64": { builderPlatform: "mac", targets: ["dmg"], extensions: ["dmg"] },
  "win32-x64": { builderPlatform: "win", targets: ["nsis"], extensions: ["exe"] },
  "linux-x64": {
    builderPlatform: "linux",
    targets: ["AppImage", "deb"],
    extensions: ["AppImage", "deb"],
  },
} as const satisfies Record<string, InstallerTarget>);
export type DesktopTargetName = keyof typeof DESKTOP_INSTALLER_TARGETS;
export const isDesktopTargetName = (value: unknown): value is DesktopTargetName =>
  typeof value === "string" && Object.hasOwn(DESKTOP_INSTALLER_TARGETS, value);
/** Reviewed release order comes from the target table's insertion order. */
export const DESKTOP_INSTALLER_TARGET_NAMES: readonly DesktopTargetName[] = Object.freeze(
  Object.keys(DESKTOP_INSTALLER_TARGETS).filter(isDesktopTargetName),
);
export function installerTarget(platform: unknown, arch: unknown): InstallerTarget {
  const name = `${String(platform)}-${String(arch)}`;
  if (!isDesktopTargetName(name))
    throw new Error("Desktop installers support only the three reviewed native targets.");
  return DESKTOP_INSTALLER_TARGETS[name];
}
export function validateInstallerVersion(version: unknown): string {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u.test(version))
    throw new Error("Use a numeric Desktop version with an optional alpha, beta, or rc suffix.");
  if (version === "0.0.0")
    throw new Error("Installers require a version beyond the source placeholder.");
  return version;
}
export function installerFileNames(version: unknown, platform: unknown, arch: unknown): string[] {
  const checked = validateInstallerVersion(version);
  return installerTarget(platform, arch).extensions.map(
    (extension) => `openbot-desktop-${checked}-${String(platform)}-${String(arch)}.${extension}`,
  );
}
type InstallerConfigInput = {
  readonly appRoot: string;
  readonly outputDirectory: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly electronVersion: string;
};
export function installerConfig(input: InstallerConfigInput) {
  const { appRoot, outputDirectory, version, platform, arch, electronVersion } = input;
  installerTarget(platform, arch);
  validateInstallerVersion(version);
  if (typeof electronVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(electronVersion))
    throw new Error("Installers require the exact pinned Electron version.");
  return {
    extends: null,
    appId: "dev.openbot.desktop",
    productName: "OpenBot",
    electronVersion,
    artifactName: `openbot-desktop-${version}-${platform}-${arch}.\${ext}`,
    directories: {
      app: appRoot,
      buildResources: join(appRoot, "resources"),
      output: outputDirectory,
    },
    extraMetadata: { version, productName: "OpenBot" },
    publish: null,
    npmRebuild: false,
    // Existing Packager output has ASAR integrity and verified Electron fuses.
    // prepackaged bypasses builder packaging/signing; no automatic certificate discovery.
    mac: {
      identity: null,
      icon: "openbot-icon.icns",
      category: "public.app-category.productivity",
    },
    dmg: { sign: false },
    win: { executableName: "openbot", icon: "openbot-icon.ico", signAndEditExecutable: false },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
      packElevateHelper: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: "OpenBot",
    },
    linux: {
      executableName: "openbot",
      icon: "openbot-icon.png",
      category: "Office",
      maintainer: "OpenBot contributors",
      synopsis: "Self-hosted digital employee workspace",
    },
  } satisfies Configuration;
}
export type InstallerFile = {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
};
export type InstallerManifest = {
  readonly format: typeof DESKTOP_INSTALLER_FORMAT;
  readonly signing: "unsigned-development" | "developer-id-notarized";
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly sourceCommit: string | null;
  readonly files: readonly InstallerFile[];
  readonly [extra: string]: unknown;
};
type ExpectedManifestFields = { readonly version?: string; readonly sourceCommit?: string | null };
const SHA1_HEX = /^[a-f0-9]{40}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isInstallerFile = (value: unknown): value is InstallerFile =>
  isRecord(value) &&
  typeof value.name === "string" &&
  value.name.length > 0 &&
  typeof value.bytes === "number" &&
  Number.isSafeInteger(value.bytes) &&
  value.bytes > 0 &&
  typeof value.sha256 === "string" &&
  SHA256_HEX.test(value.sha256);
function isInstallerManifest(value: unknown): value is InstallerManifest {
  if (!isRecord(value)) return false;
  const { format, signing, platform, arch, version, sourceCommit, files } = value;
  return (
    format === DESKTOP_INSTALLER_FORMAT &&
    (signing === "unsigned-development" ||
      (signing === "developer-id-notarized" && platform === "darwin")) &&
    typeof version === "string" &&
    typeof platform === "string" &&
    typeof arch === "string" &&
    (sourceCommit === null || (typeof sourceCommit === "string" && SHA1_HEX.test(sourceCommit))) &&
    Array.isArray(files) &&
    files.every(isInstallerFile)
  );
}
export async function hashInstaller(path: string): Promise<{ bytes: number; sha256: string }> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 2 * 1024 ** 3)
    throw new Error("Installer must be a regular file between one byte and two GiB.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: stat.size, sha256: hash.digest("hex") };
}
export async function verifyInstallerManifest(
  directory: string,
  expected: ExpectedManifestFields = {},
): Promise<InstallerManifest> {
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.nlink !== 1 || manifestStat.size > 16384)
    throw new Error("Installer manifest must be a bounded regular file.");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isInstallerManifest(manifest)) throw new Error("Invalid installer manifest.");
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) throw new Error(`Installer ${key} did not match the release.`);
  }
  const names = installerFileNames(manifest.version, manifest.platform, manifest.arch);
  if (manifest.files.length !== names.length) throw new Error("Installer set is incomplete.");
  for (const name of names) {
    const entries = manifest.files.filter((entry) => entry.name === name);
    const [entry] = entries;
    if (entries.length !== 1 || !entry) throw new Error("Missing or duplicate installer asset.");
    const actual = await hashInstaller(join(directory, name));
    if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256)
      throw new Error("Installer checksum or size did not match its manifest.");
  }
  return manifest;
}
