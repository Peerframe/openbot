import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, flipFuses, getCurrentFuseWire } from "@electron/fuses";
import { packager } from "@electron/packager";
import { validateMacOSWorkerHostApplication } from "../../../scripts/macos-worker-host-release.mjs";
import { createElectronDownloader } from "./electron-download.mjs";
import { macosSigningOptions, verifyNotarizedDesktop } from "./macos-signing.mjs";
import {
  createDesktopFuseConfig,
  DESKTOP_ICON_RESOURCE_NAME,
  DESKTOP_PREVIEW_IDENTITY,
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
} from "./package-policy.mjs";
import { copyContainedResource } from "./package-resources.mjs";
import { PYTHON_CANDIDATE } from "./python-runtime.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const pythonProduct = args.includes("--python-product");
if (args.filter((argument) => argument === "--python-product").length > 1)
  throw new Error("Python product candidate must be selected once.");
const identity = desktopPackageIdentity(args.filter((argument) => argument !== "--python-product"));
if (
  pythonProduct &&
  (identity !== DESKTOP_PREVIEW_IDENTITY ||
    process.platform !== "darwin" ||
    process.arch !== "arm64")
)
  throw new Error("Python product packaging requires the macOS arm64 Preview candidate.");
const signing = macosSigningOptions(
  process.env,
  process.platform,
  identity === DESKTOP_PREVIEW_IDENTITY,
);
const workspaceRoot = join(appRoot, "..", "..");
const rendererEntry = join(appRoot, "dist", "renderer", "index.html");
const nativeRuntime = ["darwin", "win32"].includes(process.platform)
  ? join(appRoot, pythonProduct ? "out/python-product-runtime" : "native-runtime")
  : undefined;
const desktopIconBase = join(appRoot, "resources", "openbot-icon");
const desktopIconPng = `${desktopIconBase}.png`;
const packageManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const previewDownload =
  identity === DESKTOP_PREVIEW_IDENTITY
    ? {
        cacheRoot: join(appRoot, "out", "preview", ".electron-cache"),
        checksums: JSON.parse(
          await readFile(
            join(
              dirname(fileURLToPath(import.meta.resolve("electron/package.json"))),
              "checksums.json",
            ),
            "utf8",
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
        access(
          join(nativeRuntime, pythonProduct ? "python-control.json" : "apps/server/dist/index.js"),
        ),
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
  let marker;
  try {
    marker = JSON.parse(await readFile(join(nativeRuntime, "python-control.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (pythonProduct) {
    if (
      !marker ||
      Object.keys(marker).length !== Object.keys(PYTHON_CANDIDATE).length ||
      !Object.entries(PYTHON_CANDIDATE).every(([key, value]) => marker[key] === value)
    )
      throw new Error("Python candidate resources are incomplete or mismatched.");
  } else if (marker !== undefined)
    throw new Error("Default Desktop packaging refuses Python candidate resources.");
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
    NSMicrophoneUsageDescription: "Record a voice attachment when you press the microphone button.",
  },
  appVersion: packageManifest.version,
  arch: process.arch,
  asar: true,
  dir: appRoot,
  download: { ...previewDownload, downloader: createElectronDownloader() },
  electronVersion: pythonProduct ? "44.3.0" : "44.2.0",
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
        await copyContainedResource(
          workerCompanionSource,
          packagedDesktopMacOSWorkerCompanion(buildPath, process.platform, identity),
        );
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
      if (identity === DESKTOP_PREVIEW_IDENTITY) {
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
  platform: process.platform,
  prune: false,
  win32metadata: DESKTOP_WINDOWS_METADATA,
});

if (packagePaths.length !== 1) {
  throw new Error(`Expected one Desktop package, received ${packagePaths.length}.`);
}

const target = packagedElectronTarget(packagePaths[0], process.platform, identity);
const asarPath = packagedAsarPath(packagePaths[0], process.platform, identity);
validateDesktopAsarEntries(listPackage(asarPath, { isPack: false }));
const expectedFuses = createDesktopFuseConfig(process.platform, process.arch);
if (!signing) await flipFuses(target, expectedFuses);
else await verifyNotarizedDesktop(join(packagePaths[0], "OpenBot.app"));

await access(
  packagedDesktopResource(packagePaths[0], process.platform, DESKTOP_ICON_RESOURCE_NAME, identity),
);

const actualFuses = await getCurrentFuseWire(target);
for (const fuseIndex of Object.values(FuseV1Options).filter((value) => typeof value === "number")) {
  const expectedState = expectedFuses[fuseIndex] ? FuseState.ENABLE : FuseState.DISABLE;
  if (actualFuses[fuseIndex] !== expectedState) {
    throw new Error(`Packaged Desktop fuse ${FuseV1Options[fuseIndex]} did not match policy.`);
  }
}

const packagedWorkerCompanion = packagedDesktopMacOSWorkerCompanion(
  packagePaths[0],
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
    if (error?.code !== "ENOENT") throw error;
  }
}

console.log(
  `Packaged ${signing ? "Developer ID notarized" : "unsigned development"} ${identity.name} artifact${
    workerCompanionSource === undefined ? " without" : " with"
  } the macOS Worker companion: ${packagePaths[0]}`,
);

async function stageDesktopRuntimeDependencies(buildPath) {
  const destinationRoot = join(buildPath, "node_modules");
  await mkdir(destinationRoot, { recursive: true });
  for (const [name, expectedVersion] of Object.entries(DESKTOP_RUNTIME_DEPENDENCIES)) {
    const source = join(workspaceRoot, "node_modules", name);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
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
