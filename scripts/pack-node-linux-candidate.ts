import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { lstat, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertClampMtimePrecondition,
  assertOutputAbsent,
  CANDIDATE_ARCHIVE_SIZE_BOUNDS,
  ExclusiveOutputs,
  parseCandidateArchiveArguments,
  releaseCommandEnvironment,
  runReleaseCommand as run,
  validateArchiveMembers,
  withOwnedScratch,
} from "./node-linux-candidate.ts";
import {
  deterministicTarArguments,
  deterministicXzArguments,
  parseDpkgPackageVersions,
  parseOsRelease,
  validateLinuxArchiveToolchain,
  verifyCandidateDirectory,
  writeChecksums,
} from "./node-linux-release.ts";
import { sha256File } from "./release-source.ts";

if (process.platform !== "linux") {
  throw new Error("Linux release archives can only be created on Linux.");
}

const options = parseCandidateArchiveArguments(process.argv.slice(2));
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
for (const target of [archivePath, buildMetadataPath, checksumsPath]) {
  await assertOutputAbsent(target);
}

const outputs = new ExclusiveOutputs();
await withOwnedScratch("openbot-node-linux-archive-", async (scratch) => {
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
    const archiveHandle = await outputs.claim(archivePath, () => open(archivePath, "wx", 0o644));
    let compression: SpawnSyncReturns<Buffer>;
    try {
      compression = spawnSync(options.xz, deterministicXzArguments(tarPath), {
        env: releaseCommandEnvironment(),
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", archiveHandle.fd, "pipe"],
      });
    } finally {
      await archiveHandle.close();
    }
    if (compression.error !== undefined || compression.status !== 0) {
      const detail = String(compression.stderr ?? "")
        .slice(0, 4_096)
        .trim();
      throw new Error(`XZ compression failed${detail === "" ? "." : `: ${detail}`}`);
    }

    const archiveMetadata = await stat(archivePath);
    if (
      !archiveMetadata.isFile() ||
      archiveMetadata.size < CANDIDATE_ARCHIVE_SIZE_BOUNDS.minimumBytes ||
      archiveMetadata.size > CANDIDATE_ARCHIVE_SIZE_BOUNDS.maximumBytes
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
    await outputs.claim(buildMetadataPath, () =>
      writeFile(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
        flag: "wx",
      }),
    );
    await outputs.claim(checksumsPath, () =>
      writeChecksums(outputDirectory, [archiveName, buildMetadataName], checksumsPath),
    );
  } catch (error) {
    await outputs.rollback();
    throw error;
  }
});
process.stdout.write(
  `${JSON.stringify({ archive: archivePath, buildMetadata: buildMetadataPath, checksums: checksumsPath, signed: false }, null, 2)}\n`,
);
