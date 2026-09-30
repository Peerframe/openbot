import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

declare const linuxInstallLeaseBrand: unique symbol;

/**
 * Opaque installer lease. At runtime it is a frozen prototype-less object whose only meaning is
 * its private WeakMap record below; the brand exists for the type checker alone.
 */
export interface LinuxInstallLease {
  readonly [linuxInstallLeaseBrand]: true;
}

export interface LinuxInstallLeaseOptions {
  readonly stateRoot: unknown;
}

interface LeaseEntryIdentity {
  readonly ctimeMs: number | undefined;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface LeaseRecord {
  active: boolean;
  readonly lockIdentity: LeaseEntryIdentity;
  readonly lockPath: string;
  readonly stateIdentity: LeaseEntryIdentity;
  readonly stateRoot: string;
  readonly token: Buffer;
  readonly tokenPath: string;
}

const leaseRecords = new WeakMap<object, LeaseRecord>();
const TOKEN_BYTES = 32;
const TOKEN_NAME = "lease.token";

/**
 * Holds the installer lock across archive import, verification, extraction, and activation. The
 * opaque lease proves only local serialization; it never grants Server or Node authority.
 */
export async function withLinuxInstallLease<T>(
  options: LinuxInstallLeaseOptions,
  operation: (lease: LinuxInstallLease) => Promise<T> | T,
): Promise<T> {
  if (!isRecord(options) || typeof operation !== "function") {
    throw new Error("Linux install lease request is malformed.");
  }
  const stateRoot = assertAbsoluteStateRoot(options.stateRoot);
  const lease = await acquireLinuxInstallLease(stateRoot);
  try {
    return await operation(lease);
  } finally {
    await releaseLinuxInstallLease(lease);
  }
}

/**
 * Lets a transaction either acquire its own lease or join an already-held outer bootstrap lease.
 * The returned release function never releases a caller-owned outer lease.
 */
export async function enterLinuxInstallLease(
  stateRootInput: unknown,
  lease?: unknown,
): Promise<() => Promise<void>> {
  const stateRoot = assertAbsoluteStateRoot(stateRootInput);
  if (lease === undefined) {
    const ownedLease = await acquireLinuxInstallLease(stateRoot);
    return async () => await releaseLinuxInstallLease(ownedLease);
  }
  await assertLinuxInstallLease(lease, stateRoot);
  return async () => await assertLinuxInstallLease(lease, stateRoot);
}

export async function assertLinuxInstallLease(
  lease: unknown,
  stateRootInput: unknown,
): Promise<void> {
  const stateRoot = assertAbsoluteStateRoot(stateRootInput);
  const record = isRecord(lease) ? leaseRecords.get(lease) : undefined;
  if (record === undefined || !record.active || record.stateRoot !== stateRoot) {
    throw new Error(
      "Linux install lease is missing, released, forged, or belongs to another root.",
    );
  }
  let rootMetadata: Stats;
  let lockMetadata: Stats;
  try {
    [rootMetadata, lockMetadata] = await Promise.all([
      lstat(record.stateRoot),
      lstat(record.lockPath),
    ]);
  } catch {
    throw new Error("Linux install lease was removed or replaced.");
  }
  if (
    !isPrivateDirectory(rootMetadata) ||
    !isPrivateDirectory(lockMetadata) ||
    !sameEntry(rootMetadata, record.stateIdentity) ||
    !sameEntry(lockMetadata, record.lockIdentity)
  ) {
    throw new Error("Linux install lease was removed or replaced.");
  }
  // Overlayfs and other filesystems may reuse st_ino after rmdir+mkdir and report the same
  // ctimeMs; a process-private token is the replacement detector that those fields cannot be.
  await assertLeaseToken(record);
}

async function acquireLinuxInstallLease(stateRoot: string): Promise<LinuxInstallLease> {
  const stateMetadata = await lstat(stateRoot);
  if (!isPrivateDirectory(stateMetadata)) {
    throw new Error("Linux install lease state root must be a private real directory.");
  }
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error("Another Linux install transaction or stale lock exists.");
    }
    throw error;
  }
  let ownedToken: Buffer | undefined;
  try {
    const token = randomBytes(TOKEN_BYTES);
    await writeExclusiveToken(tokenPath, token);
    ownedToken = token;
    const [stateAfterLock, lockMetadata] = await Promise.all([lstat(stateRoot), lstat(lockPath)]);
    if (!isPrivateDirectory(stateAfterLock) || !isPrivateDirectory(lockMetadata)) {
      throw new Error("Linux install lease lock is not a private real directory.");
    }
    const lease: LinuxInstallLease = Object.freeze(Object.create(null));
    leaseRecords.set(lease, {
      active: true,
      lockIdentity: identityOf(lockMetadata, true),
      lockPath,
      stateIdentity: identityOf(stateAfterLock, false),
      stateRoot,
      token,
      tokenPath,
    });
    return lease;
  } catch (error) {
    // Ownership-unproven cleanup must surface before the original error; never blind-unlink.
    await discardIncompleteLock(lockPath, tokenPath, ownedToken);
    throw error;
  }
}

async function releaseLinuxInstallLease(lease: LinuxInstallLease): Promise<void> {
  const record = leaseRecords.get(lease);
  if (record === undefined || !record.active) {
    throw new Error("Linux install lease cannot be released twice.");
  }
  await assertLinuxInstallLease(lease, record.stateRoot);
  try {
    await unlinkProvenToken(record.tokenPath, record.token);
  } catch {
    throw new Error("Linux install lease was removed or replaced.");
  }
  await rmdir(record.lockPath);
  record.active = false;
}

async function assertLeaseToken(record: LeaseRecord): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      record.tokenPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!isPrivateTokenFile(metadata)) {
      throw new Error("Linux install lease was removed or replaced.");
    }
    const actual = Buffer.alloc(TOKEN_BYTES);
    const { bytesRead } = await handle.read(actual, 0, TOKEN_BYTES, 0);
    if (bytesRead !== TOKEN_BYTES || !timingSafeEqual(actual, record.token)) {
      throw new Error("Linux install lease was removed or replaced.");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Linux install lease was removed or replaced."
    ) {
      throw error;
    }
    throw new Error("Linux install lease was removed or replaced.");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The lease assertion owns the failure; a later release still fails closed.
      }
    }
  }
}

async function writeExclusiveToken(tokenPath: string, token: Buffer): Promise<void> {
  const handle = await open(
    tokenPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.write(token, 0, TOKEN_BYTES, 0);
    await handle.sync();
    const metadata = await handle.stat();
    if (!isPrivateTokenFile(metadata)) {
      throw new Error("Linux install lease token is not a private regular file.");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Failure cleanup may only remove artifacts proven to belong to this acquire attempt.
 * When `ownedToken` is missing (create never succeeded), ownership cannot be proven — refuse
 * cleanup and retain the lock directory (including an empty replacement). When a token exists
 * but the path no longer matches under O_NOFOLLOW|O_NONBLOCK, leave artifacts in place and
 * report — never blind-unlink. A same-UID/privileged adversary TOCTOU between the last proven
 * check and unlink/rmdir is not fully eliminated; the install state root's parent is assumed
 * root-owned and non-writable by group/other so unprivileged rename/replace of the root is out
 * of scope.
 */
export async function discardIncompleteLock(
  lockPath: string,
  tokenPath: string,
  ownedToken: unknown,
): Promise<void> {
  if (ownedToken === undefined) {
    throw new Error(
      "Linux install lease acquire failed; lock cleanup is unproven and was refused.",
    );
  }
  if (!Buffer.isBuffer(ownedToken) || ownedToken.length !== TOKEN_BYTES) {
    throw new Error("Linux install lease cleanup token is malformed.");
  }
  try {
    await unlinkProvenToken(tokenPath, ownedToken);
  } catch {
    throw new Error(
      "Linux install lease acquire failed; owned token cleanup is unsafe and was refused.",
    );
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new Error(
      "Linux install lease acquire failed; lock directory could not be removed safely.",
    );
  }
}

async function unlinkProvenToken(tokenPath: string, ownedToken: Buffer): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      tokenPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!isPrivateTokenFile(metadata)) {
      throw new Error("Linux install lease token is not a private regular file.");
    }
    const actual = Buffer.alloc(TOKEN_BYTES);
    const { bytesRead } = await handle.read(actual, 0, TOKEN_BYTES, 0);
    if (bytesRead !== TOKEN_BYTES || !timingSafeEqual(actual, ownedToken)) {
      throw new Error("Linux install lease token does not match this attempt.");
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Provenance check owns the failure path.
      }
    }
  }
  await unlink(tokenPath);
}

function assertAbsoluteStateRoot(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("Linux install lease state root must be an absolute path.");
  }
  return path.resolve(value);
}

function isPrivateDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700;
}

function isPrivateTokenFile(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o777) === 0o600 &&
    metadata.size === TOKEN_BYTES
  );
}

function identityOf(metadata: Stats, trackContentChanges: boolean): LeaseEntryIdentity {
  return Object.freeze({
    ctimeMs: trackContentChanges ? metadata.ctimeMs : undefined,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
  });
}

function sameEntry(metadata: Stats, identity: LeaseEntryIdentity): boolean {
  return (
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino &&
    metadata.mode === identity.mode &&
    (identity.ctimeMs === undefined || metadata.ctimeMs === identity.ctimeMs)
  );
}

/** Same observable result as `error?.code` for any thrown value. */
function errorCode(error: unknown): unknown {
  return error === null || error === undefined ? undefined : Reflect.get(Object(error), "code");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
