/** Builds installers and verifies the mounted application against its packaged runtime. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listPackage } from "@electron/asar";
import { Arch, build, Platform } from "electron-builder";
import {
  DESKTOP_INSTALLER_FORMAT,
  hashInstaller,
  type InstallerFile,
  installerConfig,
  installerFileNames,
  installerTarget,
  validateInstallerVersion,
  verifyInstallerManifest,
} from "./installer-policy.ts";
import { macosSigningOptions, verifyNotarizedDesktop } from "./macos-signing.ts";
import {
  packagedAsarPath,
  packagedElectronTarget,
  validateDesktopAsarEntries,
  verifyDesktopFuses,
} from "./package-policy.ts";

import { preparePackageIcons } from "./generate-icons.ts";
import { verifyProductCandidate } from "./verify-product.ts";

const run = promisify(execFile);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type InstallerRun = {
  readonly generatedIcons: boolean;
  readonly version: string;
  readonly electronVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly signing: ReturnType<typeof macosSigningOptions>;
  readonly target: ReturnType<typeof installerTarget>;
  readonly bundle: string;
  readonly asarPath: string;
  readonly binary: string;
  readonly outputDirectory: string;
  readonly sourceCommit: string | null;
};

function readDesktopManifest(manifest: unknown): { version: string; electronVersion: string } {
  const isObject = manifest !== null && typeof manifest === "object";
  const version = validateInstallerVersion(
    isObject && "version" in manifest ? manifest.version : undefined,
  );
  const dependencies: unknown =
    isObject && "devDependencies" in manifest ? manifest.devDependencies : undefined;
  const electronVersion: unknown =
    dependencies !== null && typeof dependencies === "object" && "electron" in dependencies
      ? dependencies.electron
      : undefined;
  // installerConfig owns the exact pinned-version check; this only narrows the type.
  if (typeof electronVersion !== "string")
    throw new Error("Installers require the exact pinned Electron version.");
  return { version, electronVersion };
}

export function installerSourceCommit(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const sourceCommit = env.GITHUB_SHA ?? null;
  if (sourceCommit !== null && !/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw new Error("GitHub source commit must be a full commit id.");
  return sourceCommit;
}

function builderArch(arch: string): Arch {
  // installerTarget has already admitted only arm64 and x64 targets.
  if (arch === "arm64") return Arch.arm64;
  if (arch === "x64") return Arch.x64;
  throw new Error("Desktop installers support only the three reviewed native targets.");
}

async function prepareInstallerRun(): Promise<InstallerRun> {
  const generatedIcons = await preparePackageIcons();
  const manifest: unknown = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  const { version, electronVersion } = readDesktopManifest(manifest);
  const { platform, arch } = process;
  const signing = macosSigningOptions(process.env, platform);
  const target = installerTarget(platform, arch);
  const bundle = join(appRoot, "out", `OpenBot-${platform}-${arch}`);
  const outputDirectory = join(appRoot, "out", "installers", `${platform}-${arch}`);
  const sourceCommit = installerSourceCommit(process.env);
  await mkdir(outputDirectory, { recursive: true });
  return {
    generatedIcons,
    version,
    electronVersion,
    platform,
    arch,
    signing,
    target,
    bundle,
    asarPath: packagedAsarPath(bundle, platform),
    binary: packagedElectronTarget(bundle, platform),
    outputDirectory,
    sourceCommit,
  };
}

/** The mount belongs to this verification; failed detach must leave it intact. */
async function verifyMountedDmg(installer: InstallerRun, asarSha256: string): Promise<void> {
  const { version, platform, arch, signing, outputDirectory } = installer;
  const [dmgName] = installerFileNames(version, platform, arch);
  if (dmgName === undefined) throw new Error("Installer set is incomplete.");
  const dmg = join(outputDirectory, dmgName);
  const mount = await mkdtemp(join(tmpdir(), "openbot-installer-check-"));
  let mounted = false;
  try {
    await run("/usr/bin/hdiutil", ["verify", dmg], { timeout: 120_000 });
    await run(
      "/usr/bin/hdiutil",
      ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount, "-quiet"],
      { timeout: 120_000 },
    );
    mounted = true;
    const application = join(mount, "OpenBot.app");
    const resources = join(application, "Contents", "Resources");
    await access(join(application, "Contents", "MacOS", "OpenBot"), constants.X_OK);
    if (arch === "arm64") {
      await access(
        join(resources, "native-runtime", "postgres", "bin", "postgres"),
        constants.X_OK,
      );
      await access(join(resources, "native-runtime", "node", "bin", "node"), constants.X_OK);
      await verifyProductCandidate(application);
    } else {
      try {
        await access(join(resources, "native-runtime"));
        throw new Error("Remote-only Desktop must not bundle a local service.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    await access(join(resources, "LICENSE"));
    await access(join(resources, "LICENSES.chromium.html"));
    if ((await hashInstaller(join(resources, "app.asar"))).sha256 !== asarSha256) {
      throw new Error("The DMG does not contain the verified application at its installable root.");
    }
    await verifyDesktopFuses(application, platform, arch);
    if (signing) await verifyNotarizedDesktop(application);
  } finally {
    // Do not recursively remove a still-mounted image if detaching fails.
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mount, "-quiet"], { timeout: 30_000 });
    await rm(mount, { recursive: true, force: true });
  }
}

async function writeReceipts(installer: InstallerRun): Promise<void> {
  const { version, platform, arch, sourceCommit, signing, outputDirectory } = installer;
  const files: InstallerFile[] = await Promise.all(
    installerFileNames(version, platform, arch).map(async (name) => ({
      name,
      ...(await hashInstaller(join(outputDirectory, name))),
    })),
  );
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        format: DESKTOP_INSTALLER_FORMAT,
        version,
        platform,
        arch,
        sourceCommit,
        signing: signing ? "developer-id-notarized" : "unsigned-development",
        files,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
  );
  await verifyInstallerManifest(outputDirectory, { version, sourceCommit });
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      `OPENBOT_INSTALLER_DIRECTORY=${outputDirectory}\nOPENBOT_INSTALLER_ARTIFACT=openbot-installers-${platform}-${arch}-${sourceCommit}\n`,
    );
  }
}

export async function makeInstallers(argv: readonly string[]): Promise<void> {
  if (argv.length !== 2) throw new Error("Installer creation takes no positional arguments.");
  const installer = await prepareInstallerRun();
  const {
    asarPath,
    binary,
    bundle,
    platform,
    arch,
    signing,
    target,
    version,
    electronVersion,
    outputDirectory,
  } = installer;
  validateDesktopAsarEntries(listPackage(asarPath, { isPack: false }));
  const asarBefore = await hashInstaller(asarPath);
  await verifyDesktopFuses(binary, platform, arch);
  if (signing) await verifyNotarizedDesktop(join(bundle, "OpenBot.app"));
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  await build({
    projectDir: appRoot,
    prepackaged: platform === "darwin" ? join(bundle, "OpenBot.app") : bundle,
    targets: Platform.fromString(target.builderPlatform).createTarget(
      [...target.targets],
      builderArch(arch),
    ),
    publish: "never",
    config: installerConfig({
      appRoot,
      outputDirectory,
      version,
      platform,
      arch,
      electronVersion,
      generatedIcons: installer.generatedIcons,
    }),
  });
  await verifyDesktopFuses(binary, platform, arch);
  if ((await hashInstaller(asarPath)).sha256 !== asarBefore.sha256) {
    throw new Error("Installer creation modified the reviewed ASAR.");
  }
  if (platform === "darwin") await verifyMountedDmg(installer, asarBefore.sha256);
  await writeReceipts(installer);
  console.info(`Created verified Desktop ${version} installers in ${outputDirectory}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeInstallers(process.argv);
}
