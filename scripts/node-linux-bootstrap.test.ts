import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeLinuxReleaseInstall,
  type LinuxReleaseInstallAdapters,
  type LinuxReleaseInstallCompositionOptions,
} from "./node-linux-bootstrap.ts";
import { withLinuxInstallLease } from "./node-linux-install-lease.ts";

type MutableAdapters = {
  -readonly [K in keyof LinuxReleaseInstallAdapters]: LinuxReleaseInstallAdapters[K];
};

interface RecordingAdapters extends MutableAdapters {
  readonly seen: Record<string, unknown>;
}

interface BootstrapFixture {
  readonly candidate: string;
  readonly importedArchive: string;
  readonly layout: {
    readonly importsRoot: string;
    readonly installRoot: string;
    readonly stagingRoot: string;
    readonly stateRoot: string;
    readonly versionsRoot: string;
  };
  readonly sourceArchive: string;
}

const archiveSha256 = "a".repeat(64);
const sourceCommit = "b".repeat(40);
const version = "1.2.3";
const importId = "00000000-0000-4000-8000-000000000001";

test("composes private import, provenance, extraction, activation, and cleanup in order", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];
  const adapters = successfulAdapters(fixture, calls);

  const result = await composeLinuxReleaseInstall(installOptions(fixture), adapters);

  assert.deepEqual(result, { releaseName: "installed" });
  assert.deepEqual(calls, ["import", "provenance", "extract", "install", "cleanup"]);
  assert.equal(adapters.seen.importedSource, fixture.sourceArchive);
  assert.equal(adapters.seen.verifiedArchive, fixture.importedArchive);
  assert.equal(adapters.seen.extractedArchive, fixture.importedArchive);
  assert.equal(adapters.seen.installedCandidate, fixture.candidate);
  assert.equal(adapters.seen.sameLease, true);
});

test("never proves or extracts the user-writable source path", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];
  const adapters = successfulAdapters(fixture, calls);

  adapters.verifyProvenance = async (request) => {
    calls.push("provenance");
    assert.equal(request.archivePath, fixture.importedArchive);
    return { archiveSha256: "c".repeat(64) };
  };

  await assert.rejects(
    composeLinuxReleaseInstall(installOptions(fixture), adapters),
    /does not match the private imported archive/,
  );
  assert.deepEqual(calls, ["import", "provenance"]);
});

test("preserves private evidence and never activates an invalid extracted candidate", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];
  const adapters = successfulAdapters(fixture, calls);
  adapters.extractArchive = async () => {
    calls.push("extract");
    return {
      archiveSha256,
      candidate: path.join(fixture.layout.versionsRoot, "escaped"),
      manifest: { architecture: "x64", sourceCommit, version },
    };
  };

  await assert.rejects(
    composeLinuxReleaseInstall(installOptions(fixture), adapters),
    /invalid candidate/,
  );
  assert.deepEqual(calls, ["import", "provenance", "extract"]);
});

test("requires explicit recovery and empty work roots before importing", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];
  const adapters = successfulAdapters(fixture, calls);
  await writeFile(path.join(fixture.layout.stateRoot, "transaction.json"), "{}\n");

  await assert.rejects(
    composeLinuxReleaseInstall(installOptions(fixture), adapters),
    /explicit recovery/,
  );
  assert.deepEqual(calls, []);

  const second = await createFixture();
  const secondCalls: string[] = [];
  const secondAdapters = successfulAdapters(second, secondCalls);
  await writeFile(path.join(second.layout.stagingRoot, "unexpected"), "data");
  await assert.rejects(
    composeLinuxReleaseInstall(installOptions(second), secondAdapters),
    /empty staging/,
  );
  assert.deepEqual(secondCalls, []);
});

function successfulAdapters(fixture: BootstrapFixture, calls: string[]): RecordingAdapters {
  const seen: Record<string, unknown> = {};
  let outerLease: unknown;
  return {
    seen,
    service: { isActive() {}, restartSelected() {} },
    withLease: async (options, operation) =>
      withLinuxInstallLease(options, async (lease) => {
        outerLease = lease;
        return await operation(lease);
      }),
    async importArchive(request) {
      calls.push("import");
      seen.importedSource = request.sourcePath;
      seen.importLease = request.installLease;
      return { archivePath: fixture.importedArchive, archiveSha256, size: 20 * 1024 * 1024 };
    },
    async verifyProvenance(request) {
      calls.push("provenance");
      seen.verifiedArchive = request.archivePath;
      return { archiveSha256 };
    },
    async extractArchive(request) {
      calls.push("extract");
      seen.extractedArchive = request.archivePath;
      return {
        archiveSha256,
        candidate: fixture.candidate,
        manifest: { architecture: "x64", sourceCommit, version },
      };
    },
    async installRelease(request) {
      calls.push("install");
      seen.installedCandidate = request.candidate;
      seen.installLease = request.installLease;
      return { releaseName: "installed" };
    },
    async removeImportedArchive(request) {
      calls.push("cleanup");
      seen.cleanupLease = request.installLease;
      seen.sameLease =
        outerLease === seen.importLease &&
        outerLease === seen.installLease &&
        outerLease === seen.cleanupLease;
    },
  };
}

function installOptions(fixture: BootstrapFixture): LinuxReleaseInstallCompositionOptions {
  return {
    architecture: "x64",
    archivePath: fixture.sourceArchive,
    importId,
    layout: fixture.layout,
    sourceCommit,
    transactionId: "00000000-0000-4000-8000-000000000002",
    version,
  };
}

async function createFixture(): Promise<BootstrapFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-linux-bootstrap-test-"));
  const layout = {
    importsRoot: path.join(root, "state/imports"),
    installRoot: path.join(root, "install"),
    stagingRoot: path.join(root, "install/staging"),
    stateRoot: path.join(root, "state"),
    versionsRoot: path.join(root, "install/versions"),
  };
  await Promise.all([
    mkdir(layout.importsRoot, { recursive: true, mode: 0o700 }),
    mkdir(layout.stagingRoot, { recursive: true, mode: 0o700 }),
    mkdir(layout.versionsRoot, { recursive: true, mode: 0o755 }),
  ]);
  return {
    candidate: path.join(layout.stagingRoot, `openbot-node-${version}-linux-x64-unsigned`),
    importedArchive: path.join(layout.importsRoot, `openbot-node-import-${importId}.tar.xz`),
    layout,
    sourceArchive: path.join(root, "source.tar.xz"),
  };
}
