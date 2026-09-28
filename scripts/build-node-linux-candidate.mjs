import { parseArgumentPairs } from "./argument-pairs.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NCC_VERSION,
  RELEASE_NPM_VERSION,
  assertSourceDateEpoch,
  assertSourceTreeState,
  assertReleaseVersion,
  assertSourceCommit,
  canonicalizeSpdxSbom,
  copyReleaseFile,
  createFileManifest,
  listRegularFiles,
  validateNccStats,
  validateSpdxSbom,
  verifyNodeRuntimeArchive,
  writeChecksums,
  writeProductionSbomProjection,
} from "./node-linux-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const version = assertReleaseVersion(options.version);
const sourceCommit = assertSourceCommit(options.sourceCommit);
const sourceDateEpoch = assertSourceDateEpoch(options.sourceDateEpoch);
assertSourceTreeState(
  sourceCommit,
  run("git", ["rev-parse", "HEAD"]),
  run("git", ["status", "--porcelain=v1", "--untracked-files=normal"]),
);
const runtimeTarget = await verifyNodeRuntimeArchive(options.nodeArchive, options.architecture);
const npmVersion = run(options.npmCli, ["--version"]).trim();
if (npmVersion !== RELEASE_NPM_VERSION) {
  throw new Error(`Release SBOM requires npm ${RELEASE_NPM_VERSION}; received ${npmVersion}.`);
}

const nccManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "node_modules/@vercel/ncc/package.json"), "utf8"),
);
if (nccManifest.version !== NCC_VERSION)
  throw new Error(`Release bundling requires ncc ${NCC_VERSION}.`);

const scratch = await mkdtemp(path.join(tmpdir(), "openbot-node-linux-release-"));
const bundleDirectory = path.join(scratch, "bundle");
const statsPath = path.join(scratch, "ncc-stats.json");
run(
  process.execPath,
  [
    path.join(repositoryRoot, "node_modules/@vercel/ncc/dist/ncc/cli.js"),
    "build",
    path.join(repositoryRoot, "apps/node/dist/index.js"),
    "--out",
    bundleDirectory,
    "--no-cache",
    "--quiet",
    "--license",
    "third-party-licenses.txt",
    "--stats-out",
    statsPath,
    "--target",
    "es2022",
  ],
  repositoryRoot,
);
const stats = JSON.parse(await readFile(statsPath, "utf8"));
validateNccStats(stats, await readdir(bundleDirectory));

const projection = path.join(scratch, "sbom-projection");
const lockfile = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
const graph = await writeProductionSbomProjection({ destination: projection, lockfile, version });
const sbomText = run(
  options.npmCli,
  [
    "sbom",
    "--package-lock-only",
    "--omit=dev",
    "--workspace",
    "@openbot/node",
    "--sbom-format=spdx",
    "--sbom-type=application",
  ],
  projection,
);
const sbom = canonicalizeSpdxSbom(validateSpdxSbom(JSON.parse(sbomText), graph, lockfile), {
  architecture: options.architecture,
  version,
  sourceCommit,
  sourceDateEpoch,
});

const extraction = path.join(scratch, "runtime");
await mkdir(extraction);
run(
  "tar",
  [
    "-xJf",
    path.resolve(options.nodeArchive),
    "-C",
    extraction,
    `${runtimeTarget.directory}/bin/node`,
    `${runtimeTarget.directory}/LICENSE`,
  ],
  repositoryRoot,
);

const candidateName = `openbot-node-${version}-linux-${options.architecture}-unsigned`;
await mkdir(options.outputDirectory, { recursive: true });
const candidate = path.resolve(options.outputDirectory, candidateName);
await mkdir(candidate);
await copyReleaseFile(
  path.join(extraction, runtimeTarget.directory, "bin/node"),
  path.join(candidate, "bin/node"),
  0o755,
);
await copyReleaseFile(
  path.join(extraction, runtimeTarget.directory, "LICENSE"),
  path.join(candidate, "licenses/NODE_LICENSE"),
);
await copyReleaseFile(path.join(repositoryRoot, "LICENSE"), path.join(candidate, "LICENSE"));
await copyReleaseFile(
  path.join(repositoryRoot, "docs/NODE_ENROLLMENT.md"),
  path.join(candidate, "docs/NODE_ENROLLMENT.md"),
);
await copyReleaseFile(
  path.join(repositoryRoot, "docs/NODE_ENROLLMENT.zh-CN.md"),
  path.join(candidate, "docs/NODE_ENROLLMENT.zh-CN.md"),
);
await copyReleaseFile(
  path.join(repositoryRoot, "deploy/node/systemd/openbot-node.service"),
  path.join(candidate, "systemd/openbot-node.service"),
);
await copyReleaseFile(
  path.join(repositoryRoot, "deploy/node/systemd/openbot-node-user.service"),
  path.join(candidate, "systemd/openbot-node-user.service"),
);
for (const name of await readdir(bundleDirectory)) {
  await copyReleaseFile(path.join(bundleDirectory, name), path.join(candidate, "app", name));
}
await writeFile(path.join(candidate, "SBOM.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
  flag: "wx",
});

const manifest = await createFileManifest(candidate, {
  architecture: options.architecture,
  version,
  sourceCommit,
  sourceDateEpoch,
});
await writeFile(path.join(candidate, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
  flag: "wx",
});
await writeChecksums(
  candidate,
  await listRegularFiles(candidate),
  path.join(candidate, "SHA256SUMS"),
);
process.stdout.write(`${JSON.stringify({ candidate, signed: false }, null, 2)}\n`);

function run(command, args, cwd = repositoryRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArguments(arguments_) {
  const values = parseArgumentPairs(
    arguments_,
    "Release arguments must be unique --name value pairs.",
  );
  const allowed = new Set([
    "--arch",
    "--node-archive",
    "--npm-cli",
    "--out-dir",
    "--source-commit",
    "--source-date-epoch",
    "--version",
  ]);
  for (const key of values.keys())
    if (!allowed.has(key)) throw new Error(`Unknown release argument: ${key}.`);
  const required = (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing release argument: ${key}.`);
    return value;
  };
  return {
    architecture: required("--arch"),
    nodeArchive: path.resolve(required("--node-archive")),
    npmCli: path.resolve(required("--npm-cli")),
    outputDirectory: path.resolve(required("--out-dir")),
    sourceCommit: required("--source-commit"),
    sourceDateEpoch: required("--source-date-epoch"),
    version: required("--version"),
  };
}
