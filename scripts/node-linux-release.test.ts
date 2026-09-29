import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectProductionPackageGraph } from "./production-package-graph.ts";
import {
  assertReleaseVersion,
  assertSourceCommit,
  assertSourceDateEpoch,
  assertSourceTreeState,
} from "./release-source.ts";
import {
  NCC_VERSION,
  NODE_RUNTIME_TARGETS,
  NODE_RUNTIME_VERSION,
  RELEASE_NPM_VERSION,
  canonicalizeSpdxSbom,
  createFileManifest,
  deterministicTarArguments,
  deterministicXzArguments,
  listRegularFiles,
  linuxInstalledReleaseName,
  parseDpkgPackageVersions,
  parseOsRelease,
  validateNccStats,
  validateLinuxArchiveToolchain,
  validateLinuxArchiveToolPaths,
  validatePackagedNodeHello,
  validateSpdxSbom,
  verifyCandidateDirectory,
  verifyChecksums,
  verifyNodeRuntimeArchive,
  writeChecksums,
  writeProductionSbomProjection,
} from "./node-linux-release.ts";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const lockfile = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));

test("pins the reviewed Linux release inputs", () => {
  assert.equal(NODE_RUNTIME_VERSION, "22.22.2");
  assert.equal(NCC_VERSION, "0.45.0");
  assert.equal(RELEASE_NPM_VERSION, "10.9.9");
  assert.deepEqual(Object.keys(NODE_RUNTIME_TARGETS).sort(), ["arm64", "x64"]);
  assert.match(NODE_RUNTIME_TARGETS.x64.sha256, /^[0-9a-f]{64}$/);
  assert.match(NODE_RUNTIME_TARGETS.arm64.sha256, /^[0-9a-f]{64}$/);
});

test("accepts bounded release identifiers and rejects ambiguous values", () => {
  assert.equal(assertReleaseVersion("1.2.3-rc.1+build.5"), "1.2.3-rc.1+build.5");
  assert.equal(assertSourceCommit("a".repeat(40)), "a".repeat(40));
  assert.equal(assertSourceDateEpoch("1"), 1);
  assert.throws(() => assertReleaseVersion("latest"), /SemVer/);
  assert.throws(() => assertSourceCommit("ABC123"), /full lowercase/);
  assert.throws(() => assertSourceDateEpoch("tomorrow"), /integer/);
  assert.doesNotThrow(() => assertSourceTreeState("a".repeat(40), `${"a".repeat(40)}\n`, ""));
  assert.throws(
    () => assertSourceTreeState("a".repeat(40), `${"b".repeat(40)}\n`, ""),
    /does not match/,
  );
  assert.throws(
    () => assertSourceTreeState("a".repeat(40), `${"a".repeat(40)}\n`, " M package.json\n"),
    /clean source tree/,
  );
});

test("projects only the Node production dependency closure", () => {
  const graph = collectProductionPackageGraph(lockfile);
  assert.deepEqual(graph.workspaceKeys, [
    "apps/node",
    "packages/config",
    "packages/logging",
    "packages/protocol",
    "packages/provider-sdk",
    "packages/windows-secret-acl",
    "providers/docker",
  ]);
  assert.ok(graph.packageKeys.includes("node_modules/pino"));
  assert.ok(graph.packageKeys.includes("node_modules/ws"));
  assert.ok(graph.packageKeys.includes("node_modules/zod"));
  assert.ok(!graph.workspaceKeys.includes("providers/coder"));
  assert.ok(!graph.workspaceKeys.includes("providers/cua"));
  assert.ok(!graph.workspaceKeys.includes("providers/lume"));
});

test("fails closed when the production lock graph is incomplete", () => {
  const changed = structuredClone(lockfile);
  delete changed.packages["node_modules/ws"];
  assert.throws(
    () => collectProductionPackageGraph(changed),
    /Production dependency is unresolved: apps\/node -> ws/,
  );
});

test("emits an npm-readable production-only SPDX projection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-sbom-projection-test-"));
  const graph = await writeProductionSbomProjection({
    destination: directory,
    lockfile,
    version: "1.2.3-test.1",
  });
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npmCommand,
    [
      "sbom",
      "--package-lock-only",
      "--omit=dev",
      "--workspace",
      "@openbot/node",
      "--sbom-format=spdx",
      "--sbom-type=application",
    ],
    { cwd: directory, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const sbom = validateSpdxSbom(JSON.parse(output), graph, lockfile);
  const names = new Set(sbom.packages.map((entry) => record(entry).name));
  assert.ok(names.has("@openbot/node"));
  assert.ok(names.has("write-file-atomic"));
  assert.ok(!names.has("@openbot/provider-cua"));
  assert.ok(!names.has("vitest"));
  const npmVersion = execFileSync(npmCommand, ["--version"], { encoding: "utf8" }).trim();
  const canonicalInput = structuredClone(sbom);
  const creationInfo = record(canonicalInput.creationInfo);
  assert.ok(Array.isArray(creationInfo.creators));
  creationInfo.creators = creationInfo.creators.map((creator: unknown) =>
    creator === `Tool: npm/cli-${npmVersion}` ? `Tool: npm/cli-${RELEASE_NPM_VERSION}` : creator,
  );
  const canonical = canonicalizeSpdxSbom(canonicalInput, {
    architecture: "x64",
    version: "1.2.3-test.1",
    sourceCommit: "d".repeat(40),
    sourceDateEpoch: 1_700_000_000,
  });
  assert.equal(record(canonical.creationInfo).created, "2023-11-14T22:13:20.000Z");
  assert.equal(
    canonical.documentNamespace,
    `https://openbot.dev/spdx/openbot-node/1.2.3-test.1/linux/x64/${"d".repeat(40)}`,
  );
});

test("accepts only the reviewed ncc assets, builtins, stubs, and internal notices", () => {
  const internalPackages = [
    "@openbot/node",
    "@openbot/config",
    "@openbot/logging",
    "@openbot/protocol",
    "@openbot/provider-sdk",
    "@openbot/provider-docker",
    "@openbot/windows-secret-acl",
  ];
  const stats = {
    errorsCount: 0,
    warningsCount: internalPackages.length,
    warnings: internalPackages.map((name) => ({
      message: `license-webpack-plugin: could not find any license file for ${name}. Use the licenseTextOverrides option to add the license text if desired.`,
    })),
    assets: [
      { name: "index.js" },
      { name: "third-party-licenses.txt" },
      { name: "worker.js" },
      { name: "worker1.js" },
      { name: "file.js" },
    ],
    modules: [
      { name: 'external "node:fs"' },
      { name: "./node_modules/@vercel/ncc/dist/ncc/@@notfound.js?bufferutil" },
    ],
  };
  const outputs = [
    "index.js",
    "third-party-licenses.txt",
    "worker.js",
    "worker1.js",
    "file.js",
    "package.json",
  ];
  assert.doesNotThrow(() => validateNccStats(stats, outputs));
  assert.throws(
    () => validateNccStats({ ...stats, modules: [{ name: 'external "left-pad"' }] }, outputs),
    /non-builtin dependency external/,
  );
  assert.throws(() => validateNccStats(stats, [...outputs, "surprise.node"]), /unexpected files/);
  assert.throws(
    () => validateNccStats({ ...stats, modules: "external module" }, outputs),
    /unexpected module set/,
  );
  assert.throws(() => validateNccStats({ ...stats, assets: {} }, outputs), /unexpected asset set/);
});

test("builds a canonical bounded file manifest and checksums", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-manifest-test-"));
  await mkdir(path.join(directory, "app"));
  await writeFile(path.join(directory, "app/index.js"), "export {};\n", { mode: 0o644 });
  await writeFile(path.join(directory, "bin"), "executable\n", { mode: 0o755 });
  const manifest = await createFileManifest(directory, {
    architecture: "x64",
    version: "1.2.3",
    sourceCommit: "b".repeat(40),
    sourceDateEpoch: 1_700_000_000,
  });
  assert.deepEqual(
    manifest.files.map((entry) => entry.path),
    ["app/index.js", "bin"],
  );
  assert.equal(manifest.signed, false);
  assert.equal(manifest.runtime.archiveSha256, NODE_RUNTIME_TARGETS.x64.sha256);
  await writeChecksums(directory, ["bin", "app/index.js"], path.join(directory, "SHA256SUMS"));
  const checksums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
  assert.match(checksums, /^[0-9a-f]{64} {2}app\/index\.js\n[0-9a-f]{64} {2}bin\n$/);
});

test("rejects symlinks and unreviewed runtime archives", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "openbot-manifest-negative-test-"));
  await writeFile(path.join(directory, "target"), "payload");
  if (process.platform !== "win32") {
    await symlink("target", path.join(directory, "link"));
    await assert.rejects(
      createFileManifest(directory, {
        architecture: "arm64",
        version: "1.2.3",
        sourceCommit: "c".repeat(40),
        sourceDateEpoch: 1_700_000_000,
      }),
      /symbolic link/,
    );
  } else {
    context.diagnostic("symlink creation is skipped on Windows without Developer Mode");
  }
  const tinyArchive = path.join(directory, "node.tar.xz");
  await writeFile(tinyArchive, "not node");
  await assert.rejects(verifyNodeRuntimeArchive(tinyArchive, "x64"), /size is outside/);
  await assert.rejects(verifyNodeRuntimeArchive(tinyArchive, "ppc64"), /x64 or arm64/);
});

test("pins the Ubuntu archive toolchain and deterministic command arguments", () => {
  const osRelease = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
  const packageVersions = parseDpkgPackageVersions(
    "tar=1.35+dfsg-3ubuntu0.4\nxz-utils=5.6.1+really5.4.5-1ubuntu0.3\n",
  );
  assert.deepEqual(
    validateLinuxArchiveToolchain({
      osRelease,
      tarVersion: "tar (GNU tar) 1.35\nCopyright test\n",
      xzVersion: "xz (XZ Utils) 5.4.5\nliblzma 5.4.5\n",
      packageVersions,
    }),
    { tar: "1.35+dfsg-3ubuntu0.4", xzUtils: "5.6.1+really5.4.5-1ubuntu0.3" },
  );
  assert.deepEqual(
    deterministicTarArguments({
      candidateName: "openbot-node-1.2.3-linux-x64-unsigned",
      sourceDateEpoch: 1_700_000_000,
      tarPath: "/tmp/candidate.tar",
      parentDirectory: "/tmp/input",
    }),
    [
      "--sort=name",
      "--format=posix",
      "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
      "--clamp-mtime",
      "--mtime=@1700000000",
      "--numeric-owner",
      "--owner=0",
      "--group=0",
      "--mode=go+u,go-w",
      "--create",
      "--file=/tmp/candidate.tar",
      "--directory=/tmp/input",
      "openbot-node-1.2.3-linux-x64-unsigned",
    ],
  );
  assert.deepEqual(deterministicXzArguments("/tmp/candidate.tar"), [
    "--threads=1",
    "--check=sha256",
    "--no-adjust",
    "-6",
    "--compress",
    "--stdout",
    "/tmp/candidate.tar",
  ]);
  assert.deepEqual(
    validateLinuxArchiveToolPaths({
      dpkgQuery: "/usr/bin/dpkg-query",
      gnuTar: "/usr/bin/tar",
      xz: "/usr/bin/xz",
    }),
    { dpkgQuery: "/usr/bin/dpkg-query", gnuTar: "/usr/bin/tar", xz: "/usr/bin/xz" },
  );
});

test("rejects archive toolchain drift and malformed package metadata", () => {
  const valid = {
    osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
    tarVersion: "tar (GNU tar) 1.35\n",
    xzVersion: "xz (XZ Utils) 5.4.5\n",
    packageVersions: { tar: "1.35+dfsg-3ubuntu0.4", "xz-utils": "5.6.1+really5.4.5-1ubuntu0.3" },
  };
  assert.throws(
    () =>
      validateLinuxArchiveToolchain({ ...valid, osRelease: { ID: "debian", VERSION_ID: "12" } }),
    /Ubuntu 24.04/,
  );
  assert.throws(
    () => validateLinuxArchiveToolchain({ ...valid, tarVersion: "tar (GNU tar) 1.36\n" }),
    /tar 1.35/,
  );
  assert.throws(
    () => validateLinuxArchiveToolchain({ ...valid, xzVersion: "xz (XZ Utils) 5.6.0\n" }),
    /XZ Utils 5.4.5/,
  );
  assert.throws(() => parseDpkgPackageVersions("tar=1.35\ntar=1.35\n"), /duplicated/);
  assert.throws(() => parseOsRelease("ID=ubuntu\nID=debian\n"), /duplicate/);
  assert.throws(
    () =>
      validateLinuxArchiveToolPaths({
        dpkgQuery: "/usr/bin/dpkg-query",
        gnuTar: "/tmp/tar",
        xz: "/usr/bin/xz",
      }),
    /reviewed path/,
  );
  assert.throws(
    () =>
      deterministicTarArguments({
        candidateName: "openbot-node-1.2.3-linux-x64-unsigned\nother",
        sourceDateEpoch: 1_700_000_000,
        tarPath: "/tmp/candidate.tar",
        parentDirectory: "/tmp/input",
      }),
    /unsafe/,
  );
});

test("revalidates an unsigned candidate before archive creation", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "openbot-candidate-verification-test-"));
  const candidate = path.join(parent, "openbot-node-1.2.3-linux-x64-unsigned");
  await mkdir(path.join(candidate, "app"), { recursive: true });
  await writeFile(path.join(candidate, "app/index.js"), "export {};\n", { mode: 0o644 });
  await writeFile(path.join(candidate, "runtime"), "executable\n", { mode: 0o755 });
  const manifest = await createFileManifest(candidate, {
    architecture: "x64",
    version: "1.2.3",
    sourceCommit: "e".repeat(40),
    sourceDateEpoch: 1_700_000_000,
  });
  await writeFile(path.join(candidate, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeChecksums(
    candidate,
    await listRegularFiles(candidate),
    path.join(candidate, "SHA256SUMS"),
  );
  assert.equal((await verifyCandidateDirectory(candidate)).sourceCommit, "e".repeat(40));
  const checksumText = await readFile(path.join(candidate, "SHA256SUMS"), "utf8");
  assert.deepEqual(await verifyChecksums(candidate, checksumText), [
    "app/index.js",
    "manifest.json",
    "runtime",
  ]);
  await writeFile(path.join(candidate, "app/index.js"), "tampered\n");
  await assert.rejects(verifyCandidateDirectory(candidate), /manifest does not match staged bytes/);
});

test("accepts only a least-authority packaged Node smoke hello", () => {
  const expected = {
    architecture: "arm64",
    credential: `obn_${"s".repeat(43)}`,
    nodeId: "release-smoke-arm64",
    protocolVersion: "0.9.0",
  };
  const hello = {
    type: "node.hello",
    protocolVersion: "0.9.0",
    nodeId: "release-smoke-arm64",
    name: "runner",
    platform: "linux",
    osVersion: "6.0",
    architecture: "arm64",
    deviceClass: "server",
    isolation: "unknown",
    trustTier: "development",
    capabilities: [],
    capabilityManifest: [],
    maxConcurrentRuns: 1,
    credential: expected.credential,
    sentAt: "2026-09-04T00:00:00.000Z",
  };
  assert.equal(validatePackagedNodeHello(hello, expected), hello);
  assert.throws(
    () => validatePackagedNodeHello({ ...hello, architecture: "x64" }, expected),
    /host declaration/,
  );
  assert.throws(
    () => validatePackagedNodeHello({ ...hello, capabilities: ["computer.read"] }, expected),
    /unexpected authority/,
  );
  assert.throws(
    () => validatePackagedNodeHello({ ...hello, credential: `obn_${"x".repeat(43)}` }, expected),
    /identity/,
  );
});

test("rejects inherited architecture keys before accessing release paths", async () => {
  const metadata = { version: "1.2.3", sourceCommit: "a".repeat(40), sourceDateEpoch: 1 };
  for (const architecture of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(
      verifyNodeRuntimeArchive("missing", architecture),
      /architecture must be x64 or arm64/,
    );
    await assert.rejects(
      createFileManifest("missing", { ...metadata, architecture }),
      /architecture must be x64 or arm64/,
    );
    assert.throws(
      () => linuxInstalledReleaseName({ ...metadata, architecture, platform: "linux" }),
      /architecture must be x64 or arm64/,
    );
    assert.throws(
      () => canonicalizeSpdxSbom({}, { ...metadata, architecture }),
      /architecture must be x64 or arm64/,
    );
  }
});

test("keeps malformed SBOM structures outside typed release results", () => {
  const metadata = {
    architecture: "x64",
    version: "1.2.3",
    sourceCommit: "a".repeat(40),
    sourceDateEpoch: 1,
  };
  const base = {
    creationInfo: { creators: [`Tool: npm/cli-${RELEASE_NPM_VERSION}`] },
    packages: [],
  };
  for (const malformed of [
    { ...base, packages: {} },
    { ...base, packages: [null] },
    { ...base, packages: [[]] },
    { ...base, relationships: [null] },
  ])
    assert.throws(() => canonicalizeSpdxSbom(malformed, metadata), /SPDX 2.3/);
  assert.throws(
    () =>
      validateSpdxSbom(
        { spdxVersion: "SPDX-2.3", packages: [] },
        { packageKeys: [], workspaceKeys: [] },
        {},
      ),
    /lockfileVersion 3/,
  );
});

test("does not coerce archive package revisions into trusted strings", () => {
  assert.throws(
    () =>
      validateLinuxArchiveToolchain({
        osRelease: { ID: "ubuntu", VERSION_ID: "24.04" },
        tarVersion: "tar (GNU tar) 1.35",
        xzVersion: "xz (XZ Utils) 5.4.5",
        packageVersions: { tar: 123, "xz-utils": "5.4.5" },
      }),
    /package revisions/,
  );
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
