import { macosSigningOptions, verifyNotarizedDesktop } from "./macos-signing.mjs";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listPackage } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { Arch, build, Platform } from "electron-builder";
import {
  DESKTOP_INSTALLER_FORMAT,
  hashInstaller,
  installerConfig,
  installerFileNames,
  installerTarget,
  validateInstallerVersion,
  verifyInstallerManifest,
} from "./installer-policy.mjs";
import {
  createDesktopFuseConfig,
  packagedAsarPath,
  packagedElectronTarget,
  validateDesktopAsarEntries,
} from "./package-policy.mjs";

if (process.argv.length !== 2) throw new Error("Installer creation takes no positional arguments.");
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const version = validateInstallerVersion(manifest.version);
const { platform, arch } = process;
const signing = macosSigningOptions(process.env, platform);
const target = installerTarget(platform, arch);
const bundle = join(appRoot, "out", `OpenBot-${platform}-${arch}`);
const outputDirectory = join(appRoot, "out", "installers", `${platform}-${arch}`);
const sourceCommit = process.env.GITHUB_SHA ?? null;
if (sourceCommit !== null && !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
  throw new Error("GitHub source commit must be a full commit id.");
}
await mkdir(outputDirectory, { recursive: true });
const asarPath = packagedAsarPath(bundle, platform);
const binary = packagedElectronTarget(bundle, platform);
validateDesktopAsarEntries(listPackage(asarPath, { isPack: false }));
const asarBefore = await hashInstaller(asarPath);
const expectedFuses = createDesktopFuseConfig(platform, arch);
async function verifyFuses(target = binary) {
  const actual = await getCurrentFuseWire(target);
  for (const index of Object.values(FuseV1Options).filter((value) => typeof value === "number")) {
    if (actual[index] !== (expectedFuses[index] ? FuseState.ENABLE : FuseState.DISABLE)) {
      throw new Error(`Desktop fuse ${FuseV1Options[index]} changed during installer creation.`);
    }
  }
}
await verifyFuses();
if (signing) await verifyNotarizedDesktop(join(bundle, "OpenBot.app"));
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
await build({
  projectDir: appRoot,
  prepackaged: platform === "darwin" ? join(bundle, "OpenBot.app") : bundle,
  targets: Platform.fromString(target.builderPlatform).createTarget(target.targets, Arch[arch]),
  publish: "never",
  config: installerConfig({ appRoot, outputDirectory, version, platform, arch }),
});
await verifyFuses();
if ((await hashInstaller(asarPath)).sha256 !== asarBefore.sha256) {
  throw new Error("Installer creation modified the reviewed ASAR.");
}
if (platform === "darwin") {
  const run = promisify(execFile);
  const dmg = join(outputDirectory, installerFileNames(version, platform, arch)[0]);
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
      await access(join(resources, "native-runtime", "python-control.json"));
    } else {
      try {
        await access(join(resources, "native-runtime"));
        throw new Error("Remote-only Desktop must not bundle a local service.");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await access(join(resources, "LICENSE"));
    await access(join(resources, "LICENSES.chromium.html"));
    if ((await hashInstaller(join(resources, "app.asar"))).sha256 !== asarBefore.sha256) {
      throw new Error("The DMG does not contain the verified application at its installable root.");
    }
    await verifyFuses(application);
    if (signing) await verifyNotarizedDesktop(application);
  } finally {
    // Do not recursively remove a still-mounted image if detaching fails.
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mount, "-quiet"], { timeout: 30_000 });
    await rm(mount, { recursive: true, force: true });
  }
}
const files = await Promise.all(
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
console.info(`Created verified Desktop ${version} installers in ${outputDirectory}`);
