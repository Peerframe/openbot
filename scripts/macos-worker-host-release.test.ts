import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseMacOSCandidateArguments } from "./build-macos-worker-host-candidate.ts";
import {
  assertMacOSAccessGroup,
  assertMacOSDeveloperIdentities,
  assertMacOSExtendedAttributes,
  distributionSigningPlan,
  expandEntitlementsTemplate,
  MACOS_NCC_OUTPUTS,
  sealMacOSWorkerHostApplicationMetadata,
  stageMacOSWorkerHostApplication,
  validateMacOSProvisioningProfile,
  validateMacOSWorkerHostApplication,
} from "./macos-worker-host-release.ts";
import { parseMacOSDistributionArguments } from "./package-macos-worker-host-distribution.ts";

interface Fixture {
  readonly root: string;
  controlBinary: string;
  readonly nodeBinary: string;
  readonly nodeLicense: string;
  readonly nodeBundleDirectory: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCommit = "a".repeat(40);

test("stages and validates the exact unsigned macOS application", async (context) => {
  const fixture = await createFixture(context);
  const application = path.join(fixture.root, "OpenBot Worker Host.app");
  await stage(fixture, application);
  const manifest = await validateMacOSWorkerHostApplication(application, {
    expectedOwner: process.getuid?.(),
  });
  assert.equal(manifest.architecture, "arm64");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["Contents/Resources/node/app/index.js", "Contents/Resources/node/bin/node"],
  );
  assert.match(
    await readFile(path.join(application, "Contents/Info.plist"), "utf8"),
    /<string>1\.2\.3<\/string>/,
  );
});

test("rejects linked input, ncc inventory drift, and staged tampering", async (context) => {
  const linked = await createFixture(context);
  const target = path.join(linked.root, "linked-control");
  await symlink(linked.controlBinary, target);
  linked.controlBinary = target;
  await assert.rejects(stage(linked, path.join(linked.root, "Linked.app")), /staging input/);

  const drift = await createFixture(context);
  await writeFile(path.join(drift.nodeBundleDirectory, "unexpected.js"), "unexpected");
  await assert.rejects(stage(drift, path.join(drift.root, "Drift.app")), /inventory/);

  const tampered = await createFixture(context);
  const application = path.join(tampered.root, "Tampered.app");
  await stage(tampered, application);
  await writeFile(path.join(application, "Contents/Resources/node/app/index.js"), "tampered");
  await assert.rejects(
    validateMacOSWorkerHostApplication(application, { expectedOwner: process.getuid?.() }),
    /manifest|mode/,
  );
});

test("expands only the exact shared access group", async () => {
  const template = await readFile(
    path.join(
      repositoryRoot,
      "apps/worker-host-macos/Resources/OpenBotWorkerHost.entitlements.template.plist",
    ),
    "utf8",
  );
  const group = "A1B2C3D4E5.com.openbot.worker-host.shared";
  const expanded = expandEntitlementsTemplate(template, group);
  assert.match(expanded, new RegExp(group.replaceAll(".", "\\.")));
  assert.match(expanded, /A1B2C3D4E5\.com\.openbot\.worker-host/);
  assert.match(expanded, /<string>A1B2C3D4E5<\/string>/);
  assert.doesNotMatch(expanded, /OPENBOT_|get-task-allow|app-sandbox/);
  assert.throws(() => assertMacOSAccessGroup("com.openbot.worker-host.shared"), /Team ID/);
  assert.throws(
    () => expandEntitlementsTemplate(`${template}OPENBOT_ACCESS_GROUP`, group),
    /placeholder/,
  );
});

test("binds Developer ID identities and provisioning to one exact application", () => {
  const accessGroup = "A1B2C3D4E5.com.openbot.worker-host.shared";
  const identities = {
    applicationIdentity: "Developer ID Application: OpenBot (A1B2C3D4E5)",
    installerIdentity: "Developer ID Installer: OpenBot (A1B2C3D4E5)",
  };
  assert.equal(assertMacOSDeveloperIdentities(identities, accessGroup), "A1B2C3D4E5");
  assert.throws(
    () =>
      assertMacOSDeveloperIdentities(
        { ...identities, installerIdentity: "Developer ID Installer: Other (Z9Y8X7W6V5)" },
        accessGroup,
      ),
    /identity/,
  );

  const profile = {
    ProvisionsAllDevices: true,
    Platform: ["OSX"],
    TeamIdentifier: ["A1B2C3D4E5"],
    ApplicationIdentifierPrefix: ["A1B2C3D4E5"],
    ExpirationDate: "2027-09-04T00:00:00.000Z",
    Entitlements: {
      "com.apple.application-identifier": "A1B2C3D4E5.com.openbot.worker-host",
      "com.apple.developer.team-identifier": "A1B2C3D4E5",
      "keychain-access-groups": ["A1B2C3D4E5.*"],
      "get-task-allow": false,
    },
  };
  assert.doesNotThrow(() =>
    validateMacOSProvisioningProfile(profile, {
      accessGroup,
      now: new Date("2026-09-04T00:00:00.000Z"),
    }),
  );
  assert.throws(
    () =>
      validateMacOSProvisioningProfile(
        {
          ...profile,
          Entitlements: { ...profile.Entitlements, "keychain-access-groups": ["Z9Y8X7W6V5.*"] },
        },
        { accessGroup, now: new Date("2026-09-04T00:00:00.000Z") },
      ),
    /does not authorize/,
  );
});

test("rejects dangerous extended attributes while tolerating system provenance", () => {
  assert.doesNotThrow(() => assertMacOSExtendedAttributes(""));
  assert.doesNotThrow(() =>
    assertMacOSExtendedAttributes("/tmp/OpenBot.app: com.apple.provenance\n", {
      allowProvenance: true,
    }),
  );
  assert.throws(
    () =>
      assertMacOSExtendedAttributes("/tmp/OpenBot.app: com.apple.quarantine\n", {
        allowProvenance: true,
      }),
    /unexpected extended attribute/,
  );
  assert.throws(
    () => assertMacOSExtendedAttributes("/tmp/OpenBot.app: com.apple.FinderInfo\n"),
    /unexpected extended attribute/,
  );
});

test("refreshes signed runtime bytes before the outer application seal", async (context) => {
  const fixture = await createFixture(context);
  const application = path.join(fixture.root, "Signing.app");
  await stage(fixture, application);
  const node = path.join(application, "Contents/Resources/node/bin/node");
  await writeFile(node, Buffer.alloc(20 * 1024 * 1024, "s"));
  await assert.rejects(
    validateMacOSWorkerHostApplication(application, { expectedOwner: process.getuid?.() }),
    /manifest/,
  );

  await sealMacOSWorkerHostApplicationMetadata(application);
  await validateMacOSWorkerHostApplication(application, {
    expectedOwner: process.getuid?.(),
    expectedSigned: true,
  });
  const build: unknown = JSON.parse(
    await readFile(path.join(application, "Contents/Resources/build.json"), "utf8"),
  );
  assert.ok(typeof build === "object" && build !== null && "signed" in build);
  assert.equal(build.signed, true);
});

test("locks distribution to inside-out signing and notarization", () => {
  const plan = distributionSigningPlan({
    applicationPath: "/tmp/OpenBot Worker Host.app",
    outputPackage: "/tmp/openbot.pkg",
    identities: {
      applicationIdentity: "Developer ID Application: OpenBot (A1B2C3D4E5)",
      installerIdentity: "Developer ID Installer: OpenBot (A1B2C3D4E5)",
    },
    notaryProfile: "openbot-notary",
  });
  assert.deepEqual(
    plan.map((step) => step.role),
    [
      "node",
      "seal-metadata",
      "application",
      "verify-application",
      "package",
      "verify-package",
      "notarize",
      "staple",
      "gatekeeper",
    ],
  );
  assert.throws(
    () =>
      distributionSigningPlan({
        applicationPath: "/tmp/a.app",
        outputPackage: "/tmp/a.pkg",
        identities: { applicationIdentity: "-", installerIdentity: "installer" },
        notaryProfile: "profile",
      }),
    /invalid/,
  );
});

test("rejects malformed runtime manifest and build metadata JSON", async (context) => {
  const fixture = await createFixture(context);
  const application = path.join(fixture.root, "Malformed.app");
  await stage(fixture, application);
  const manifestPath = path.join(application, "Contents/Resources/manifest.json");
  const buildPath = path.join(application, "Contents/Resources/build.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const buildText = await readFile(buildPath, "utf8");
  const validate = () =>
    validateMacOSWorkerHostApplication(application, { expectedOwner: process.getuid?.() });
  const appPath = "Contents/Resources/node/app/index.js";
  const nodePath = "Contents/Resources/node/bin/node";
  const manifestCases: readonly (readonly [string, RegExp])[] = [
    ["{", /JSON/],
    [
      manifestText.replace('"format":', '"extra": true,\n  "format":'),
      /runtime manifest is invalid/,
    ],
    [manifestText.replace('"version": "1.2.3"', '"version": "latest"'), /bounded SemVer/],
    [manifestText.replace('"mode": "0755"', '"mode": "0644"'), /runtime manifest is invalid/],
    [
      manifestText.replace(/"sha256": "[a-f0-9]{64}"/, `"sha256": "${"A".repeat(64)}"`),
      /runtime manifest is invalid/,
    ],
    [manifestText.replace(/"size": (\d+)/, '"size": "$1"'), /runtime manifest is invalid/],
    [
      manifestText.replace(appPath, "SWAP").replace(nodePath, appPath).replace("SWAP", nodePath),
      /runtime manifest is invalid/,
    ],
  ];
  for (const [mutated, expected] of manifestCases) {
    assert.notEqual(mutated, manifestText);
    await writeFile(manifestPath, mutated);
    await assert.rejects(validate(), expected);
  }
  await writeFile(manifestPath, manifestText);

  const buildCases: readonly (readonly [string, RegExp])[] = [
    [buildText.replace('"signed": false', '"signed": "false"'), /build metadata is invalid/],
    [
      buildText.replace('"nodeVersion": "22.22.2"', '"nodeVersion": "24.21.0"'),
      /build metadata is invalid/,
    ],
    [
      buildText.replace('"buildVersion": "123"', '"buildVersion": "0123"'),
      /positive bounded integer/,
    ],
    [
      buildText.replace('"format":', '"credential": "x",\n  "format":'),
      /build metadata is invalid/,
    ],
    [buildText.replace(sourceCommit, "b".repeat(40)), /does not match its payload/],
    [buildText.replace('"signed": false', '"signed": true'), /does not match its payload/],
  ];
  for (const [mutated, expected] of buildCases) {
    assert.notEqual(mutated, buildText);
    await writeFile(buildPath, mutated);
    await assert.rejects(validate(), expected);
  }
  await writeFile(buildPath, buildText);
  await validate();
});

test("seals metadata with exact JSON bytes and refuses unsafe replacement lifetimes", async (context) => {
  const fixture = await createFixture(context);
  const application = path.join(fixture.root, "Seal.app");
  await stage(fixture, application);
  const manifestPath = path.join(application, "Contents/Resources/manifest.json");
  const buildPath = path.join(application, "Contents/Resources/build.json");
  const signedSize = 20 * 1024 * 1024 + 1;
  await writeFile(
    path.join(application, "Contents/Resources/node/bin/node"),
    Buffer.alloc(signedSize, "s"),
  );
  await sealMacOSWorkerHostApplicationMetadata(application);
  const manifest = await validateMacOSWorkerHostApplication(application, {
    expectedOwner: process.getuid?.(),
    expectedSigned: true,
  });
  const manifestText = await readFile(manifestPath, "utf8");
  assert.equal(manifestText, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.deepEqual(Object.keys(manifest), [
    "format",
    "version",
    "sourceCommit",
    "architecture",
    "files",
  ]);
  assert.deepEqual(
    manifest.files.map((record) => Object.keys(record)),
    [
      ["path", "sha256", "size", "mode"],
      ["path", "sha256", "size", "mode"],
    ],
  );
  assert.equal(manifest.files[1]?.size, signedSize);
  const buildText = await readFile(buildPath, "utf8");
  const build: unknown = JSON.parse(buildText);
  assert.ok(typeof build === "object" && build !== null);
  assert.equal(buildText, `${JSON.stringify(build, null, 2)}\n`);
  assert.deepEqual(Object.keys(build), [
    "format",
    "version",
    "buildVersion",
    "sourceCommit",
    "architecture",
    "nodeVersion",
    "signed",
  ]);

  await writeFile(`${manifestPath}.next`, "stale");
  await assert.rejects(sealMacOSWorkerHostApplicationMetadata(application), /already exists/);
  assert.equal(await readFile(manifestPath, "utf8"), manifestText);
  await rm(`${manifestPath}.next`);

  const linkedManifest = path.join(fixture.root, "linked-manifest.json");
  await link(manifestPath, linkedManifest);
  await assert.rejects(
    sealMacOSWorkerHostApplicationMetadata(application),
    /outside the reviewed boundary/,
  );
  await rm(linkedManifest);

  await chmod(buildPath, 0o600);
  await assert.rejects(
    sealMacOSWorkerHostApplicationMetadata(application),
    /outside the reviewed boundary/,
  );
  await chmod(buildPath, 0o644);

  await writeFile(manifestPath, manifestText.replace('"format":', '"extra": true,\n  "format":'));
  await assert.rejects(
    sealMacOSWorkerHostApplicationMetadata(application),
    /runtime manifest is invalid/,
  );
  await assert.rejects(lstat(`${manifestPath}.next`), { code: "ENOENT" });
});

test("binds provisioning, identities and xattr output only to exact JSON shapes", () => {
  const accessGroup = "A1B2C3D4E5.com.openbot.worker-host.shared";
  const now = new Date("2026-09-04T00:00:00.000Z");
  const entitlements = {
    "com.apple.application-identifier": "A1B2C3D4E5.com.openbot.worker-host",
    "com.apple.developer.team-identifier": "A1B2C3D4E5",
    "keychain-access-groups": [accessGroup],
    "get-task-allow": false,
  };
  const profile = {
    ProvisionsAllDevices: true,
    Platform: ["OSX"],
    TeamIdentifier: ["A1B2C3D4E5"],
    ApplicationIdentifierPrefix: ["A1B2C3D4E5"],
    ExpirationDate: "2027-09-04T00:00:00.000Z",
    Entitlements: entitlements,
  };
  assert.doesNotThrow(() => validateMacOSProvisioningProfile(profile, { accessGroup, now }));
  for (const malformed of [
    null,
    "profile",
    [],
    7,
    {},
    { ...profile, ProvisionsAllDevices: "true" },
    { ...profile, Platform: "OSX" },
    { ...profile, TeamIdentifier: "A1B2C3D4E5" },
    { ...profile, ExpirationDate: undefined },
    { ...profile, ExpirationDate: "2026-09-04T12:00:00.000Z" },
    { ...profile, Entitlements: null },
    { ...profile, Entitlements: { ...entitlements, "get-task-allow": true } },
    { ...profile, Entitlements: { ...entitlements, "keychain-access-groups": accessGroup } },
  ]) {
    assert.throws(
      () => validateMacOSProvisioningProfile(malformed, { accessGroup, now }),
      /does not authorize/,
    );
  }
  assert.throws(
    () => validateMacOSProvisioningProfile(profile, { accessGroup: undefined, now }),
    /Team ID/,
  );

  for (const identities of [
    null,
    "identity",
    [],
    { applicationIdentity: "Developer ID Application: OpenBot (A1B2C3D4E5)" },
    {
      applicationIdentity: "Developer ID Application: Open\nBot (A1B2C3D4E5)",
      installerIdentity: "Developer ID Installer: OpenBot (A1B2C3D4E5)",
    },
  ]) {
    assert.throws(
      () => assertMacOSDeveloperIdentities(identities, accessGroup),
      /identity is invalid/,
    );
  }
  assert.throws(() => assertMacOSExtendedAttributes(undefined), /outside the reviewed bound/);
  assert.throws(
    () => assertMacOSExtendedAttributes("x".repeat(64 * 1024 + 1)),
    /outside the reviewed bound/,
  );
});

test("parses only exact macOS candidate CLI arguments without running native commands", () => {
  const valid = [
    "--arch",
    "arm64",
    "--build-version",
    "1",
    "--node-archive",
    "/tmp/node.tar.gz",
    "--npm-cli",
    "/usr/local/bin/npm",
    "--out-dir",
    "/tmp/out",
    "--source-commit",
    sourceCommit,
    "--version",
    "0.0.0",
  ];
  assert.deepEqual(parseMacOSCandidateArguments(valid), {
    architecture: "arm64",
    buildVersion: "1",
    nodeArchive: path.resolve("/tmp/node.tar.gz"),
    npmCli: path.resolve("/usr/local/bin/npm"),
    outputDirectory: path.resolve("/tmp/out"),
    sourceCommit,
    version: "0.0.0",
  });
  assert.equal(
    parseMacOSCandidateArguments([...valid, "--sdk", "/Library/SDK"]).sdk,
    "/Library/SDK",
  );
  assert.throws(
    () => parseMacOSCandidateArguments([...valid, "--sdk", "relative/SDK"]),
    /SDK path must be absolute/,
  );
  assert.throws(
    () => parseMacOSCandidateArguments(valid.slice(2)),
    /Missing macOS candidate argument: --arch\./,
  );
  assert.throws(
    () => parseMacOSCandidateArguments([...valid, "--publish", "yes"]),
    /Unknown macOS candidate argument: --publish\./,
  );
  assert.throws(
    () => parseMacOSCandidateArguments(withArgument(valid, "--node-archive", "node.tar.gz")),
    /must be absolute: --node-archive\./,
  );
  assert.throws(
    () => parseMacOSCandidateArguments([...valid, "--arch", "x64"]),
    /unique --name value pairs/,
  );
  assert.throws(
    () => parseMacOSCandidateArguments([...valid, "--sdk"]),
    /unique --name value pairs/,
  );
  assert.throws(
    () => parseMacOSCandidateArguments(withArgument(valid, "--source-commit", "A".repeat(40))),
    /full lowercase Git SHA-1/,
  );
});

test("parses only exact macOS distribution CLI arguments without signing", () => {
  const accessGroup = "A1B2C3D4E5.com.openbot.worker-host.shared";
  const valid = [
    "--access-group",
    accessGroup,
    "--app",
    "/tmp/OpenBot Worker Host.app",
    "--application-identity",
    "Developer ID Application: OpenBot (A1B2C3D4E5)",
    "--entitlements-template",
    "/tmp/entitlements.plist",
    "--installer-identity",
    "Developer ID Installer: OpenBot (A1B2C3D4E5)",
    "--notary-profile",
    "openbot-notary",
    "--output",
    "/tmp/openbot.pkg",
    "--provisioning-profile",
    "/tmp/openbot.provisionprofile",
  ];
  assert.deepEqual(parseMacOSDistributionArguments(valid), {
    accessGroup,
    application: path.resolve("/tmp/OpenBot Worker Host.app"),
    applicationIdentity: "Developer ID Application: OpenBot (A1B2C3D4E5)",
    entitlementsTemplate: path.resolve("/tmp/entitlements.plist"),
    installerIdentity: "Developer ID Installer: OpenBot (A1B2C3D4E5)",
    notaryProfile: "openbot-notary",
    outputPackage: path.resolve("/tmp/openbot.pkg"),
    provisioningProfile: path.resolve("/tmp/openbot.provisionprofile"),
  });
  assert.throws(
    () => parseMacOSDistributionArguments(withArgument(valid, "--access-group", "group")),
    /Team ID/,
  );
  assert.throws(
    () => parseMacOSDistributionArguments(withArgument(valid, "--output", "openbot.pkg")),
    /macOS path must be absolute: --output\./,
  );
  assert.throws(
    () => parseMacOSDistributionArguments([...valid, "--skip-notarization", "true"]),
    /Unknown macOS distribution argument: --skip-notarization\./,
  );
  assert.throws(
    () => parseMacOSDistributionArguments(withoutArgument(valid, "--notary-profile")),
    /Missing macOS distribution argument: --notary-profile\./,
  );
  assert.throws(
    () => parseMacOSDistributionArguments([...valid, "--app", "/tmp/Other.app"]),
    /unique --name value pairs/,
  );
});

function withArgument(argumentsList: readonly string[], key: string, value: string): string[] {
  const result = [...argumentsList];
  const index = result.indexOf(key);
  assert.ok(index >= 0 && index + 1 < result.length);
  result[index + 1] = value;
  return result;
}

function withoutArgument(argumentsList: readonly string[], key: string): string[] {
  const index = argumentsList.indexOf(key);
  assert.ok(index >= 0);
  return [...argumentsList.slice(0, index), ...argumentsList.slice(index + 2)];
}

async function createFixture(context: TestContext): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-macos-release-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture: Fixture = {
    root,
    controlBinary: path.join(root, "OpenBotWorkerHostControl"),
    nodeBinary: path.join(root, "node"),
    nodeLicense: path.join(root, "NODE_LICENSE"),
    nodeBundleDirectory: path.join(root, "bundle"),
  };
  await writeSized(fixture.controlBinary, 16 * 1024);
  await writeSized(fixture.nodeBinary, 20 * 1024 * 1024);
  await writeSized(fixture.nodeLicense, 1_024);
  await mkdir(fixture.nodeBundleDirectory);
  for (const name of MACOS_NCC_OUTPUTS) {
    await writeFile(path.join(fixture.nodeBundleDirectory, name), `${name}\n`);
  }
  return fixture;
}

async function writeSized(target: string, size: number): Promise<void> {
  await writeFile(target, "x", { mode: 0o600 });
  await truncate(target, size);
}

function stage(fixture: Fixture, destination: string): Promise<string> {
  return stageMacOSWorkerHostApplication({
    architecture: "arm64",
    buildVersion: "123",
    controlBinary: fixture.controlBinary,
    destination,
    enrollmentDocumentation: path.join(repositoryRoot, "docs/NODE_ENROLLMENT.md"),
    enrollmentDocumentationChinese: path.join(repositoryRoot, "docs/NODE_ENROLLMENT.zh-CN.md"),
    infoTemplate: path.join(repositoryRoot, "apps/worker-host-macos/Resources/Info.plist.template"),
    launchAgentPlist: path.join(
      repositoryRoot,
      "apps/worker-host-macos/Resources/com.openbot.worker-host.node.plist",
    ),
    nodeBinary: fixture.nodeBinary,
    nodeBundleDirectory: fixture.nodeBundleDirectory,
    nodeLicense: fixture.nodeLicense,
    openBotLicense: path.join(repositoryRoot, "LICENSE"),
    sourceCommit,
    version: "1.2.3",
  });
}
