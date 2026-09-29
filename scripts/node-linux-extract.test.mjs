import assert from "node:assert/strict";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractVerifiedLinuxRelease,
  linuxArchiveExtractArguments,
  linuxArchiveListArguments,
  validateLinuxArchiveInventory,
} from "./node-linux-extract.mjs";
import {
  LINUX_INSTALL_PROVENANCE_POLICY,
  linuxProvenanceCertificateIdentity,
} from "./node-linux-install-transaction.mjs";
import { sha256File } from "./release-source.ts";
import { createFileManifest, listRegularFiles, writeChecksums } from "./node-linux-release.ts";

const version = "1.2.3";
const sourceCommit = "a".repeat(40);
const rootName = "openbot-node-1.2.3-linux-x64-unsigned";

test("uses conservative absolute GNU tar and xz extraction arguments", () => {
  const archivePath = "/tmp/release.tar.xz";
  const stagingRoot = "/tmp/staging";
  assert.deepEqual(linuxArchiveListArguments(archivePath), [
    "--list",
    "--verbose",
    "--numeric-owner",
    "--quoting-style=escape",
    "--use-compress-program=/usr/bin/xz",
    "--file=/tmp/release.tar.xz",
  ]);
  assert.deepEqual(linuxArchiveExtractArguments(archivePath, stagingRoot), [
    "--extract",
    "--directory=/tmp/staging",
    "--use-compress-program=/usr/bin/xz",
    "--file=/tmp/release.tar.xz",
    "--keep-old-files",
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
    "--no-acls",
    "--no-selinux",
    "--no-xattrs",
    "--restrict",
  ]);
});

test("accepts only a sorted bounded regular-file and directory inventory", () => {
  const valid = [
    line("drwxr-xr-x", 0, `${rootName}/`),
    line("-rw-r--r--", 3, `${rootName}/LICENSE`),
    line("drwxr-xr-x", 0, `${rootName}/bin/`),
    line("-rwxr-xr-x", 4, `${rootName}/bin/node`),
  ].join("\n");
  assert.deepEqual(validateLinuxArchiveInventory(`${valid}\n`, rootName), [
    { directory: true, mode: "drwxr-xr-x", path: rootName, size: 0 },
    { directory: false, mode: "-rw-r--r--", path: `${rootName}/LICENSE`, size: 3 },
    { directory: true, mode: "drwxr-xr-x", path: `${rootName}/bin`, size: 0 },
    { directory: false, mode: "-rwxr-xr-x", path: `${rootName}/bin/node`, size: 4 },
  ]);

  const invalid = [
    `${line("lrwxrwxrwx", 0, `${rootName}/link`)} -> ../../etc`,
    line("-rw-rw-rw-", 1, `${rootName}/wide`),
    line("-rw-r--r--", 1, `${rootName}/../escape`),
    line("-rw-r--r--", 167_772_161, `${rootName}/huge`),
    line("-rw-r--r--", 1, `other-root/file`),
    [line("drwxr-xr-x", 0, `${rootName}/`), line("drwxr-xr-x", 0, `${rootName}/`)].join("\n"),
    [
      line("drwxr-xr-x", 0, `${rootName}/`),
      line("-rw-r--r--", 1, `${rootName}/z`),
      line("-rw-r--r--", 1, `${rootName}/a`),
    ].join("\n"),
  ];
  for (const source of invalid) {
    assert.throws(() => validateLinuxArchiveInventory(`${source}\n`, rootName), /Linux archive/u);
  }
});

test("extracts into a private empty root and revalidates every byte", async () => {
  await withFixture(async (fixture) => {
    const requests = [];
    const commandRunner = scriptedExtraction(fixture, requests);
    const result = await extractVerifiedLinuxRelease({
      architecture: "x64",
      archivePath: fixture.archivePath,
      commandRunner,
      sourceCommit,
      stagingRoot: fixture.stagingRoot,
      verifiedProvenance: fixture.provenance,
      version,
    });

    assert.equal(result.candidate, path.join(fixture.stagingRoot, rootName));
    assert.equal(result.archiveSha256, fixture.provenance.archiveSha256);
    assert.equal(result.manifest.sourceCommit, sourceCommit);
    assert.deepEqual(
      requests.map((request) => [request.executable, request.arguments[0]]),
      [
        ["/usr/bin/tar", "--version"],
        ["/usr/bin/xz", "--version"],
        ["/usr/bin/xz", "--test"],
        ["/usr/bin/tar", "--list"],
        ["/usr/bin/tar", "--extract"],
      ],
    );
    assert.equal(requests[4].environment.LC_ALL, "C");
    assert.equal(requests[4].timeoutMs, 60_000);
  });
});

test("cleans a partial candidate after extraction failure", async () => {
  await withFixture(async (fixture) => {
    const commandRunner = scriptedExtraction(fixture, [], { failExtraction: true });
    await assert.rejects(
      extractVerifiedLinuxRelease({
        architecture: "x64",
        archivePath: fixture.archivePath,
        commandRunner,
        sourceCommit,
        stagingRoot: fixture.stagingRoot,
        verifiedProvenance: fixture.provenance,
        version,
      }),
      /extraction command failed/,
    );
    assert.deepEqual(await readdir(fixture.stagingRoot), []);
  });
});

test("detects archive replacement during extraction and removes the candidate", async () => {
  await withFixture(async (fixture) => {
    const commandRunner = scriptedExtraction(fixture, [], { changeArchive: true });
    await assert.rejects(
      extractVerifiedLinuxRelease({
        architecture: "x64",
        archivePath: fixture.archivePath,
        commandRunner,
        sourceCommit,
        stagingRoot: fixture.stagingRoot,
        verifiedProvenance: fixture.provenance,
        version,
      }),
      /changed during extraction/,
    );
    assert.deepEqual(await readdir(fixture.stagingRoot), []);
  });
});

test("rejects insecure staging and a digest mismatch before invoking tools", async () => {
  await withFixture(async (fixture) => {
    let calls = 0;
    await chmod(fixture.stagingRoot, 0o755);
    await assert.rejects(
      extractVerifiedLinuxRelease({
        architecture: "x64",
        archivePath: fixture.archivePath,
        commandRunner: async () => {
          calls += 1;
          return success();
        },
        sourceCommit,
        stagingRoot: fixture.stagingRoot,
        verifiedProvenance: fixture.provenance,
        version,
      }),
      /private empty directory/,
    );
    assert.equal(calls, 0);

    await chmod(fixture.stagingRoot, 0o700);
    await assert.rejects(
      extractVerifiedLinuxRelease({
        architecture: "x64",
        archivePath: fixture.archivePath,
        commandRunner: async () => {
          calls += 1;
          return success();
        },
        sourceCommit,
        stagingRoot: fixture.stagingRoot,
        verifiedProvenance: { ...fixture.provenance, archiveSha256: "b".repeat(64) },
        version,
      }),
      /digest does not match/,
    );
    assert.equal(calls, 0);
  });
});

async function withFixture(operation) {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-extract-"));
  try {
    const sourceRoot = path.join(root, "source");
    const stagingRoot = path.join(root, "staging");
    const archivePath = path.join(root, "release.tar.xz");
    await mkdir(sourceRoot, { mode: 0o700 });
    await mkdir(stagingRoot, { mode: 0o700 });
    await writeFile(archivePath, "");
    await truncate(archivePath, 20 * 1024 * 1024);
    const sourceCandidate = await createCandidate(sourceRoot);
    const archiveSha256 = await sha256File(archivePath);
    return await operation({
      archivePath,
      inventory: await inventoryFor(sourceCandidate),
      provenance: provenanceFor(archiveSha256),
      sourceCandidate,
      stagingRoot,
    });
  } finally {
    await rm(root, { recursive: true });
  }
}

async function createCandidate(parent) {
  const candidate = path.join(parent, rootName);
  await mkdir(path.join(candidate, "app"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(candidate, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(candidate, "LICENSE"), "MIT\n", { mode: 0o644 });
  await writeFile(path.join(candidate, "app/index.js"), "ok\n", { mode: 0o644 });
  await writeFile(path.join(candidate, "bin/node"), "node\n", { mode: 0o755 });
  const manifest = await createFileManifest(candidate, {
    architecture: "x64",
    sourceCommit,
    sourceDateEpoch: 1_788_454_400,
    version,
  });
  await writeFile(path.join(candidate, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  await writeChecksums(
    candidate,
    await listRegularFiles(candidate),
    path.join(candidate, "SHA256SUMS"),
  );
  return candidate;
}

function scriptedExtraction(fixture, requests, behavior = {}) {
  return async (request) => {
    requests.push(request);
    if (request.arguments[0] === "--version") {
      return success(
        Buffer.from(
          request.executable.endsWith("/tar") ? "tar (GNU tar) 1.35\n" : "xz (XZ Utils) 5.4.5\n",
        ),
      );
    }
    if (request.arguments[0] === "--list") return success(Buffer.from(fixture.inventory));
    if (request.arguments[0] === "--extract") {
      await cp(fixture.sourceCandidate, path.join(fixture.stagingRoot, rootName), {
        recursive: true,
      });
      if (behavior.changeArchive) await writeFile(fixture.archivePath, "changed");
      if (behavior.failExtraction) return { ...success(), exitCode: 2 };
    }
    return success();
  };
}

async function inventoryFor(candidate) {
  const entries = [];
  const visit = async (directory, relative) => {
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const metadata = await lstat(child);
      const childRelative = `${relative}/${name}`;
      if (metadata.isDirectory()) {
        entries.push(line("drwxr-xr-x", 0, `${childRelative}/`));
        await visit(child, childRelative);
      } else {
        const mode = (metadata.mode & 0o111) === 0 ? "-rw-r--r--" : "-rwxr-xr-x";
        entries.push(line(mode, metadata.size, childRelative));
      }
    }
  };
  entries.push(line("drwxr-xr-x", 0, `${rootName}/`));
  await visit(candidate, rootName);
  entries.sort((left, right) => {
    const leftPath = pathFromLine(left);
    const rightPath = pathFromLine(right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  return `${entries.join("\n")}\n`;
}

function pathFromLine(value) {
  return value.slice(value.lastIndexOf(" ") + 1).replace(/\/$/u, "");
}

function line(mode, size, name) {
  return `${mode} 0/0 ${String(size).padStart(15)} 2026-09-04 04:15 ${name}`;
}

function provenanceFor(archiveSha256) {
  return {
    schemaVersion: 1,
    ...LINUX_INSTALL_PROVENANCE_POLICY,
    archiveSha256,
    certificateIdentity: linuxProvenanceCertificateIdentity(version),
    sourceCommit,
    sourceRef: `refs/tags/node-v${version}`,
    verifiedAt: "2026-09-04T00:00:00.000Z",
  };
}

function success(stdout = Buffer.alloc(0)) {
  return { exitCode: 0, signal: null, stdout, stderr: Buffer.alloc(0) };
}
