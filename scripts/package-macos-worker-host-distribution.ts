import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgumentPairs } from "./argument-pairs.ts";
import {
  assertMacOSAccessGroup,
  assertMacOSDeveloperIdentities,
  assertMacOSExtendedAttributes,
  distributionSigningPlan,
  expandEntitlementsTemplate,
  sealMacOSWorkerHostApplicationMetadata,
  validateMacOSProvisioningProfile,
  validateMacOSWorkerHostApplication,
} from "./macos-worker-host-release.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function packageMacOSWorkerHostDistribution(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS distribution packaging can only run on macOS.");
  }
  const options = parseMacOSDistributionArguments(arguments_);
  assertMacOSDeveloperIdentities(
    {
      applicationIdentity: options.applicationIdentity,
      installerIdentity: options.installerIdentity,
    },
    options.accessGroup,
  );
  await assertDistributionInput(options.provisioningProfile, {
    minimum: 1_024,
    maximum: 512 * 1_024,
  });
  await assertDistributionInput(options.entitlementsTemplate, {
    minimum: 256,
    maximum: 16 * 1_024,
  });
  await validateMacOSWorkerHostApplication(options.application, {
    expectedOwner: process.getuid?.(),
  });
  const plan = distributionSigningPlan({
    applicationPath: options.application,
    outputPackage: options.outputPackage,
    identities: {
      applicationIdentity: options.applicationIdentity,
      installerIdentity: options.installerIdentity,
    },
    notaryProfile: options.notaryProfile,
  });
  if (
    plan.map((step) => step.role).join(",") !==
    "node,seal-metadata,application,verify-application,package,verify-package,notarize,staple,gatekeeper"
  ) {
    throw new Error("macOS distribution signing order is invalid.");
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "openbot-macos-distribution-"));
  try {
    const decodedProfile = path.join(scratch, "provisioning-profile.plist");
    const decodedProfileJson = path.join(scratch, "provisioning-profile.json");
    run("/usr/bin/security", [
      "cms",
      "-D",
      "-i",
      options.provisioningProfile,
      "-o",
      decodedProfile,
    ]);
    run("/usr/bin/plutil", ["-convert", "json", "-o", decodedProfileJson, decodedProfile]);
    validateMacOSProvisioningProfile(JSON.parse(await readFile(decodedProfileJson, "utf8")), {
      accessGroup: options.accessGroup,
    });

    const application = path.join(scratch, "OpenBot Worker Host.app");
    run("/usr/bin/ditto", ["--noextattr", "--noqtn", "--norsrc", options.application, application]);
    run("/usr/bin/ditto", [
      "--noextattr",
      "--noqtn",
      "--norsrc",
      options.provisioningProfile,
      path.join(application, "Contents/embedded.provisionprofile"),
    ]);
    await chmod(path.join(application, "Contents/embedded.provisionprofile"), 0o644);
    run("/usr/bin/xattr", ["-cr", application]);
    assertMacOSExtendedAttributes(run("/usr/bin/xattr", ["-r", application]), {
      allowProvenance: true,
    });
    const entitlementSource = await readFile(options.entitlementsTemplate, "utf8");
    const entitlements = path.join(scratch, "OpenBotWorkerHost.entitlements.plist");
    await writeFile(
      entitlements,
      expandEntitlementsTemplate(entitlementSource, options.accessGroup),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    run("/usr/bin/plutil", ["-lint", entitlements]);

    const node = path.join(application, "Contents/Resources/node/bin/node");
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      options.applicationIdentity,
      "--options",
      "runtime",
      "--timestamp",
      node,
    ]);
    await sealMacOSWorkerHostApplicationMetadata(application);
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      options.applicationIdentity,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entitlements,
      application,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", application]);
    await validateMacOSWorkerHostApplication(application, {
      expectedOwner: process.getuid?.(),
      allowDistributionArtifacts: true,
    });

    await mkdir(path.dirname(options.outputPackage), { recursive: true });
    run("/usr/bin/productbuild", [
      "--sign",
      options.installerIdentity,
      "--component",
      application,
      "/Applications",
      options.outputPackage,
    ]);
    run("/usr/sbin/pkgutil", ["--check-signature", options.outputPackage]);
    const payloadFiles = run("/usr/sbin/pkgutil", ["--payload-files", options.outputPackage]);
    if (
      payloadFiles
        .split(/\r?\n/)
        .some((entry) => entry.split("/").some((segment) => segment.startsWith("._")))
    ) {
      throw new Error("The macOS package payload contains AppleDouble files.");
    }
    const expandedPackage = path.join(scratch, "expanded-package");
    run("/usr/sbin/pkgutil", ["--expand", options.outputPackage, expandedPackage]);
    if (
      (await readdir(expandedPackage, { recursive: true })).some(
        (entry) => path.basename(entry) === "Scripts",
      )
    ) {
      throw new Error("The macOS package unexpectedly contains installer scripts.");
    }
    const notarization: unknown = JSON.parse(
      run("/usr/bin/xcrun", [
        "notarytool",
        "submit",
        options.outputPackage,
        "--keychain-profile",
        options.notaryProfile,
        "--wait",
        "--output-format",
        "json",
      ]),
    );
    if (
      typeof notarization !== "object" ||
      notarization === null ||
      !("status" in notarization) ||
      notarization.status !== "Accepted"
    ) {
      throw new Error("Apple did not accept the macOS Worker Host package for notarization.");
    }
    run("/usr/bin/xcrun", ["stapler", "staple", options.outputPackage]);
    run("/usr/bin/xcrun", ["stapler", "validate", options.outputPackage]);
    run("/usr/sbin/spctl", ["--assess", "--verbose=4", "--type", "install", options.outputPackage]);
    process.stdout.write(
      `${JSON.stringify({ package: options.outputPackage, notarizationId: "id" in notarization ? notarization.id : undefined, signed: true, notarized: true }, null, 2)}\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function run(command: string, arguments_: readonly string[]): string {
  return execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      COPYFILE_DISABLE: "1",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function parseMacOSDistributionArguments(arguments_: readonly string[]) {
  const values = parseArgumentPairs(
    arguments_,
    "macOS distribution arguments must be unique --name value pairs.",
  );
  const allowed = new Set([
    "--access-group",
    "--app",
    "--application-identity",
    "--entitlements-template",
    "--installer-identity",
    "--notary-profile",
    "--output",
    "--provisioning-profile",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown macOS distribution argument: ${key}.`);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing macOS distribution argument: ${key}.`);
    return value;
  };
  const absolute = (key: string): string => {
    const value = required(key);
    if (!path.isAbsolute(value)) throw new Error(`macOS path must be absolute: ${key}.`);
    return path.resolve(value);
  };
  return {
    accessGroup: assertMacOSAccessGroup(required("--access-group")),
    application: absolute("--app"),
    applicationIdentity: required("--application-identity"),
    entitlementsTemplate: absolute("--entitlements-template"),
    installerIdentity: required("--installer-identity"),
    notaryProfile: required("--notary-profile"),
    outputPackage: absolute("--output"),
    provisioningProfile: absolute("--provisioning-profile"),
  };
}

async function assertDistributionInput(
  filePath: string,
  { minimum, maximum }: { minimum: number; maximum: number },
): Promise<void> {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < minimum ||
    metadata.size > maximum
  ) {
    throw new Error("A macOS distribution input is outside the reviewed file boundary.");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await packageMacOSWorkerHostDistribution();
}
