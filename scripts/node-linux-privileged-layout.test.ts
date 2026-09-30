import assert from "node:assert/strict";
import test from "node:test";
import {
  LINUX_PRIVILEGED_INSTALL_LAYOUT,
  provisionLinuxPrivilegedInstallerLayout,
  validateLinuxPrivilegedLayoutSnapshot,
  validateLinuxPrivilegedRuntime,
} from "./node-linux-privileged-layout.ts";

const expectedPaths = [
  "/",
  "/opt",
  LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot,
  LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot,
  LINUX_PRIVILEGED_INSTALL_LAYOUT.versionsRoot,
  "/var",
  "/var/lib",
  LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot,
  LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot,
];

test("accepts only the fixed root Linux runtime and install layout", () => {
  assert.doesNotThrow(() =>
    validateLinuxPrivilegedRuntime({
      effectiveGroupId: 0,
      effectiveUserId: 0,
      platform: "linux",
    }),
  );
  assert.deepEqual(
    validateLinuxPrivilegedLayoutSnapshot(validSnapshot()),
    LINUX_PRIVILEGED_INSTALL_LAYOUT,
  );
});

test("rejects non-root, non-Linux, symlinked, and non-root-owned layouts", () => {
  assert.throws(
    () =>
      validateLinuxPrivilegedRuntime({
        effectiveGroupId: 20,
        effectiveUserId: 501,
        platform: "darwin",
      }),
    /run as root on Linux/,
  );

  for (const change of [
    { path: "/opt", value: metadata({ symbolicLink: true }) },
    { path: LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot, value: metadata({ uid: 1000 }) },
    { path: LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot, value: metadata({ gid: 1000 }) },
  ]) {
    const snapshot = validSnapshot();
    snapshot[change.path] = change.value;
    assert.throws(() => validateLinuxPrivilegedLayoutSnapshot(snapshot), /root-owned directory/);
  }
});

test("rejects writable ancestors and exact child-mode drift", () => {
  const writableAncestor = validSnapshot();
  writableAncestor["/var/lib"] = metadata({ mode: 0o775 });
  assert.throws(
    () => validateLinuxPrivilegedLayoutSnapshot(writableAncestor),
    /writable or inaccessible/,
  );

  const publicState = validSnapshot();
  publicState[LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot] = metadata({ mode: 0o755 });
  assert.throws(() => validateLinuxPrivilegedLayoutSnapshot(publicState), /wrong mode/);
});

test("rejects unknown paths and cross-filesystem staging or imports", () => {
  assert.throws(
    () => validateLinuxPrivilegedLayoutSnapshot({ ...validSnapshot(), "/tmp": metadata() }),
    /missing or unknown/,
  );

  const crossInstall = validSnapshot();
  crossInstall[LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot] = metadata({ dev: 2, mode: 0o700 });
  assert.throws(
    () => validateLinuxPrivilegedLayoutSnapshot(crossInstall),
    /share the install filesystem/,
  );

  const crossState = validSnapshot();
  crossState[LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot] = metadata({ dev: 3, mode: 0o700 });
  assert.throws(() => validateLinuxPrivilegedLayoutSnapshot(crossState), /share one filesystem/);
});

test("creates missing fixed children parent-first and normalizes only their opened inodes", async () => {
  const fixture = provisioningFixture();
  assert.deepEqual(
    await provisionLinuxPrivilegedInstallerLayout(rootLinuxRuntime, fixture.operations),
    LINUX_PRIVILEGED_INSTALL_LAYOUT,
  );

  const firstMutation = fixture.events.findIndex((event) => event.startsWith("mkdir:"));
  assert.ok(firstMutation > 3);
  assert.deepEqual(fixture.events.slice(0, 4), [
    "lstat:/",
    "lstat:/opt",
    "lstat:/var",
    "lstat:/var/lib",
  ]);
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith("mkdir:")),
    childPolicies.map(({ mode, path }) => `mkdir:${path}:${mode.toString(8)}:false`),
  );
  for (const { mode, path } of childPolicies) {
    assert.equal(present(fixture.entries.get(path)).mode & 0o777, mode);
    assert.ok(fixture.events.includes(`chmod:${path}:${mode.toString(8)}`));
  }
});

test("accepts an exact existing layout without changing it", async () => {
  const fixture = provisioningFixture({ includeChildren: true });
  await provisionLinuxPrivilegedInstallerLayout(rootLinuxRuntime, fixture.operations);
  assert.equal(
    fixture.events.some((event) => /^(?:mkdir|open|chmod):/u.test(event)),
    false,
  );
});

test("rejects unsafe existing children without changing them", async () => {
  for (const unsafe of [
    metadata({ mode: 0o777 }),
    metadata({ symbolicLink: true }),
    metadata({ uid: 1000 }),
  ]) {
    const fixture = provisioningFixture();
    fixture.entries.set(LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot, unsafe);
    await assert.rejects(
      provisionLinuxPrivilegedInstallerLayout(rootLinuxRuntime, fixture.operations),
      /wrong mode|root-owned directory/,
    );
    assert.equal(
      fixture.events.some((event) => /^(?:mkdir|open|chmod):/u.test(event)),
      false,
    );
  }
});

test("detects a newly created directory replacement before descending", async () => {
  const replacedPath = LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot;
  const fixture = provisioningFixture({ replaceAfterChmod: replacedPath });
  await assert.rejects(
    provisionLinuxPrivilegedInstallerLayout(rootLinuxRuntime, fixture.operations),
    /changed during creation/,
  );
  assert.equal(
    fixture.events.some((event) =>
      event.startsWith(`mkdir:${LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot}:`),
    ),
    false,
  );
});

const rootLinuxRuntime = Object.freeze({
  effectiveGroupId: 0,
  effectiveUserId: 0,
  platform: "linux",
});

const childPolicies = Object.freeze([
  Object.freeze({ mode: 0o755, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.installRoot }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot }),
  Object.freeze({ mode: 0o755, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.versionsRoot }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot }),
  Object.freeze({ mode: 0o700, path: LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot }),
]);

interface ProvisioningFixtureOptions {
  readonly includeChildren?: boolean;
  readonly replaceAfterChmod?: string;
}

interface MetadataOptions {
  readonly dev?: number;
  readonly directory?: boolean;
  readonly gid?: number;
  readonly ino?: number;
  readonly mode?: number;
  readonly symbolicLink?: boolean;
  readonly uid?: number;
}

function provisioningFixture({
  includeChildren = false,
  replaceAfterChmod,
}: ProvisioningFixtureOptions = {}) {
  const entries = new Map([
    ["/", metadata({ ino: 1 })],
    ["/opt", metadata({ ino: 2 })],
    ["/var", metadata({ ino: 3 })],
    ["/var/lib", metadata({ ino: 4 })],
  ]);
  let nextInode = 10;
  if (includeChildren) {
    for (const policy of childPolicies) {
      entries.set(policy.path, metadata({ ino: nextInode++, mode: policy.mode }));
    }
  }
  const events: string[] = [];
  const operations = {
    async lstat(entryPath: string) {
      events.push(`lstat:${entryPath}`);
      const entry = entries.get(entryPath);
      if (entry === undefined) throw fileSystemError("ENOENT");
      return entry;
    },
    async mkdir(
      entryPath: string,
      options: { readonly mode: number; readonly recursive: boolean },
    ) {
      events.push(`mkdir:${entryPath}:${options.mode.toString(8)}:${String(options.recursive)}`);
      if (entries.has(entryPath)) throw fileSystemError("EEXIST");
      const parent = entryPath.slice(0, entryPath.lastIndexOf("/")) || "/";
      if (!entries.has(parent)) throw fileSystemError("ENOENT");
      entries.set(entryPath, metadata({ ino: nextInode++, mode: options.mode & 0o700 }));
    },
    async openDirectory(entryPath: string) {
      events.push(`open:${entryPath}`);
      const opened = entries.get(entryPath);
      if (opened === undefined || opened.isSymbolicLink() || !opened.isDirectory()) {
        throw fileSystemError("ELOOP");
      }
      return {
        async chmod(mode: number) {
          events.push(`chmod:${entryPath}:${mode.toString(8)}`);
          opened.mode = mode;
          if (replaceAfterChmod === entryPath) {
            entries.set(entryPath, metadata({ ino: nextInode++, mode }));
          }
        },
        async close() {
          events.push(`close:${entryPath}`);
        },
        async stat() {
          events.push(`fstat:${entryPath}`);
          return opened;
        },
      };
    },
  };
  return { entries, events, operations };
}

function fileSystemError(code: string) {
  return Object.assign(new Error(code), { code });
}

function validSnapshot() {
  return Object.fromEntries(
    expectedPaths.map((entryPath) => [entryPath, metadata({ mode: expectedMode(entryPath) })]),
  );
}

function expectedMode(entryPath: string): number {
  if (
    entryPath === LINUX_PRIVILEGED_INSTALL_LAYOUT.stagingRoot ||
    entryPath === LINUX_PRIVILEGED_INSTALL_LAYOUT.stateRoot ||
    entryPath === LINUX_PRIVILEGED_INSTALL_LAYOUT.importsRoot
  ) {
    return 0o700;
  }
  return 0o755;
}

function metadata({
  dev = 1,
  directory = true,
  gid = 0,
  ino = 1,
  mode = 0o755,
  symbolicLink = false,
  uid = 0,
}: MetadataOptions = {}) {
  return {
    dev,
    gid,
    ino,
    isDirectory: () => directory,
    isSymbolicLink: () => symbolicLink,
    mode,
    uid,
  };
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new TypeError("Expected a recorded value.");
  return value;
}
