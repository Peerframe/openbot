import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { FuseConfig } from "@electron/fuses";
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
export type DesktopIdentity = {
  readonly name: string;
  readonly appBundleId: string;
  readonly executableName: string;
};
const ALLOWED_PACKAGE_ROOTS: ReadonlySet<string> = new Set(["dist"]);
const ALLOWED_PACKAGE_FILES: ReadonlySet<string> = new Set(["package.json"]);
export const DESKTOP_RUNTIME_DEPENDENCIES = Object.freeze({
  postgres: "3.4.9",
  "signal-exit": "4.1.0",
  "write-file-atomic": "8.0.0",
});
/** Derived from the pin table; insertion order is retained. */
const ALLOWED_RUNTIME_DEPENDENCY_ROOTS: readonly string[] = Object.freeze(
  Object.keys(DESKTOP_RUNTIME_DEPENDENCIES).map((name) => `node_modules/${name}`),
);
export const REQUIRED_DESKTOP_ASAR_ENTRIES = Object.freeze([
  "/dist/main.js",
  "/dist/preload.cjs",
  "/dist/renderer/index.html",
  "/node_modules/postgres/package.json",
  "/node_modules/postgres/src/index.js",
  "/node_modules/signal-exit/dist/cjs/index.js",
  "/node_modules/signal-exit/package.json",
  "/node_modules/write-file-atomic/lib/index.js",
  "/node_modules/write-file-atomic/package.json",
  "/package.json",
] as const);
export const DESKTOP_WINDOWS_METADATA = Object.freeze({ CompanyName: "OpenBot contributors" });
export const DESKTOP_ICON_RESOURCE_NAME = "openbot-icon.png";
export const DESKTOP_MACOS_WORKER_COMPANION_NAME = "OpenBot Worker Host.app";
export const DESKTOP_PACKAGE_IDENTITY: DesktopIdentity = Object.freeze({
  name: "OpenBot",
  appBundleId: "dev.openbot.desktop",
  executableName: "openbot",
});
export const DESKTOP_PREVIEW_IDENTITY: DesktopIdentity = Object.freeze({
  name: "OpenBot Preview",
  appBundleId: "dev.openbot.desktop.preview",
  executableName: "OpenBot Preview",
});
// Canonical app may still own legacy Preview profile after upgrade.
export const DESKTOP_PYTHON_PREVIEW_IDENTITY: DesktopIdentity = Object.freeze({
  name: "OpenBot Python Preview",
  appBundleId: "dev.openbot.desktop.python-preview",
  executableName: "OpenBot Python Preview",
});
export const DESKTOP_TS_PREVIEW_IDENTITY: DesktopIdentity = Object.freeze({
  name: "OpenBot TS Preview",
  appBundleId: "dev.openbot.desktop.ts-preview",
  executableName: "OpenBot TS Preview",
});
export function desktopPackageIdentity(args: readonly unknown[]): DesktopIdentity {
  if (args.length === 0 || (args.length === 1 && args[0] === "--ts-product"))
    return DESKTOP_PACKAGE_IDENTITY;
  if (args.length === 1 && args[0] === "--preview") return DESKTOP_PREVIEW_IDENTITY;
  if (args.length === 2 && args.includes("--preview") && args.includes("--python-product"))
    return DESKTOP_PYTHON_PREVIEW_IDENTITY;
  if (args.length === 2 && args.includes("--preview") && args.includes("--ts-product"))
    return DESKTOP_TS_PREVIEW_IDENTITY;
  throw new Error(
    "Desktop packaging accepts only --ts-product or --preview with optional --python-product or --ts-product.",
  );
}
/** Accepts only the exact identity constants by reference; copies are refused. */
export function desktopPackagedManifest<T extends object>(
  manifest: T,
  identity: unknown,
): T | (T & { name: string; productName: string }) {
  if (identity === DESKTOP_PACKAGE_IDENTITY) return manifest;
  // Electron resolves name before main, isolating profile and instance lock.
  if (identity === DESKTOP_PREVIEW_IDENTITY)
    return { ...manifest, name: "openbot-preview", productName: DESKTOP_PREVIEW_IDENTITY.name };
  if (identity === DESKTOP_PYTHON_PREVIEW_IDENTITY)
    return {
      ...manifest,
      name: "openbot-python-preview",
      productName: DESKTOP_PYTHON_PREVIEW_IDENTITY.name,
    };
  if (identity === DESKTOP_TS_PREVIEW_IDENTITY)
    return {
      ...manifest,
      name: "openbot-ts-preview",
      productName: DESKTOP_TS_PREVIEW_IDENTITY.name,
    };
  throw new Error("Desktop package identity is invalid.");
}
export function packagedDesktopResource(
  bundlePath: string,
  platform: string,
  resourceName: string,
  identity: DesktopIdentity = DESKTOP_PACKAGE_IDENTITY,
): string {
  if (platform === "darwin")
    return join(bundlePath, `${identity.name}.app`, "Contents", "Resources", resourceName);
  if (platform === "win32" || platform === "linux")
    return join(bundlePath, "resources", resourceName);
  throw new Error(`Unsupported Desktop package platform: ${platform}`);
}
export function desktopMacOSWorkerCompanionSource(
  input: unknown,
  platform: string,
  identity: DesktopIdentity = DESKTOP_PACKAGE_IDENTITY,
): string | undefined {
  if (input === undefined || input === "") return undefined;
  if (
    identity === DESKTOP_PREVIEW_IDENTITY ||
    identity === DESKTOP_PYTHON_PREVIEW_IDENTITY ||
    identity === DESKTOP_TS_PREVIEW_IDENTITY
  )
    throw new Error("Desktop Preview cannot include the production Worker companion.");
  if (
    platform !== "darwin" ||
    typeof input !== "string" ||
    input.length > 4096 ||
    !isAbsolute(input) ||
    basename(input) !== DESKTOP_MACOS_WORKER_COMPANION_NAME ||
    /[\0\r\n]/u.test(input)
  )
    throw new Error("Desktop macOS Worker companion source is invalid.");
  return input;
}
export function packagedDesktopMacOSWorkerCompanion(
  bundlePath: string,
  platform: string,
  identity: DesktopIdentity = DESKTOP_PACKAGE_IDENTITY,
): string | undefined {
  if (platform !== "darwin") return undefined;
  return packagedDesktopResource(
    bundlePath,
    platform,
    DESKTOP_MACOS_WORKER_COMPANION_NAME,
    identity,
  );
}
const isAllowedDependencyPath = (candidate: string, prefix: string): boolean =>
  ALLOWED_RUNTIME_DEPENDENCY_ROOTS.some(
    (root) => candidate === `${prefix}${root}` || candidate.startsWith(`${prefix}${root}/`),
  );
export function shouldIgnoreDesktopSource(appRoot: string, candidatePath: string): boolean {
  const platformCandidate =
    candidatePath === appRoot
      ? ""
      : isAbsolute(candidatePath) && candidatePath.startsWith(`${appRoot}${sep}`)
        ? relative(appRoot, candidatePath)
        : candidatePath.replace(/^[/\\]+/u, "");
  const candidate = platformCandidate.replaceAll("\\", "/");
  if (candidate === "") return false;
  const segments = candidate.split("/");
  if (segments.includes("..")) return true;
  if (ALLOWED_PACKAGE_FILES.has(candidate)) return false;
  if (isAllowedDependencyPath(candidate, "")) return false;
  return !ALLOWED_PACKAGE_ROOTS.has(segments[0] ?? "");
}
export function validateDesktopAsarEntries(entries: readonly string[]): void {
  const retained = new Set(
    entries.map((entry) => {
      const normalized = entry.replaceAll("\\", "/");
      return normalized.startsWith("/") ? normalized : `/${normalized}`;
    }),
  );
  for (const required of REQUIRED_DESKTOP_ASAR_ENTRIES) {
    if (!retained.has(required)) throw new Error(`Packaged Desktop ASAR is missing ${required}.`);
  }
  for (const entry of retained) {
    if (!entry.startsWith("/node_modules/")) continue;
    if (!isAllowedDependencyPath(entry, "/"))
      throw new Error(`Packaged Desktop ASAR contains unexpected dependency ${entry}.`);
  }
}
export function packagedElectronTarget(
  bundlePath: string,
  platform: string,
  identity: DesktopIdentity = DESKTOP_PACKAGE_IDENTITY,
): string {
  if (platform === "darwin") return join(bundlePath, `${identity.name}.app`);
  if (platform === "win32") return join(bundlePath, `${identity.executableName}.exe`);
  if (platform === "linux") return join(bundlePath, identity.executableName);
  throw new Error(`Unsupported Desktop package platform: ${platform}`);
}
export function packagedAsarPath(
  bundlePath: string,
  platform: string,
  identity: DesktopIdentity = DESKTOP_PACKAGE_IDENTITY,
): string {
  return packagedDesktopResource(bundlePath, platform, "app.asar", identity);
}
export function createDesktopFuseConfig(platform: string, arch: string) {
  return {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === "darwin" && arch === "arm64",
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // No custom browser_v8_context_snapshot.bin shipped by this package.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: false,
  } satisfies FuseConfig<boolean>;
}
/** Every numeric FuseV1Options member the installed library defines; no second fuse table. */
const FUSE_INDEXES: readonly FuseV1Options[] = Object.freeze(
  Object.values(FuseV1Options).filter((value): value is FuseV1Options => typeof value === "number"),
);
/** Read-only native comparison: no flipping, signing or download happens here. */
export async function verifyDesktopFuses(
  target: string,
  platform: string,
  arch: string,
): Promise<void> {
  const expected: Readonly<Record<FuseV1Options, boolean>> = createDesktopFuseConfig(
    platform,
    arch,
  );
  const actual: Readonly<Partial<Record<FuseV1Options, FuseState>>> =
    await getCurrentFuseWire(target);
  for (const index of FUSE_INDEXES) {
    const expectedState = expected[index] ? FuseState.ENABLE : FuseState.DISABLE;
    if (actual[index] !== expectedState)
      throw new Error(`Packaged Desktop fuse ${FuseV1Options[index]} did not match policy.`);
  }
}
