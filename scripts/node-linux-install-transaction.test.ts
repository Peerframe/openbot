import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withLinuxInstallLease } from "./node-linux-install-lease.ts";
import {
  installStagedLinuxRelease,
  readCurrentTarget,
  recoverLinuxInstallTransaction,
} from "./node-linux-install-transaction.ts";
import {
  LINUX_INSTALL_PROVENANCE_POLICY,
  linuxProvenanceCertificateIdentity,
  validateLinuxInstallProvenance,
} from "./node-linux-provenance.ts";
import {
  createFileManifest,
  linuxInstalledReleaseName,
  listRegularFiles,
  writeChecksums,
} from "./node-linux-release.ts";

const fixedTime = new Date("2026-09-04T00:00:00.000Z");
const transactionIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
];

test("binds installation identity and provenance to the exact release", () => {
  const manifest = manifestFor("1.2.3", "a".repeat(40));
  assert.equal(
    linuxInstalledReleaseName(manifest),
    `openbot-node-1.2.3-linux-x64-${"a".repeat(40)}`,
  );
  assert.doesNotThrow(() => validateLinuxInstallProvenance(provenanceFor(manifest), manifest));
  assert.throws(
    () =>
      validateLinuxInstallProvenance(
        { ...provenanceFor(manifest), sourceRef: "refs/tags/node-v1.2.4" },
        manifest,
      ),
    /source ref/,
  );
  assert.throws(
    () =>
      validateLinuxInstallProvenance(
        { ...provenanceFor(manifest), runnerEnvironment: "self-hosted" },
        manifest,
      ),
    /runnerEnvironment/,
  );
  assert.throws(
    () =>
      validateLinuxInstallProvenance(
        { ...provenanceFor(manifest), certificateIdentity: "https://github.com/example/other" },
        manifest,
      ),
    /certificate identity/,
  );
});

test("first install selects verified bytes without starting an inactive service", async () => {
  const fixture = await createFixture();
  const candidate = await createCandidate(fixture.installRoot, "1.0.0", "a".repeat(40));
  const service = scriptedService({ activeResults: [false] });
  const manifest = manifestFor("1.0.0", "a".repeat(40));

  const result = await install(fixture, candidate, manifest, service, transactionIds[0]);

  assert.equal(result.restarted, false);
  assert.equal(result.rolledBack, false);
  assert.deepEqual(service.calls, ["is-active"]);
  assert.equal(await readCurrentTarget(fixture.installRoot), `versions/${result.releaseName}`);
  assert.equal(
    await readlink(path.join(fixture.installRoot, "current")),
    `versions/${result.releaseName}`,
  );
  assert.equal(await pathType(path.join(fixture.stateRoot, "transaction.json")), "missing");
  const receipt: unknown = JSON.parse(
    await readFile(path.join(fixture.stateRoot, "last-success.json"), "utf8"),
  );
  assert.equal(field(receipt, "outcome"), "activated");
  assert.equal(field(receipt, "serviceWasActive"), false);
});

test("active upgrade restarts only after the atomic version switch", async () => {
  const fixture = await createFixture();
  const first = await createCandidate(fixture.installRoot, "1.0.0", "b".repeat(40));
  await install(
    fixture,
    first,
    manifestFor("1.0.0", "b".repeat(40)),
    scriptedService({ activeResults: [false] }),
    transactionIds[0],
  );
  const second = await createCandidate(fixture.installRoot, "1.1.0", "c".repeat(40));
  const service = scriptedService({ activeResults: [true, true] });

  const result = await install(
    fixture,
    second,
    manifestFor("1.1.0", "c".repeat(40)),
    service,
    transactionIds[1],
  );

  assert.equal(result.restarted, true);
  assert.deepEqual(service.calls, ["is-active", "restart", "is-active"]);
  assert.equal(await readCurrentTarget(fixture.installRoot), `versions/${result.releaseName}`);
  assert.equal(
    field(
      JSON.parse(await readFile(path.join(fixture.stateRoot, "last-success.json"), "utf8")),
      "outcome",
    ),
    "activated",
  );
});

test("installation joins an outer bootstrap lease without releasing it", async () => {
  const fixture = await createFixture();
  await mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 });
  const candidate = await createCandidate(fixture.installRoot, "1.0.0", "3".repeat(40));
  const lockPath = path.join(fixture.stateRoot, "transaction.lock");

  await withLinuxInstallLease({ stateRoot: fixture.stateRoot }, async (installLease) => {
    await installStagedLinuxRelease({
      architecture: "x64",
      candidate,
      installLease,
      installRoot: fixture.installRoot,
      now: () => fixedTime,
      service: scriptedService({ activeResults: [false] }),
      stateRoot: fixture.stateRoot,
      transactionId: transactionIds[1],
      verifiedProvenance: provenanceFor(manifestFor("1.0.0", "3".repeat(40))),
    });
    assert.equal((await lstat(lockPath)).isDirectory(), true);
  });

  assert.equal(await pathType(lockPath), "missing");
});

test("failed upgrade restores and rechecks the previous active release", async () => {
  const fixture = await installedFixture("1.0.0", "d".repeat(40));
  const previousTarget = await readCurrentTarget(fixture.installRoot);
  const candidate = await createCandidate(fixture.installRoot, "1.1.0", "e".repeat(40));
  const service = scriptedService({ activeResults: [true, true], restartFailures: [1] });

  await assert.rejects(
    install(fixture, candidate, manifestFor("1.1.0", "e".repeat(40)), service, transactionIds[1]),
    /previous release was restored/,
  );

  assert.deepEqual(service.calls, ["is-active", "restart", "restart", "is-active"]);
  assert.equal(await readCurrentTarget(fixture.installRoot), previousTarget);
  assert.equal(
    field(
      JSON.parse(await readFile(path.join(fixture.stateRoot, "last-success.json"), "utf8")),
      "outcome",
    ),
    "rolled-back",
  );
  assert.equal(await pathType(path.join(fixture.stateRoot, "transaction.json")), "missing");
});

test("failed recovery keeps both releases and a bounded recovery journal", async () => {
  const fixture = await installedFixture("1.0.0", "f".repeat(40));
  const previousTarget = await readCurrentTarget(fixture.installRoot);
  const candidate = await createCandidate(fixture.installRoot, "1.1.0", "1".repeat(40));
  const service = scriptedService({ activeResults: [true], restartFailures: [1, 2] });

  await assert.rejects(
    install(fixture, candidate, manifestFor("1.1.0", "1".repeat(40)), service, transactionIds[1]),
    /manual recovery is required/,
  );

  assert.equal(await readCurrentTarget(fixture.installRoot), previousTarget);
  const journal: unknown = JSON.parse(
    await readFile(path.join(fixture.stateRoot, "transaction.json"), "utf8"),
  );
  assert.equal(field(journal, "phase"), "recovery-failed");
  assert.equal(
    (await lstat(path.join(fixture.installRoot, present(previousTarget)))).isDirectory(),
    true,
  );
  assert.equal(
    (
      await lstat(path.join(fixture.installRoot, `versions/${field(journal, "releaseName")}`))
    ).isDirectory(),
    true,
  );
});

test("explicit recovery clears a staged journal only when selection and service still match", async () => {
  const fixture = await installedFixture("1.0.0", "8".repeat(40));
  const interrupted = await interruptUpgrade(fixture, {
    phase: "staged",
    selectNew: false,
    serviceWasActive: true,
    sourceCommit: "9".repeat(40),
    version: "1.1.0",
  });
  const service = scriptedService({ activeResults: [true] });

  const result = await recover(fixture, service);

  assert.equal(result.outcome, "recovered-before-switch");
  assert.equal(result.restarted, false);
  assert.equal(await readCurrentTarget(fixture.installRoot), interrupted.previousTarget);
  assert.deepEqual(service.calls, ["is-active"]);
  assert.equal(await pathType(path.join(fixture.stateRoot, "transaction.json")), "missing");
  assert.equal(
    field(
      JSON.parse(await readFile(path.join(fixture.stateRoot, "last-success.json"), "utf8")),
      "outcome",
    ),
    "recovered-before-switch",
  );
});

test("explicit recovery restores and rechecks the recorded previous active release", async () => {
  const fixture = await installedFixture("1.0.0", "a".repeat(40));
  const interrupted = await interruptUpgrade(fixture, {
    phase: "switched",
    selectNew: true,
    serviceWasActive: true,
    sourceCommit: "b".repeat(40),
    version: "1.1.0",
  });
  const service = scriptedService({ activeResults: [false, true] });

  const result = await recover(fixture, service);

  assert.equal(result.outcome, "recovered-previous");
  assert.equal(result.restarted, true);
  assert.equal(await readCurrentTarget(fixture.installRoot), interrupted.previousTarget);
  assert.deepEqual(service.calls, ["is-active", "restart", "is-active"]);
  assert.equal(
    (await lstat(path.join(fixture.installRoot, interrupted.target))).isDirectory(),
    true,
  );
});

test("explicit recovery never starts a service that was previously inactive", async () => {
  const fixture = await installedFixture("1.0.0", "c".repeat(40));
  const interrupted = await interruptUpgrade(fixture, {
    phase: "switched",
    selectNew: true,
    serviceWasActive: false,
    sourceCommit: "d".repeat(40),
    version: "1.1.0",
  });
  const service = scriptedService({ activeResults: [false] });

  const result = await recover(fixture, service);

  assert.equal(result.restarted, false);
  assert.equal(await readCurrentTarget(fixture.installRoot), interrupted.previousTarget);
  assert.deepEqual(service.calls, ["is-active"]);
});

test("explicit recovery preserves an untrusted journal byte-for-byte without side effects", async () => {
  const fixture = await installedFixture("1.0.0", "e".repeat(40));
  const interrupted = await interruptUpgrade(fixture, {
    phase: "staged",
    selectNew: false,
    serviceWasActive: false,
    sourceCommit: "f".repeat(40),
    version: "1.1.0",
  });
  const journalPath = path.join(fixture.stateRoot, "transaction.json");
  const hostile = `${JSON.stringify({ ...interrupted.journal, authority: "attacker" }, null, 2)}\n`;
  await writeFile(journalPath, hostile, { mode: 0o600 });
  const service = scriptedService({ activeResults: [] });

  await assert.rejects(recover(fixture, service), /unknown fields/);

  assert.equal(await readFile(journalPath, "utf8"), hostile);
  assert.equal(await readCurrentTarget(fixture.installRoot), interrupted.previousTarget);
  assert.deepEqual(service.calls, []);
});

test("explicit recovery retains both releases and marks a failed retry for manual handling", async () => {
  const fixture = await installedFixture("1.0.0", "1".repeat(40));
  const interrupted = await interruptUpgrade(fixture, {
    phase: "recovery-failed",
    selectNew: true,
    serviceWasActive: true,
    sourceCommit: "2".repeat(40),
    version: "1.1.0",
  });
  const service = scriptedService({ activeResults: [true], restartFailures: [1] });

  await assert.rejects(recover(fixture, service), /manual recovery is required/);

  assert.equal(await readCurrentTarget(fixture.installRoot), interrupted.previousTarget);
  assert.equal(
    field(
      JSON.parse(await readFile(path.join(fixture.stateRoot, "transaction.json"), "utf8")),
      "phase",
    ),
    "recovery-failed",
  );
  assert.equal(
    (
      await lstat(path.join(fixture.installRoot, present(interrupted.previousTarget)))
    ).isDirectory(),
    true,
  );
  assert.equal(
    (await lstat(path.join(fixture.installRoot, interrupted.target))).isDirectory(),
    true,
  );
});

test("identical reinstall is a no-op and conflicting policy fails before selection", async () => {
  const fixture = await installedFixture("1.0.0", "2".repeat(40));
  const previousTarget = await readCurrentTarget(fixture.installRoot);
  const candidate = await createCandidate(fixture.installRoot, "1.0.0", "2".repeat(40));
  const service = scriptedService({ activeResults: [true] });

  const result = await install(
    fixture,
    candidate,
    manifestFor("1.0.0", "2".repeat(40)),
    service,
    transactionIds[1],
  );
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.restarted, false);
  assert.deepEqual(service.calls, ["is-active"]);
  assert.equal(await readCurrentTarget(fixture.installRoot), previousTarget);

  const rejected = await createCandidate(fixture.installRoot, "1.1.0", "3".repeat(40));
  await assert.rejects(
    installStagedLinuxRelease({
      architecture: "x64",
      candidate: rejected,
      installRoot: fixture.installRoot,
      now: () => fixedTime,
      service: scriptedService({ activeResults: [false] }),
      stateRoot: fixture.stateRoot,
      transactionId: transactionIds[2],
      verifiedProvenance: {
        ...provenanceFor(manifestFor("1.1.0", "3".repeat(40))),
        signerWorkflow: "attacker/repo/.github/workflows/release.yml",
      },
    }),
    /signerWorkflow/,
  );
  assert.equal(await readCurrentTarget(fixture.installRoot), previousTarget);
});

test("malformed current pointers and unfinished journals fail closed", async () => {
  const fixture = await createFixture();
  await mkdir(path.join(fixture.installRoot, "staging"), { recursive: true });
  await symlink("../../etc", path.join(fixture.installRoot, "current"));
  const candidate = await createCandidate(fixture.installRoot, "1.0.0", "4".repeat(40));
  await assert.rejects(
    install(
      fixture,
      candidate,
      manifestFor("1.0.0", "4".repeat(40)),
      scriptedService({ activeResults: [false] }),
      transactionIds[0],
    ),
    /malformed or escapes/,
  );

  const second = await createFixture();
  await mkdir(second.stateRoot, { recursive: true });
  await writeFile(path.join(second.stateRoot, "transaction.json"), "{}\n", { mode: 0o600 });
  const blocked = await createCandidate(second.installRoot, "1.0.0", "5".repeat(40));
  await assert.rejects(
    install(
      second,
      blocked,
      manifestFor("1.0.0", "5".repeat(40)),
      scriptedService({ activeResults: [false] }),
      transactionIds[0],
    ),
    /recovery is required/,
  );
});

test("architecture mismatch and an existing transaction lock fail before activation", async () => {
  const fixture = await createFixture();
  const candidate = await createCandidate(fixture.installRoot, "1.0.0", "6".repeat(40));
  await assert.rejects(
    installStagedLinuxRelease({
      architecture: "arm64",
      candidate,
      installRoot: fixture.installRoot,
      now: () => fixedTime,
      service: scriptedService({ activeResults: [false] }),
      stateRoot: fixture.stateRoot,
      transactionId: transactionIds[0],
      verifiedProvenance: provenanceFor(manifestFor("1.0.0", "6".repeat(40))),
    }),
    /architecture does not match/,
  );
  assert.equal(await pathType(path.join(fixture.installRoot, "current")), "missing");

  const locked = await createFixture();
  await mkdir(path.join(locked.stateRoot, "transaction.lock"), { recursive: true });
  const blocked = await createCandidate(locked.installRoot, "1.0.0", "7".repeat(40));
  await assert.rejects(
    install(
      locked,
      blocked,
      manifestFor("1.0.0", "7".repeat(40)),
      scriptedService({ activeResults: [false] }),
      transactionIds[0],
    ),
    /stale lock exists/,
  );
});

interface TransactionFixture {
  readonly installRoot: string;
  readonly stateRoot: string;
}

interface InterruptedUpgrade {
  readonly phase: string;
  readonly selectNew: boolean;
  readonly serviceWasActive: boolean;
  readonly sourceCommit: string;
  readonly version: string;
}

interface ScriptedServiceOptions {
  readonly activeResults: boolean[];
  readonly restartFailures?: readonly number[];
}

async function installedFixture(
  version: string,
  sourceCommit: string,
): Promise<TransactionFixture> {
  const fixture = await createFixture();
  const candidate = await createCandidate(fixture.installRoot, version, sourceCommit);
  await install(
    fixture,
    candidate,
    manifestFor(version, sourceCommit),
    scriptedService({ activeResults: [false] }),
    transactionIds[0],
  );
  return fixture;
}

async function createFixture(): Promise<TransactionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-linux-install-test-"));
  return {
    installRoot: path.join(root, "opt/openbot-node"),
    stateRoot: path.join(root, "var/lib/openbot-node-installer"),
  };
}

async function createCandidate(
  installRoot: string,
  version: string,
  sourceCommit: string,
): Promise<string> {
  const manifestInput = manifestFor(version, sourceCommit);
  const candidate = path.join(
    installRoot,
    "staging",
    `openbot-node-${version}-linux-${manifestInput.architecture}-unsigned`,
  );
  await mkdir(path.join(candidate, "app"), { recursive: true });
  await writeFile(
    path.join(candidate, "app/index.js"),
    `export const version = ${JSON.stringify(version)};\n`,
    {
      mode: 0o644,
    },
  );
  const manifest = await createFileManifest(candidate, {
    architecture: manifestInput.architecture,
    sourceCommit,
    sourceDateEpoch: 1_700_000_000,
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

async function interruptUpgrade(
  fixture: TransactionFixture,
  { phase, selectNew, serviceWasActive, sourceCommit, version }: InterruptedUpgrade,
) {
  const previousTarget = await readCurrentTarget(fixture.installRoot);
  const candidate = await createCandidate(fixture.installRoot, version, sourceCommit);
  const manifest = manifestFor(version, sourceCommit);
  const releaseName = linuxInstalledReleaseName(manifest);
  const target = `versions/${releaseName}`;
  await rename(candidate, path.join(fixture.installRoot, target));
  if (selectNew) {
    await unlink(path.join(fixture.installRoot, "current"));
    await symlink(target, path.join(fixture.installRoot, "current"));
  }
  const journal = {
    schemaVersion: 1,
    transactionId: transactionIds[3],
    phase,
    releaseName,
    target,
    previousTarget,
    serviceWasActive,
    archiveSha256: "9".repeat(64),
    sourceCommit,
    sourceRef: `refs/tags/node-v${version}`,
    createdAt: fixedTime.toISOString(),
  };
  await writeFile(
    path.join(fixture.stateRoot, "transaction.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { journal, previousTarget, target };
}

function manifestFor(version: string, sourceCommit: string) {
  return {
    architecture: "x64",
    platform: "linux",
    sourceCommit,
    version,
  };
}

function provenanceFor(manifest: { readonly sourceCommit: string; readonly version: string }) {
  return {
    schemaVersion: 1,
    ...LINUX_INSTALL_PROVENANCE_POLICY,
    archiveSha256: "9".repeat(64),
    certificateIdentity: linuxProvenanceCertificateIdentity(manifest.version),
    sourceCommit: manifest.sourceCommit,
    sourceRef: `refs/tags/node-v${manifest.version}`,
    verifiedAt: fixedTime.toISOString(),
  };
}

function scriptedService({ activeResults, restartFailures = [] }: ScriptedServiceOptions) {
  const calls: string[] = [];
  let restartCount = 0;
  return {
    calls,
    async isActive() {
      calls.push("is-active");
      const next = activeResults.shift();
      if (next === undefined) throw new Error("Unexpected is-active call.");
      return next;
    },
    async restartSelected() {
      calls.push("restart");
      restartCount += 1;
      if (restartFailures.includes(restartCount)) throw new Error("Simulated restart failure.");
    },
  };
}

function install(
  fixture: TransactionFixture,
  candidate: string,
  manifest: { readonly sourceCommit: string; readonly version: string },
  service: unknown,
  transactionId: unknown,
) {
  return installStagedLinuxRelease({
    architecture: "x64",
    candidate,
    installRoot: fixture.installRoot,
    now: () => fixedTime,
    service,
    stateRoot: fixture.stateRoot,
    transactionId,
    verifiedProvenance: provenanceFor(manifest),
  });
}

function recover(fixture: TransactionFixture, service: unknown) {
  return recoverLinuxInstallTransaction({
    installRoot: fixture.installRoot,
    now: () => fixedTime,
    recoveryId: transactionIds[4],
    service,
    stateRoot: fixture.stateRoot,
  });
}

async function pathType(filePath: string): Promise<"directory" | "file" | "missing"> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (field(error, "code") === "ENOENT") return "missing";
    throw error;
  }
}

function field(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(Object(value), key);
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new TypeError("Expected a recorded value.");
  return value;
}
