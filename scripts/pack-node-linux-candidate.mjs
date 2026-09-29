import { parseArgumentPairs } from "./argument-pairs.ts";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File } from "./release-source.ts";
import {
  deterministicTarArguments,
  deterministicXzArguments,
  parseDpkgPackageVersions,
  parseOsRelease,
  validateLinuxArchiveToolchain,
  validateLinuxArchiveToolPaths,
  verifyCandidateDirectory,
  writeChecksums,
} from "./node-linux-release.ts";

if (process.platform !== "linux") {
  throw new Error("Linux release archives can only be created on Linux.");
}

const options = parseArguments(process.argv.slice(2));
const candidate = path.resolve(options.candidate);
const outputDirectory = path.resolve(options.outputDirectory);
const outputMetadata = await lstat(outputDirectory);
if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
  throw new Error("Archive output path must be a real directory.");
}

const manifest = await verifyCandidateDirectory(candidate);
await assertClampMtimePrecondition(candidate, Date.parse(manifest.sourceDate));
const osRelease = parseOsRelease(await readFile("/etc/os-release", "utf8"));
const tarVersion = run(options.gnuTar, ["--version"]);
const xzVersion = run(options.xz, ["--version"]);
const packageVersions = parseDpkgPackageVersions(
  run(options.dpkgQuery, [
    "--show",
    `--showformat=\${binary:Package}=\${Version}\\n`,
    "tar",
    "xz-utils",
  ]),
);
validateLinuxArchiveToolchain({ osRelease, tarVersion, xzVersion, packageVersions });

const candidateName = path.basename(candidate);
const archiveName = `${candidateName}.tar.xz`;
const archivePath = path.join(outputDirectory, archiveName);
const buildMetadataName = `${archiveName}.build.json`;
const buildMetadataPath = path.join(outputDirectory, buildMetadataName);
const checksumsName = `${archiveName}.SHA256SUMS`;
const checksumsPath = path.join(outputDirectory, checksumsName);
for (const target of [archivePath, buildMetadataPath, checksumsPath]) await assertAbsent(target);

const scratch = await mkdtemp(path.join(tmpdir(), "openbot-node-linux-archive-"));
const createdOutputs = new Set();
try {
  const tarPath = path.join(scratch, `${candidateName}.tar`);
  run(
    options.gnuTar,
    deterministicTarArguments({
      candidateName,
      sourceDateEpoch: Date.parse(manifest.sourceDate) / 1000,
      tarPath,
      parentDirectory: path.dirname(candidate),
    }),
  );
  const archiveHandle = await open(archivePath, "wx", 0o644);
  createdOutputs.add(archivePath);
  let compression;
  try {
    compression = spawnSync(options.xz, deterministicXzArguments(tarPath), {
      env: releaseEnvironment(),
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", archiveHandle.fd, "pipe"],
    });
  } finally {
    await archiveHandle.close();
  }
  if (compression.error !== undefined || compression.status !== 0) {
    await unlink(archivePath).catch(() => undefined);
    const detail = String(compression.stderr ?? "")
      .slice(0, 4_096)
      .trim();
    throw new Error(`XZ compression failed${detail === "" ? "." : `: ${detail}`}`);
  }

  const archiveMetadata = await stat(archivePath);
  if (
    !archiveMetadata.isFile() ||
    archiveMetadata.size < 1024 * 1024 ||
    archiveMetadata.size > 96 * 1024 * 1024
  ) {
    throw new Error("Compressed Linux archive is outside the reviewed size bound.");
  }
  run(options.xz, ["--test", archivePath]);
  validateArchiveMembers(run(options.gnuTar, ["--list", `--file=${archivePath}`]), candidateName);

  const buildMetadata = {
    schemaVersion: 1,
    artifact: archiveName,
    sha256: await sha256File(archivePath),
    size: archiveMetadata.size,
    sourceCommit: manifest.sourceCommit,
    sourceDate: manifest.sourceDate,
    signed: false,
    builder: {
      os: "ubuntu",
      osVersion: "24.04",
      packages: {
        tar: packageVersions.tar,
        xzUtils: packageVersions["xz-utils"],
      },
      tools: {
        gnuTar: "1.35",
        xz: "5.4.5",
      },
      compression: {
        threads: 1,
        check: "sha256",
        preset: 6,
      },
    },
  };
  await writeFile(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  createdOutputs.add(buildMetadataPath);
  await writeChecksums(outputDirectory, [archiveName, buildMetadataName], checksumsPath);
  createdOutputs.add(checksumsPath);
  process.stdout.write(
    `${JSON.stringify({ archive: archivePath, buildMetadata: buildMetadataPath, checksums: checksumsPath, signed: false }, null, 2)}\n`,
  );
} catch (error) {
  for (const target of createdOutputs) {
    await unlink(target).catch(() => undefined);
  }
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: releaseEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function releaseEnvironment() {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Release output already exists: ${path.basename(target)}.`);
}

async function assertClampMtimePrecondition(root, sourceDateMilliseconds) {
  let count = 0;
  const visit = async (directory) => {
    for (const name of await readdir(directory)) {
      count += 1;
      if (count > 300) throw new Error("Release candidate exceeds the archive entry bound.");
      const child = path.join(directory, name);
      const metadata = await lstat(child);
      if (metadata.mtimeMs < sourceDateMilliseconds) {
        throw new Error("Release candidate contains an mtime older than its source date.");
      }
      if (metadata.isDirectory()) await visit(child);
    }
  };
  const rootMetadata = await lstat(root);
  if (rootMetadata.mtimeMs < sourceDateMilliseconds) {
    throw new Error("Release candidate directory mtime is older than its source date.");
  }
  await visit(root);
}

function validateArchiveMembers(source, candidateName) {
  if (typeof source !== "string" || source.length < 1 || source.length > 128 * 1024) {
    throw new Error("Archive member listing is missing or too large.");
  }
  const members = source.trimEnd().split("\n");
  if (members.length > 300) throw new Error("Linux archive exceeds the member-count bound.");
  for (const member of members) {
    const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
    if (
      normalized !== candidateName &&
      (!normalized.startsWith(`${candidateName}/`) ||
        normalized.includes("\\") ||
        normalized.split("/").some((part) => part === "" || part === "." || part === ".."))
    ) {
      throw new Error("Linux archive contains a member outside the candidate root.");
    }
  }
}

function parseArguments(arguments_) {
  const values = parseArgumentPairs(
    arguments_,
    "Archive arguments must be unique --name value pairs.",
  );
  const allowed = new Set(["--candidate", "--dpkg-query", "--gnu-tar", "--out-dir", "--xz"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown archive argument: ${key}.`);
  }
  const requiredAbsolute = (key) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing archive argument: ${key}.`);
    if (!path.isAbsolute(value)) throw new Error(`Archive argument must be absolute: ${key}.`);
    return value;
  };
  const tools = validateLinuxArchiveToolPaths({
    dpkgQuery: requiredAbsolute("--dpkg-query"),
    gnuTar: requiredAbsolute("--gnu-tar"),
    xz: requiredAbsolute("--xz"),
  });
  return {
    candidate: requiredAbsolute("--candidate"),
    dpkgQuery: tools.dpkgQuery,
    gnuTar: tools.gnuTar,
    outputDirectory: requiredAbsolute("--out-dir"),
    xz: tools.xz,
  };
}
