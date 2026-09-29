import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { enterLinuxInstallLease } from "./node-linux-install-lease.ts";
import { validateLinuxInstallProvenance } from "./node-linux-provenance.ts";
import {
  type LinuxReleaseManifest,
  linuxInstalledReleaseName,
  verifyCandidateDirectory,
  verifyInstalledLinuxReleaseDirectory,
} from "./node-linux-release.ts";

/** Bounded service seam; each operation receives an AbortSignal tied to its deadline. */
export interface LinuxInstallServiceAdapter {
  readonly isActive: (signal: AbortSignal) => unknown;
  readonly restartSelected: (signal: AbortSignal) => unknown;
}

export interface LinuxStagedInstallOptions {
  readonly architecture: unknown;
  readonly candidate: string;
  readonly installLease?: unknown;
  readonly installRoot: unknown;
  readonly now?: (() => unknown) | undefined;
  readonly service: unknown;
  readonly serviceDeadlineMs?: unknown;
  readonly stateRoot: unknown;
  readonly transactionId?: unknown;
  readonly verifiedProvenance: unknown;
}

export interface LinuxStagedInstallResult {
  readonly alreadyInstalled: boolean;
  readonly releaseName: string;
  readonly restarted: boolean;
  readonly rolledBack: false;
}

export interface LinuxInstallRecoveryOptions {
  readonly installLease?: unknown;
  readonly installRoot: unknown;
  readonly now?: (() => unknown) | undefined;
  readonly recoveryId?: unknown;
  readonly service: unknown;
  readonly serviceDeadlineMs?: unknown;
  readonly stateRoot: unknown;
}

export interface LinuxInstallRecoveryResult {
  readonly outcome: "recovered-before-switch" | "recovered-previous";
  readonly releaseName: string;
  readonly restarted: boolean;
  readonly restoredTarget: string | null;
}

/** Transaction journal; key order here is the on-disk canonical order. */
interface LinuxInstallJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly phase: string;
  readonly releaseName: string;
  readonly target: string;
  readonly previousTarget: string | null;
  readonly serviceWasActive: boolean;
  readonly archiveSha256: unknown;
  readonly sourceCommit: unknown;
  readonly sourceRef: string;
  readonly createdAt: string;
}

const maximumServiceDeadlineMs = 60_000;

/**
 * Rootless transaction core. A future privileged bootstrap must obtain `verifiedProvenance` and
 * the candidate directly from the pinned verifier and safe extraction adapters.
 */
export async function installStagedLinuxRelease(
  options: LinuxStagedInstallOptions,
): Promise<LinuxStagedInstallResult> {
  const installRoot = assertAbsoluteRoot(options.installRoot, "install");
  const stateRoot = assertAbsoluteRoot(options.stateRoot, "state");
  if (pathsOverlap(installRoot, stateRoot)) {
    throw new Error("Linux install and transaction-state roots must be separate.");
  }
  if (options.architecture !== "x64" && options.architecture !== "arm64") {
    throw new Error("Linux install architecture must be x64 or arm64.");
  }
  const transactionId = assertTransactionId(options.transactionId ?? randomUUID());
  const now = options.now ?? (() => new Date());
  const serviceDeadlineMs = assertServiceDeadline(options.serviceDeadlineMs ?? 15_000);
  const service = validateServiceAdapter(options.service);

  await ensureDirectory(installRoot, 0o755);
  const stagingRoot = path.join(installRoot, "staging");
  const versionsRoot = path.join(installRoot, "versions");
  await ensureDirectory(stagingRoot, 0o700);
  await ensureDirectory(versionsRoot, 0o755);
  await ensureDirectory(stateRoot, 0o700);

  const candidate = path.resolve(options.candidate);
  if (path.dirname(candidate) !== stagingRoot) {
    throw new Error("Linux release candidate must be an immediate child of the staging root.");
  }
  const leaveInstallLease = await enterLinuxInstallLease(stateRoot, options.installLease);
  const journalPath = path.join(stateRoot, "transaction.json");
  const receiptPath = path.join(stateRoot, "last-success.json");
  let journal: LinuxInstallJournal | undefined;
  let switched = false;

  try {
    if (await pathExists(journalPath)) {
      throw new Error("Linux install recovery is required before another transaction.");
    }
    const manifest = await verifyCandidateDirectory(candidate);
    if (manifest.architecture !== options.architecture) {
      throw new Error("Linux release candidate architecture does not match the install host.");
    }
    const provenance = validateLinuxInstallProvenance(options.verifiedProvenance, manifest);
    const releaseName = linuxInstalledReleaseName(manifest);
    const destination = path.join(versionsRoot, releaseName);
    const previousTarget = await readCurrentTarget(installRoot);
    const target = `versions/${releaseName}`;
    const serviceWasActive = await serviceIsActive(service, serviceDeadlineMs);
    if (serviceWasActive && previousTarget === null) {
      throw new Error("An active Linux Worker Host must have a valid current release.");
    }

    let alreadyInstalled = false;
    if (await pathExists(destination)) {
      const installedManifest = await verifyInstalledLinuxReleaseDirectory(destination);
      if (!(await releasesMatch(candidate, destination, manifest, installedManifest))) {
        throw new Error("Installed Linux release identity collides with different bytes.");
      }
      await rm(candidate, { recursive: true });
      alreadyInstalled = true;
    } else {
      const [candidateDevice, versionsDevice] = await Promise.all([
        stat(candidate).then((entry) => entry.dev),
        stat(versionsRoot).then((entry) => entry.dev),
      ]);
      if (candidateDevice !== versionsDevice) {
        throw new Error("Linux release staging and versions must share one filesystem.");
      }
      await rename(candidate, destination);
      await verifyInstalledLinuxReleaseDirectory(destination);
    }

    journal = {
      schemaVersion: 1,
      transactionId,
      phase: "staged",
      releaseName,
      target,
      previousTarget,
      serviceWasActive,
      archiveSha256: provenance.archiveSha256,
      sourceCommit: manifest.sourceCommit,
      sourceRef: provenance.sourceRef,
      createdAt: canonicalNow(now),
    };
    await writeState(journalPath, journal);

    if (previousTarget === target) {
      const receipt = completionReceipt(journal, "unchanged", canonicalNow(now));
      await writeState(receiptPath, receipt);
      await unlink(journalPath);
      return { alreadyInstalled: true, releaseName, restarted: false, rolledBack: false };
    }

    await selectCurrentTarget(installRoot, target, transactionId);
    switched = true;
    journal = { ...journal, phase: "switched" };
    await writeState(journalPath, journal);

    if (serviceWasActive) {
      await serviceRestart(service, serviceDeadlineMs);
      if (!(await serviceIsActive(service, serviceDeadlineMs))) {
        throw new Error("Selected Linux Worker Host service is not active.");
      }
    }

    const receipt = completionReceipt(
      journal,
      alreadyInstalled ? "reactivated" : "activated",
      canonicalNow(now),
    );
    await writeState(receiptPath, receipt);
    await unlink(journalPath);
    return {
      alreadyInstalled,
      releaseName,
      restarted: serviceWasActive,
      rolledBack: false,
    };
  } catch (error) {
    if (!switched || journal === undefined) throw error;
    try {
      journal = { ...journal, phase: "restoring-selection" };
      await writeState(journalPath, journal);
      await selectCurrentTarget(installRoot, journal.previousTarget, transactionId);
      if (journal.serviceWasActive && journal.previousTarget !== null) {
        journal = { ...journal, phase: "restarting-previous" };
        await writeState(journalPath, journal);
        await serviceRestart(service, serviceDeadlineMs);
        if (!(await serviceIsActive(service, serviceDeadlineMs))) {
          throw new Error("Previous Linux Worker Host service is not active.");
        }
      }
      const receipt = completionReceipt(journal, "rolled-back", canonicalNow(now));
      await writeState(receiptPath, receipt);
      await unlink(journalPath);
    } catch {
      await writeState(journalPath, { ...journal, phase: "recovery-failed" });
      throw new Error("Linux Worker Host activation failed and manual recovery is required.");
    }
    throw new Error("Linux Worker Host activation failed; the previous release was restored.");
  } finally {
    await leaveInstallLease();
  }
}

/**
 * Resume only the rollback described by a previously validated transaction journal. Recovery never
 * chooses a release by recency and never deletes either side of the interrupted upgrade.
 */
export async function recoverLinuxInstallTransaction(
  options: LinuxInstallRecoveryOptions,
): Promise<LinuxInstallRecoveryResult> {
  const installRoot = assertAbsoluteRoot(options.installRoot, "install");
  const stateRoot = assertAbsoluteRoot(options.stateRoot, "state");
  if (pathsOverlap(installRoot, stateRoot)) {
    throw new Error("Linux install and transaction-state roots must be separate.");
  }
  const recoveryId = assertTransactionId(options.recoveryId ?? randomUUID());
  const now = options.now ?? (() => new Date());
  const serviceDeadlineMs = assertServiceDeadline(options.serviceDeadlineMs ?? 15_000);
  const service = validateServiceAdapter(options.service);
  const versionsRoot = path.join(installRoot, "versions");

  await assertExistingDirectory(installRoot, false);
  await assertExistingDirectory(versionsRoot, false);
  await assertExistingDirectory(stateRoot, true);

  const leaveInstallLease = await enterLinuxInstallLease(stateRoot, options.installLease);
  const journalPath = path.join(stateRoot, "transaction.json");
  const receiptPath = path.join(stateRoot, "last-success.json");
  let journal: LinuxInstallJournal | undefined;
  let recoveryStarted = false;

  try {
    if (!(await pathExists(journalPath))) {
      throw new Error("No Linux install recovery journal exists.");
    }
    journal = await readRecoveryJournal(journalPath);
    await validateRecoveryReleaseSet(installRoot, journal);

    const currentTarget = await readCurrentTarget(installRoot);
    const active = await serviceIsActive(service, serviceDeadlineMs);
    if (journal.phase === "staged") {
      if (currentTarget !== journal.previousTarget || active !== journal.serviceWasActive) {
        throw new Error("Linux install state changed after the recovery journal was written.");
      }
      const outcome = "recovered-before-switch";
      await writeState(receiptPath, completionReceipt(journal, outcome, canonicalNow(now)));
      await unlink(journalPath);
      return {
        outcome,
        releaseName: journal.releaseName,
        restarted: false,
        restoredTarget: journal.previousTarget,
      };
    }

    if (currentTarget !== journal.target && currentTarget !== journal.previousTarget) {
      throw new Error("Linux current release does not match either recovery journal target.");
    }
    if (!journal.serviceWasActive && active) {
      throw new Error("Linux Worker Host became active outside the recorded transaction.");
    }

    journal = { ...journal, phase: "restoring-selection" };
    await writeState(journalPath, journal);
    recoveryStarted = true;
    if (currentTarget !== journal.previousTarget) {
      await selectCurrentTarget(installRoot, journal.previousTarget, recoveryId);
    }

    let restarted = false;
    if (journal.serviceWasActive) {
      journal = { ...journal, phase: "restarting-previous" };
      await writeState(journalPath, journal);
      await serviceRestart(service, serviceDeadlineMs);
      if (!(await serviceIsActive(service, serviceDeadlineMs))) {
        throw new Error("Previous Linux Worker Host service is not active.");
      }
      restarted = true;
    }

    const outcome = "recovered-previous";
    await writeState(receiptPath, completionReceipt(journal, outcome, canonicalNow(now)));
    await unlink(journalPath);
    return {
      outcome,
      releaseName: journal.releaseName,
      restarted,
      restoredTarget: journal.previousTarget,
    };
  } catch (error) {
    if (!recoveryStarted || journal === undefined) throw error;
    await writeState(journalPath, { ...journal, phase: "recovery-failed" });
    throw new Error("Linux Worker Host recovery failed; manual recovery is required.");
  } finally {
    await leaveInstallLease();
  }
}

export async function readCurrentTarget(installRoot: string): Promise<string | null> {
  const current = path.join(path.resolve(installRoot), "current");
  let metadata: Stats;
  try {
    metadata = await lstat(current);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!metadata.isSymbolicLink()) {
    throw new Error("Linux current release pointer must be a symbolic link.");
  }
  const target = await readlink(current);
  if (!isLinuxReleaseTarget(target)) {
    throw new Error("Linux current release pointer is malformed or escapes the install root.");
  }
  await verifyInstalledLinuxReleaseDirectory(path.join(path.dirname(current), target));
  return target;
}

async function selectCurrentTarget(
  installRoot: string,
  target: string | null,
  transactionId: string,
): Promise<void> {
  const current = path.join(installRoot, "current");
  if (target === null) {
    const metadata = await lstat(current);
    if (!metadata.isSymbolicLink()) {
      throw new Error("Linux current release pointer changed during recovery.");
    }
    await unlink(current);
    return;
  }
  if (!isLinuxReleaseTarget(target)) {
    throw new Error("Linux current release target is malformed.");
  }
  const temporary = path.join(installRoot, `.current-${transactionId}`);
  try {
    await symlink(target, temporary);
    await rename(temporary, current);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function releasesMatch(
  candidate: string,
  destination: string,
  candidateManifest: LinuxReleaseManifest,
  installedManifest: LinuxReleaseManifest,
): Promise<boolean> {
  if (JSON.stringify(candidateManifest) !== JSON.stringify(installedManifest)) return false;
  const [candidateChecksums, installedChecksums] = await Promise.all([
    readFile(path.join(candidate, "SHA256SUMS"), "utf8"),
    readFile(path.join(destination, "SHA256SUMS"), "utf8"),
  ]);
  return candidateChecksums === installedChecksums;
}

function completionReceipt(
  journal: LinuxInstallJournal,
  outcome: string,
  completedAt: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    transactionId: journal.transactionId,
    outcome,
    releaseName: journal.releaseName,
    target: journal.target,
    previousTarget: journal.previousTarget,
    serviceWasActive: journal.serviceWasActive,
    archiveSha256: journal.archiveSha256,
    sourceCommit: journal.sourceCommit,
    sourceRef: journal.sourceRef,
    completedAt,
  };
}

async function writeState(destination: string, value: unknown): Promise<void> {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(source) > 16 * 1024) {
    throw new Error("Linux install transaction state exceeds the 16 KiB bound.");
  }
  await writeFileAtomic(destination, source, { mode: 0o600 });
}

const recoveryJournalKeys = Object.freeze([
  "schemaVersion",
  "transactionId",
  "phase",
  "releaseName",
  "target",
  "previousTarget",
  "serviceWasActive",
  "archiveSha256",
  "sourceCommit",
  "sourceRef",
  "createdAt",
]);

const recoverablePhases: ReadonlySet<unknown> = new Set([
  "staged",
  "switched",
  "restoring-selection",
  "restarting-previous",
  "recovery-failed",
]);

async function readRecoveryJournal(journalPath: string): Promise<LinuxInstallJournal> {
  const before = await lstat(journalPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > 16 * 1024 ||
    (before.mode & 0o777) !== 0o600
  ) {
    throw new Error("Linux install recovery journal is not a private bounded regular file.");
  }

  const handle = await open(journalPath, "r");
  let source: string;
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) {
      throw new Error("Linux install recovery journal changed while it was opened.");
    }
    source = await handle.readFile("utf8");
    const afterRead = await handle.stat();
    if (!sameFile(opened, afterRead) || Buffer.byteLength(source) !== opened.size) {
      throw new Error("Linux install recovery journal changed while it was read.");
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(journalPath);
  if (!sameFile(before, after)) {
    throw new Error("Linux install recovery journal was replaced while it was read.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Linux install recovery journal is not valid JSON.");
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(recoveryJournalKeys) ||
    source !== `${JSON.stringify(value, null, 2)}\n`
  ) {
    throw new Error("Linux install recovery journal is not canonical or has unknown fields.");
  }
  validateRecoveryJournal(value);
  return value;
}

/**
 * Receipt-side trust boundary: re-validates bytes this installer wrote earlier. It is intentionally
 * separate from provenance validation even where individual checks look alike.
 */
function validateRecoveryJournal(
  journal: Record<string, unknown>,
): asserts journal is Record<string, unknown> & LinuxInstallJournal {
  if (journal.schemaVersion !== 1) {
    throw new Error("Linux install recovery journal schema is unsupported.");
  }
  assertTransactionId(journal.transactionId);
  if (!recoverablePhases.has(journal.phase)) {
    throw new Error("Linux install recovery journal phase is invalid.");
  }
  if (!isLinuxReleaseTarget(journal.target)) {
    throw new Error("Linux install recovery journal target is invalid.");
  }
  const releaseName = journal.target.slice("versions/".length);
  if (journal.releaseName !== releaseName) {
    throw new Error("Linux install recovery journal release identity is inconsistent.");
  }
  if (journal.previousTarget !== null && !isLinuxReleaseTarget(journal.previousTarget)) {
    throw new Error("Linux install recovery journal previous target is invalid.");
  }
  if (typeof journal.serviceWasActive !== "boolean") {
    throw new Error("Linux install recovery journal service state is invalid.");
  }
  if (journal.serviceWasActive && journal.previousTarget === null) {
    throw new Error("Linux install recovery journal lacks the previous active release.");
  }
  if (journal.phase !== "staged" && journal.previousTarget === journal.target) {
    throw new Error("Linux install recovery journal has no distinct rollback target.");
  }
  // Template coercion keeps the original RegExp#test string conversion exactly.
  if (!/^[0-9a-f]{64}$/.test(`${journal.archiveSha256}`)) {
    throw new Error("Linux install recovery journal archive digest is invalid.");
  }
  if (!/^[0-9a-f]{40}$/.test(`${journal.sourceCommit}`)) {
    throw new Error("Linux install recovery journal source commit is invalid.");
  }
  if (typeof journal.sourceRef !== "string" || journal.sourceRef.length > 128) {
    throw new Error("Linux install recovery journal source ref is invalid.");
  }
  assertCanonicalTimestamp(journal.createdAt, "journal creation");
}

async function validateRecoveryReleaseSet(
  installRoot: string,
  journal: LinuxInstallJournal,
): Promise<void> {
  const manifest = await verifyInstalledLinuxReleaseDirectory(
    path.join(installRoot, journal.target),
  );
  if (
    linuxInstalledReleaseName(manifest) !== journal.releaseName ||
    manifest.sourceCommit !== journal.sourceCommit ||
    journal.sourceRef !== `refs/tags/node-v${manifest.version}`
  ) {
    throw new Error("Linux install recovery journal does not match the staged release.");
  }
  if (journal.previousTarget !== null) {
    await verifyInstalledLinuxReleaseDirectory(path.join(installRoot, journal.previousTarget));
  }
}

async function ensureDirectory(directory: string, mode: number): Promise<void> {
  await mkdir(directory, { recursive: true, mode });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Linux install layout contains a non-directory or symbolic link.");
  }
  await chmod(directory, mode);
}

async function assertExistingDirectory(
  directory: string,
  privateDirectory: boolean,
): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Linux recovery layout contains a non-directory or symbolic link.");
  }
  if (privateDirectory && (metadata.mode & 0o077) !== 0) {
    throw new Error("Linux recovery state root must not grant group or other permissions.");
  }
}

async function serviceIsActive(
  service: LinuxInstallServiceAdapter,
  deadlineMs: number,
): Promise<boolean> {
  const active = await boundedServiceCall(service.isActive, deadlineMs);
  if (typeof active !== "boolean") {
    throw new Error("Linux service adapter returned an invalid active state.");
  }
  return active;
}

async function serviceRestart(
  service: LinuxInstallServiceAdapter,
  deadlineMs: number,
): Promise<void> {
  await boundedServiceCall(service.restartSelected, deadlineMs);
}

async function boundedServiceCall(
  operation: (signal: AbortSignal) => unknown,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Linux service operation exceeded its deadline."));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function validateServiceAdapter(service: unknown): LinuxInstallServiceAdapter {
  if (!isServiceAdapter(service)) {
    throw new Error("Linux install transaction requires a bounded service adapter.");
  }
  return service;
}

function isServiceAdapter(service: unknown): service is LinuxInstallServiceAdapter {
  return (
    isRecord(service) &&
    typeof service.isActive === "function" &&
    typeof service.restartSelected === "function"
  );
}

function assertAbsoluteRoot(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`Linux ${name} root must be an absolute path.`);
  }
  return path.resolve(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith(`..${path.sep}`) && leftToRight !== "..") ||
    (!rightToLeft.startsWith(`..${path.sep}`) && rightToLeft !== "..")
  );
}

function assertTransactionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error("Linux install transaction id must be a lowercase UUID.");
  }
  return value;
}

function assertServiceDeadline(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumServiceDeadlineMs
  ) {
    throw new Error("Linux service deadline must be between 1 and 60000 milliseconds.");
  }
  return value;
}

function canonicalNow(now: () => unknown): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new Error("Linux install transaction clock returned an invalid time.");
  }
  return value.toISOString();
}

function assertCanonicalTimestamp(value: unknown, name: string): asserts value is string {
  const parsed = Date.parse(`${value}`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Linux install ${name} time is not canonical.`);
  }
}

function isLinuxReleaseTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^versions\/openbot-node-[0-9A-Za-z.+-]{1,64}-linux-(?:x64|arm64)-[0-9a-f]{40}$/.test(value)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  // Same observable result as `error?.code === "ENOENT"` for any thrown value.
  return (
    (error === null || error === undefined ? undefined : Reflect.get(Object(error), "code")) ===
    "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
