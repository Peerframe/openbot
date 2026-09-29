import { constants, type Stats } from "node:fs";
import { lstat, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { assertLinuxInstallLease } from "./node-linux-install-lease.ts";
import {
  type ByteBounds,
  LINUX_RELEASE_ARCHIVE_BOUNDS,
  sha256BoundedRegularFile,
} from "./node-linux-release.ts";

/** Minimal file-handle surface the importer uses; `FileHandle` from node:fs/promises satisfies it. */
export interface LinuxArchiveImportFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesRead: number }>;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type LinuxArchiveImportFileOpener = (
  filePath: string,
  flags: string | number,
  mode?: number,
) => Promise<LinuxArchiveImportFileHandle>;

export interface LinuxArchiveImportOptions {
  readonly importId: unknown;
  readonly installLease: unknown;
  readonly openFile?: LinuxArchiveImportFileOpener | undefined;
  readonly sourcePath: unknown;
  readonly stateRoot: unknown;
}

export interface ImportedLinuxReleaseArchive {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly size: number;
}

export interface ImportedLinuxReleaseArchiveCleanup {
  readonly archivePath: unknown;
  readonly archiveSha256: unknown;
  readonly installLease: unknown;
  readonly stateRoot: unknown;
}

export const LINUX_ARCHIVE_IMPORT_BOUNDS: ByteBounds = LINUX_RELEASE_ARCHIVE_BOUNDS;

/** Same fixed flags as bounded pre-digest — used for the actual import source reopen. */
export const LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const chunkBytes = 1024 * 1024;
const importedNamePattern = /^openbot-node-import-[0-9a-f-]{36}\.tar\.xz$/u;

/**
 * Copies an untrusted archive exactly once into the private installer state root. Later privileged
 * stages must use only the returned path while the same opaque lease remains active.
 */
export async function importLinuxReleaseArchive(
  options: LinuxArchiveImportOptions,
): Promise<ImportedLinuxReleaseArchive> {
  if (!isRecord(options)) throw new Error("Linux archive import options are malformed.");
  const stateRoot = assertAbsolutePath(options.stateRoot, "state root");
  const sourcePath = assertAbsolutePath(options.sourcePath, "source");
  const importId = assertImportId(options.importId);
  const openFile: LinuxArchiveImportFileOpener = options.openFile ?? open;
  if (typeof openFile !== "function") throw new Error("Linux archive import opener is malformed.");

  await assertLinuxInstallLease(options.installLease, stateRoot);
  const importsRoot = path.join(stateRoot, "imports");
  await assertPrivateImportLayout(stateRoot, importsRoot);
  const archivePath = path.join(importsRoot, `openbot-node-import-${importId}.tar.xz`);
  const before = await lstat(sourcePath);
  if (!isReviewedSource(before)) {
    throw new Error("Linux archive import source is not a reviewed-size regular file.");
  }
  // Overlayfs (and other coarse-timestamp filesystems) may leave mtime/ctime unchanged after a
  // same-size in-place overwrite, so metadata identity is not enough. Pre-digest the reviewed
  // path with the bounded O_NOFOLLOW|O_NONBLOCK regular-file hasher (not createReadStream and
  // not the injectable openFile) before import; the import-path digest must match. Equality
  // proves only that two reads observed the same bytes — source authenticity still requires
  // later attestation. The later source reopen must use the same fixed flags so a post-digest
  // FIFO/symlink swap cannot hang the injectable (or default) openFile path.
  const sourceDigest = await sha256BoundedRegularFile(sourcePath, LINUX_ARCHIVE_IMPORT_BOUNDS);

  let sourceHandle: LinuxArchiveImportFileHandle | undefined;
  let destinationHandle: LinuxArchiveImportFileHandle | undefined;
  let destinationCreated = false;
  try {
    sourceHandle = await openFile(sourcePath, LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS);
    const openedSource = await sourceHandle.stat();
    if (!sameSource(before, openedSource)) {
      throw new Error("Linux archive import source changed while it was opened.");
    }

    destinationHandle = await openFile(archivePath, "wx", 0o600);
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > LINUX_ARCHIVE_IMPORT_BOUNDS.maximumBytes) {
        throw new Error("Linux archive import exceeded its size bound.");
      }
      await writeAll(destinationHandle, buffer, bytesRead);
    }
    await destinationHandle.sync();

    const [sourceAfterRead, sourceAfterPath, importedMetadata] = await Promise.all([
      sourceHandle.stat(),
      lstat(sourcePath),
      destinationHandle.stat(),
    ]);
    if (
      copiedBytes !== before.size ||
      !sameSource(before, sourceAfterRead) ||
      !sameSource(before, sourceAfterPath)
    ) {
      throw new Error("Linux archive import source changed while it was copied.");
    }
    if (!isPrivateImportedFile(importedMetadata) || importedMetadata.size !== copiedBytes) {
      throw new Error("Linux imported archive is not a private single-link regular file.");
    }

    await destinationHandle.close();
    destinationHandle = undefined;
    const archiveSha256 = await sha256BoundedRegularFile(archivePath, LINUX_ARCHIVE_IMPORT_BOUNDS);
    if (archiveSha256 !== sourceDigest) {
      throw new Error("Linux archive import source changed while it was opened.");
    }
    const finalMetadata = await lstat(archivePath);
    if (!sameImportedFile(importedMetadata, finalMetadata)) {
      throw new Error("Linux imported archive changed during final verification.");
    }
    await assertLinuxInstallLease(options.installLease, stateRoot);
    return { archivePath, archiveSha256, size: copiedBytes };
  } catch (error) {
    await closeQuietly(destinationHandle);
    destinationHandle = undefined;
    if (destinationCreated) {
      try {
        await rm(archivePath, { force: true });
      } catch {
        throw new Error("Linux archive import failed and private cleanup is required.");
      }
    }
    throw error;
  } finally {
    await closeQuietly(destinationHandle);
    await closeQuietly(sourceHandle);
  }
}

export async function removeImportedLinuxReleaseArchive(
  options: ImportedLinuxReleaseArchiveCleanup,
): Promise<void> {
  if (!isRecord(options)) throw new Error("Linux archive cleanup options are malformed.");
  const stateRoot = assertAbsolutePath(options.stateRoot, "state root");
  const archivePath = assertAbsolutePath(options.archivePath, "imported archive");
  const importsRoot = path.join(stateRoot, "imports");
  if (
    path.dirname(archivePath) !== importsRoot ||
    !importedNamePattern.test(path.basename(archivePath))
  ) {
    throw new Error("Linux archive cleanup path is outside the private import root.");
  }
  // Template coercion keeps the original RegExp#test string conversion exactly.
  if (!/^[0-9a-f]{64}$/u.test(`${options.archiveSha256 ?? ""}`)) {
    throw new Error("Linux archive cleanup digest is malformed.");
  }

  await assertLinuxInstallLease(options.installLease, stateRoot);
  await assertPrivateImportLayout(stateRoot, importsRoot);
  const metadata = await lstat(archivePath);
  if (!isPrivateImportedFile(metadata)) {
    throw new Error("Linux archive cleanup target is not a private single-link regular file.");
  }
  if (
    (await sha256BoundedRegularFile(archivePath, LINUX_ARCHIVE_IMPORT_BOUNDS)) !==
    options.archiveSha256
  ) {
    throw new Error("Linux archive cleanup digest does not match the imported bytes.");
  }
  const afterDigest = await lstat(archivePath);
  if (!sameImportedFile(metadata, afterDigest)) {
    throw new Error("Linux imported archive changed before cleanup.");
  }
  await unlink(archivePath);
  await assertLinuxInstallLease(options.installLease, stateRoot);
}

async function assertPrivateImportLayout(stateRoot: string, importsRoot: string): Promise<void> {
  const [stateMetadata, importsMetadata] = await Promise.all([
    lstat(stateRoot),
    lstat(importsRoot),
  ]);
  if (
    !isPrivateDirectory(stateMetadata) ||
    !isPrivateDirectory(importsMetadata) ||
    stateMetadata.uid !== importsMetadata.uid ||
    stateMetadata.gid !== importsMetadata.gid
  ) {
    throw new Error("Linux archive import roots must be private real directories with one owner.");
  }
}

async function writeAll(
  handle: LinuxArchiveImportFileHandle,
  buffer: Buffer,
  length: number,
): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesWritten } = await handle.write(buffer, offset, length - offset, null);
    if (bytesWritten < 1) throw new Error("Linux archive import made no write progress.");
    offset += bytesWritten;
  }
}

async function closeQuietly(handle: LinuxArchiveImportFileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // The primary operation owns the actionable failure; a later lease check still fails closed.
  }
}

function isReviewedSource(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size >= LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes &&
    metadata.size <= LINUX_ARCHIVE_IMPORT_BOUNDS.maximumBytes
  );
}

function isPrivateDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700;
}

function isPrivateImportedFile(metadata: Stats): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o777) === 0o600 &&
    metadata.size >= LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes &&
    metadata.size <= LINUX_ARCHIVE_IMPORT_BOUNDS.maximumBytes
  );
}

function sameSource(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameImportedFile(left: Stats, right: Stats): boolean {
  return (
    isPrivateImportedFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Linux archive import ${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function assertImportId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new Error("Linux archive import id must be a lowercase UUID.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
