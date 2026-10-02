import { realpathSync } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listPackage } from "@electron/asar";
import { flipFuses } from "@electron/fuses";
import { packager } from "@electron/packager";
import { validateMacOSWorkerHostApplication } from "../../../scripts/macos-worker-host-release.ts";
import { createElectronDownloader } from "./electron-download.ts";
import { macosSigningOptions, verifyNotarizedDesktop } from "./macos-signing.ts";
import {
  createDesktopFuseConfig,
  DESKTOP_ICON_RESOURCE_NAME,
  DESKTOP_PREVIEW_IDENTITY,
  DESKTOP_PYTHON_PREVIEW_IDENTITY,
  DESKTOP_RUNTIME_DEPENDENCIES,
  DESKTOP_WINDOWS_METADATA,
  desktopMacOSWorkerCompanionSource,
  desktopPackagedManifest,
  desktopPackageIdentity,
  packagedAsarPath,
  packagedDesktopMacOSWorkerCompanion,
  packagedDesktopResource,
  packagedElectronTarget,
  shouldIgnoreDesktopSource,
  validateDesktopAsarEntries,
  verifyDesktopFuses,
} from "./package-policy.ts";
import { copyContainedResource } from "./package-resources.ts";
import { preparePackageIcons } from "./generate-icons.ts";
import { PYTHON_CANDIDATE } from "./python-runtime.ts";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(appRoot, "..", "..");
export function parseDesktopPackageArguments(
  args: readonly string[],
  platform: string = process.platform,
  arch: string = process.arch,
) {
  const pythonProduct = args.includes("--python-product");
  if (args.filter((argument) => argument === "--python-product").length > 1)
    throw new Error("Python product candidate must be selected once.");
  const identity = desktopPackageIdentity(args);
  const preview =
    identity === DESKTOP_PREVIEW_IDENTITY || identity === DESKTOP_PYTHON_PREVIEW_IDENTITY;
  if (
    pythonProduct &&
    (identity !== DESKTOP_PYTHON_PREVIEW_IDENTITY || platform !== "darwin" || arch !== "arm64")
  )
    throw new Error("Python product packaging requires the macOS arm64 Preview candidate.");
  return { pythonProduct, identity, preview };
}

export async function packageDesktop(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const { pythonProduct, identity, preview } = parseDesktopPackageArguments(args);
  const platform = packagePlatform(process.platform);
  const arch = packageArchitecture(process.arch);
  const signing = macosSigningOptions(process.env, process.platform, preview);
  const rendererEntry = join(appRoot, "dist", "renderer", "index.html");
  const nativeRuntime =
    process.platform === "darwin" && process.arch === "arm64"
      ? join(appRoot, pythonProduct ? "out/python-product-runtime" : "native-runtime")
      : undefined;
  const generatedIcons = await preparePackageIcons();
  const desktopIconBase = generatedIcons
    ? join(appRoot, "out", "icons", "openbot-icon")
    : join(appRoot, "resources", "openbot-icon");
  const desktopIconPng =
    generatedIcons && platform === "linux"
      ? join(appRoot, "out", "icons", "linux", "openbot-icon.png")
      : `${desktopIconBase}.png`;
  const packageManifest = await readManifest(join(appRoot, "package.json"));
  const version = packageManifest.version;
  const dependencies = packageManifest.devDependencies;
  const electronVersion = isRecord(dependencies) ? dependencies.electron : undefined;
  if (typeof version !== "string" || typeof electronVersion !== "string")
    throw new Error("Desktop package manifest requires version and Electron version strings.");
  const previewDownload = preview
    ? {
        cacheRoot: join(appRoot, "out", "preview", ".electron-cache"),
        checksums: checksumMap(
          JSON.parse(
            await readFile(
              join(
                dirname(fileURLToPath(import.meta.resolve("electron/package.json"))),
                "checksums.json",
              ),
              "utf8",
            ),
          ),
        ),
      }
    : undefined;
  const workerCompanionSource = desktopMacOSWorkerCompanionSource(
    process.env.OPENBOT_DESKTOP_MACOS_WORKER_COMPANION,
    process.platform,
    identity,
  );

  await Promise.all([
    ...(nativeRuntime
      ? [
          access(join(nativeRuntime, "python-control.json")),
          ...(process.platform === "darwin"
            ? [access(join(nativeRuntime, "postgres-supervisor"))]
            : []),
          access(
            join(
              nativeRuntime,
              "postgres/bin",
              process.platform === "win32" ? "postgres.exe" : "postgres",
            ),
          ),
        ]
      : []),
    access(rendererEntry),
    access(desktopIconPng),
    access(`${desktopIconBase}.icns`),
    access(`${desktopIconBase}.ico`),
  ]);
  if (nativeRuntime) {
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(join(nativeRuntime, "python-control.json"), "utf8"));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (
      !isRecord(marker) ||
      Object.keys(marker).length !== Object.keys(PYTHON_CANDIDATE).length ||
      !Object.entries(PYTHON_CANDIDATE).every(([key, value]) => marker[key] === value)
    )
      throw new Error("Python candidate resources are incomplete or mismatched.");
  }
  if (workerCompanionSource !== undefined) {
    await validateMacOSWorkerHostApplication(workerCompanionSource, {
      expectedOwner: process.getuid?.(),
    });
  }

  const packagePaths = await packager({
    ...(signing ?? {}),
    appBundleId: identity.appBundleId,
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Record a voice attachment when you press the microphone button.",
    },
    appVersion: version,
    arch,
    asar: true,
    dir: appRoot,
    download: { ...previewDownload, downloader: createElectronDownloader() },
    electronVersion,
    extraResource: [desktopIconPng],
    afterCopyExtraResources: [
      async ({ buildPath }) => {
        await copyContainedResource(
          join(workspaceRoot, "licenses/runtime"),
          packagedDesktopResource(buildPath, process.platform, "runtime-notices", identity),
        );
        if (process.platform === "darwin") {
          // The DMG contains the app, not Packager's surrounding directory. Keep runtime notices
          // inside it, using the exact unpacked runtime rather than npm's optional local dist cache.
          for (const notice of ["LICENSE", "LICENSES.chromium.html"]) {
            await cp(
              join(buildPath, notice),
              packagedDesktopResource(buildPath, process.platform, notice, identity),
            );
          }
        }
        if (nativeRuntime) {
          await copyContainedResource(
            nativeRuntime,
            packagedDesktopResource(buildPath, process.platform, "native-runtime", identity),
          );
        }
        if (workerCompanionSource) {
          const companion = packagedDesktopMacOSWorkerCompanion(
            buildPath,
            process.platform,
            identity,
          );
          if (companion === undefined)
            throw new Error("Desktop package did not resolve its macOS Worker companion.");
          await copyContainedResource(workerCompanionSource, companion);
        }
        if (signing) {
          await flipFuses(
            packagedElectronTarget(buildPath, process.platform, identity),
            createDesktopFuseConfig(process.platform, process.arch),
          );
        }
      },
    ],
    afterCopy: [
      async ({ buildPath }) => {
        await stageDesktopRuntimeDependencies(buildPath);
        if (preview) {
          await writeFile(
            join(buildPath, "package.json"),
            `${JSON.stringify(desktopPackagedManifest(packageManifest, identity), null, 2)}\n`,
          );
        }
      },
    ],
    executableName: process.platform === "darwin" ? identity.name : identity.executableName,
    ignore: (candidatePath) => shouldIgnoreDesktopSource(appRoot, candidatePath),
    icon: desktopIconBase,
    name: identity.name,
    out: pythonProduct
      ? join(appRoot, "out", "python-product")
      : identity === DESKTOP_PREVIEW_IDENTITY
        ? join(appRoot, "out", "preview")
        : join(appRoot, "out"),
    overwrite: true,
    platform,
    prune: false,
    win32metadata: DESKTOP_WINDOWS_METADATA,
  });

  const [packagePath] = packagePaths;
  if (packagePaths.length !== 1 || packagePath === undefined) {
    throw new Error(`Expected one Desktop package, received ${packagePaths.length}.`);
  }

  const target = packagedElectronTarget(packagePath, process.platform, identity);
  const asarPath = packagedAsarPath(packagePath, process.platform, identity);
  validateDesktopAsarEntries(listPackage(asarPath, { isPack: false }));
  const expectedFuses = createDesktopFuseConfig(process.platform, process.arch);
  if (!signing) await flipFuses(target, expectedFuses);
  else await verifyNotarizedDesktop(join(packagePath, "OpenBot.app"));

  await access(
    packagedDesktopResource(packagePath, process.platform, DESKTOP_ICON_RESOURCE_NAME, identity),
  );

  await verifyDesktopFuses(target, process.platform, process.arch);

  const packagedWorkerCompanion = packagedDesktopMacOSWorkerCompanion(
    packagePath,
    process.platform,
    identity,
  );
  if (workerCompanionSource !== undefined) {
    if (packagedWorkerCompanion === undefined) {
      throw new Error("Desktop package did not resolve its macOS Worker companion.");
    }
    await validateMacOSWorkerHostApplication(packagedWorkerCompanion, {
      expectedOwner: process.getuid?.(),
    });
  } else if (packagedWorkerCompanion !== undefined) {
    try {
      await access(packagedWorkerCompanion);
      throw new Error("Desktop package contains an undeclared macOS Worker companion.");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  console.log(
    `Packaged ${signing ? "Developer ID notarized" : "unsigned development"} ${identity.name} artifact${
      workerCompanionSource === undefined ? " without" : " with"
    } the macOS Worker companion: ${packagePath}`,
  );
}

async function stageDesktopRuntimeDependencies(buildPath: string): Promise<void> {
  const destinationRoot = join(buildPath, "node_modules");
  await mkdir(destinationRoot, { recursive: true });
  for (const [name, expectedVersion] of Object.entries(DESKTOP_RUNTIME_DEPENDENCIES)) {
    const source = join(workspaceRoot, "node_modules", name);
    const manifest = await readManifest(join(source, "package.json"));
    if (manifest.name !== name || manifest.version !== expectedVersion) {
      throw new Error(`Desktop runtime dependency ${name} did not match ${expectedVersion}.`);
    }
    await cp(source, join(destinationRoot, name), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readManifest(filePath: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!isRecord(value)) throw new Error("Desktop package manifest must be an object.");
  return value;
}

function checksumMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Electron checksums must be a string map.");
  const result: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value)) {
    if (typeof hash !== "string") throw new Error("Electron checksums must be a string map.");
    Object.defineProperty(result, key, { value: hash, enumerable: true });
  }
  return result;
}

function packagePlatform(value: string): "darwin" | "linux" | "win32" {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`Unsupported Desktop package platform: ${value}`);
}

function packageArchitecture(value: string): "arm64" | "x64" | "ia32" | "armv7l" | "mips64el" {
  if (
    value === "arm64" ||
    value === "x64" ||
    value === "ia32" ||
    value === "armv7l" ||
    value === "mips64el"
  )
    return value;
  throw new Error(`Unsupported Desktop package architecture: ${value}`);
}

function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await packageDesktop();
}
