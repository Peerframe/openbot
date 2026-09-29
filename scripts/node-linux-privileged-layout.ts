import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";

export interface LinuxPrivilegedInstallLayout {
  readonly importsRoot: string;
  readonly installRoot: string;
  readonly stagingRoot: string;
  readonly stateRoot: string;
  readonly versionsRoot: string;
}

/** Runtime identity inputs; validated before any privileged filesystem access. */
export interface LinuxPrivilegedRuntime {
  readonly effectiveGroupId: unknown;
  readonly effectiveUserId: unknown;
  readonly platform: unknown;
}

/** Syscall seam for the deterministic core; the privileged wrapper supplies real no-follow I/O. */
export interface LinuxPrivilegedLayoutOperations {
  readonly lstat: (entryPath: string) => Promise<unknown>;
  readonly mkdir: (
    entryPath: string,
    options: { readonly mode: number; readonly recursive: false },
  ) => Promise<unknown>;
  readonly openDirectory: (entryPath: string) => Promise<unknown>;
}

interface LayoutDirectoryMetadata {
  readonly dev: number;
  readonly gid: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface LayoutDirectoryHandle {
  chmod(mode: number): Promise<unknown>;
  close(): Promise<unknown>;
  stat(): Promise<unknown>;
}

interface LayoutPolicyEntry {
  readonly mode: "ancestor" | number;
  readonly path: string;
}

interface ChildLayoutPolicyEntry extends LayoutPolicyEntry {
  readonly mode: number;
}

export const LINUX_PRIVILEGED_INSTALL_LAYOUT: LinuxPrivilegedInstallLayout = Object.freeze({
  importsRoot: "/var/lib/openbot-node-installer/imports",
  installRoot: "/opt/openbot-node",
  stagingRoot: "/opt/openbot-node/staging",
  stateRoot: "/var/lib/openbot-node-installer",
  versionsRoot: "/opt/openbot-node/versions",
});

const layoutPolicy: readonly LayoutPolicyEntry[] = Object.freeze([
  Object.freeze({ mode: "ancestor", path: "/" }),
  Object.freeze({ mode: "ancestor", path: "/opt" }),
  Object.freeze({ mode: 0o755, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot }),
  Object.freeze({ mode: 0o755, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.versionsRoot }),
  Object.freeze({ mode: "ancestor", path: "/var" }),
  Object.freeze({ mode: "ancestor", path: "/var/lib" }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot }),
]);

export async function assertLinuxPrivilegedInstallerLayout(): Promise<LinuxPrivilegedInstallLayout> {
  const runtime = currentRuntime();
  validateLinuxPrivilegedRuntime(runtime);
  const snapshot = await readLayoutSnapshot({ lstat });
  validateLinuxPrivilegedLayoutSnapshot(snapshot);
  return LINUX_PRIVILEGED_INSTALL_LAYOUT;
}

export async function prepareLinuxPrivilegedInstallerLayout(): Promise<LinuxPrivilegedInstallLayout> {
  return await provisionLinuxPrivilegedInstallerLayout(currentRuntime(), {
    lstat,
    mkdir,
    openDirectory: async (directoryPath: string) =>
      await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
  });
}

/**
 * Deterministic syscall core for policy tests. Paths, owners, and modes remain fixed; only the
 * privileged wrapper above supplies the real Linux runtime and no-follow directory handles.
 */
export async function provisionLinuxPrivilegedInstallerLayout(
  runtime: unknown,
  operations: unknown,
): Promise<LinuxPrivilegedInstallLayout> {
  validateLinuxPrivilegedRuntime(runtime);
  validateProvisionOperations(operations);

  // Validate every mutable ancestor before the first write. Children are then handled in strict
  // parent-first order, so a partial failure can leave only already-validated private directories.
  const ancestorSnapshot = Object.fromEntries(
    await Promise.all(
      layoutPolicy
        .filter((entry) => entry.mode === "ancestor")
        .map(
          async (entry): Promise<[string, unknown]> => [
            entry.path,
            await operations.lstat(entry.path),
          ],
        ),
    ),
  );
  for (const policy of layoutPolicy.filter((entry) => entry.mode === "ancestor")) {
    validateLayoutEntry(policy, ancestorSnapshot[policy.path]);
  }

  for (const policy of layoutPolicy.filter(isChildLayoutPolicy)) {
    const existing = await lstatIfPresent(operations, policy.path);
    if (existing !== undefined) {
      validateLayoutEntry(policy, existing);
      continue;
    }

    try {
      await operations.mkdir(policy.path, { mode: policy.mode, recursive: false });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      validateLayoutEntry(policy, await operations.lstat(policy.path));
      continue;
    }
    await normalizeCreatedDirectory(operations, policy);
  }

  const snapshot = await readLayoutSnapshot(operations);
  validateLinuxPrivilegedLayoutSnapshot(snapshot);
  return LINUX_PRIVILEGED_INSTALL_LAYOUT;
}

function currentRuntime(): LinuxPrivilegedRuntime {
  return {
    effectiveGroupId: typeof process.getegid === "function" ? process.getegid() : undefined,
    effectiveUserId: typeof process.geteuid === "function" ? process.geteuid() : undefined,
    platform: process.platform,
  };
}

export function validateLinuxPrivilegedRuntime(runtime: unknown): void {
  if (
    !isRecord(runtime) ||
    runtime.platform !== "linux" ||
    runtime.effectiveUserId !== 0 ||
    runtime.effectiveGroupId !== 0
  ) {
    throw new Error("Linux privileged installer must run as root on Linux.");
  }
}

export function validateLinuxPrivilegedLayoutSnapshot(
  snapshot: unknown,
): LinuxPrivilegedInstallLayout {
  if (!isRecord(snapshot)) throw new Error("Linux privileged layout snapshot is malformed.");
  const expectedPaths = layoutPolicy.map((entry) => entry.path).sort();
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error("Linux privileged layout snapshot has missing or unknown paths.");
  }

  for (const policy of layoutPolicy) {
    validateLayoutEntry(policy, snapshot[policy.path]);
  }

  const installDevice = validatedEntry(snapshot, LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot).dev;
  if (
    validatedEntry(snapshot, LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot).dev !== installDevice ||
    validatedEntry(snapshot, LINUX_PRIVILEGED_INSTALL_LAYOUT.versionsRoot).dev !== installDevice
  ) {
    throw new Error("Linux staging and versions roots must share the install filesystem.");
  }
  const stateDevice = validatedEntry(snapshot, LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot).dev;
  if (validatedEntry(snapshot, LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot).dev !== stateDevice) {
    throw new Error("Linux imports and installer state roots must share one filesystem.");
  }
  return LINUX_PRIVILEGED_INSTALL_LAYOUT;
}

async function normalizeCreatedDirectory(
  operations: LinuxPrivilegedLayoutOperations,
  policy: ChildLayoutPolicyEntry,
): Promise<void> {
  const handle = await operations.openDirectory(policy.path);
  if (!isLayoutDirectoryHandle(handle)) {
    throw new Error("Linux privileged layout directory handle is malformed.");
  }
  try {
    const created = await handle.stat();
    validateRootDirectory(policy.path, created);
    if ((created.mode & 0o777 & ~policy.mode) !== 0) {
      throw new Error(
        `Linux privileged layout created an over-permissive directory: ${policy.path}`,
      );
    }
    await handle.chmod(policy.mode);
    const normalized = await handle.stat();
    validateLayoutEntry(policy, normalized);
    assertSameDirectory(created, normalized, policy.path);
    const selected = await operations.lstat(policy.path);
    validateLayoutEntry(policy, selected);
    assertSameDirectory(normalized, selected, policy.path);
  } finally {
    await handle.close();
  }
}

async function readLayoutSnapshot(
  operations: Pick<LinuxPrivilegedLayoutOperations, "lstat">,
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      layoutPolicy.map(
        async (entry): Promise<[string, unknown]> => [
          entry.path,
          await operations.lstat(entry.path),
        ],
      ),
    ),
  );
}

async function lstatIfPresent(
  operations: LinuxPrivilegedLayoutOperations,
  entryPath: string,
): Promise<unknown> {
  try {
    return await operations.lstat(entryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function validateProvisionOperations(
  operations: unknown,
): asserts operations is LinuxPrivilegedLayoutOperations {
  if (
    !isRecord(operations) ||
    typeof operations.lstat !== "function" ||
    typeof operations.mkdir !== "function" ||
    typeof operations.openDirectory !== "function"
  ) {
    throw new Error("Linux privileged layout operations are malformed.");
  }
}

function validateLayoutEntry(
  policy: LayoutPolicyEntry,
  metadata: unknown,
): asserts metadata is LayoutDirectoryMetadata {
  validateRootDirectory(policy.path, metadata);
  const actualMode = metadata.mode & 0o777;
  if (policy.mode === "ancestor") {
    if ((actualMode & 0o700) !== 0o700 || (actualMode & 0o022) !== 0) {
      throw new Error(
        `Linux privileged layout ancestor is writable or inaccessible: ${policy.path}`,
      );
    }
  } else if (actualMode !== policy.mode) {
    throw new Error(`Linux privileged layout path has the wrong mode: ${policy.path}`);
  }
}

function validateRootDirectory(
  entryPath: string,
  metadata: unknown,
): asserts metadata is LayoutDirectoryMetadata {
  if (
    !isStatLike(metadata) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0
  ) {
    throw new Error(
      `Linux privileged layout path is not a real root-owned directory: ${entryPath}`,
    );
  }
}

function assertSameDirectory(
  before: LayoutDirectoryMetadata,
  after: LayoutDirectoryMetadata,
  entryPath: string,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error(`Linux privileged layout directory changed during creation: ${entryPath}`);
  }
}

/** Typed read of an entry that the snapshot loop above has already validated. */
function validatedEntry(
  snapshot: Record<string, unknown>,
  entryPath: string,
): LayoutDirectoryMetadata {
  const metadata = snapshot[entryPath];
  if (!isStatLike(metadata)) throw new Error("Linux privileged layout snapshot is malformed.");
  return metadata;
}

function isChildLayoutPolicy(entry: LayoutPolicyEntry): entry is ChildLayoutPolicyEntry {
  return entry.mode !== "ancestor";
}

function isLayoutDirectoryHandle(value: unknown): value is LayoutDirectoryHandle {
  return (
    isRecord(value) &&
    typeof value.chmod === "function" &&
    typeof value.close === "function" &&
    typeof value.stat === "function"
  );
}

function isStatLike(value: unknown): value is LayoutDirectoryMetadata {
  return (
    isRecord(value) &&
    typeof value.isDirectory === "function" &&
    typeof value.isSymbolicLink === "function" &&
    Number.isSafeInteger(value.uid) &&
    Number.isSafeInteger(value.gid) &&
    Number.isSafeInteger(value.mode) &&
    Number.isSafeInteger(value.dev) &&
    Number.isSafeInteger(value.ino)
  );
}

/** Same observable result as `error?.code` for any thrown value. */
function errorCode(error: unknown): unknown {
  return error === null || error === undefined ? undefined : Reflect.get(Object(error), "code");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
