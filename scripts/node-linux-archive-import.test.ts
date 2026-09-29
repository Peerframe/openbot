import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  importLinuxReleaseArchive,
  LINUX_ARCHIVE_IMPORT_BOUNDS,
  LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS,
  removeImportedLinuxReleaseArchive,
} from "./node-linux-archive-import.ts";
import { withLinuxInstallLease } from "./node-linux-install-lease.ts";
import { sha256BoundedRegularFile } from "./node-linux-release.ts";

const execFileAsync = promisify(execFile);
const importModulePath = fileURLToPath(new URL("./node-linux-archive-import.ts", import.meta.url));
const leaseModulePath = fileURLToPath(new URL("./node-linux-install-lease.ts", import.meta.url));

const importIds = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];

test("imports and removes exact bytes only while the private lease is held", async () => {
  const fixture = await createFixture();
  const sourcePath = await createSparseArchive(fixture.root, "source.tar.xz");

  await withLinuxInstallLease({ stateRoot: fixture.stateRoot }, async (installLease) => {
    const imported = await importLinuxReleaseArchive({
      importId: importIds[0],
      installLease,
      sourcePath,
      stateRoot: fixture.stateRoot,
    });
    const metadata = await lstat(imported.archivePath);
    assert.equal(imported.size, LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes);
    assert.match(imported.archiveSha256, /^[0-9a-f]{64}$/u);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
    assert.deepEqual(await readFile(imported.archivePath), await readFile(sourcePath));

    await removeImportedLinuxReleaseArchive({
      archivePath: imported.archivePath,
      archiveSha256: imported.archiveSha256,
      installLease,
      stateRoot: fixture.stateRoot,
    });
  });

  assert.deepEqual(await readdir(fixture.importsRoot), []);
});

test("rejects symlink, undersized, and changed sources before retaining an import", async () => {
  const fixture = await createFixture();
  const sourcePath = await createSparseArchive(fixture.root, "source.tar.xz");
  const sourceLink = path.join(fixture.root, "source-link.tar.xz");
  await symlink(sourcePath, sourceLink);

  await withLinuxInstallLease({ stateRoot: fixture.stateRoot }, async (installLease) => {
    await assert.rejects(
      importLinuxReleaseArchive({
        importId: importIds[0],
        installLease,
        sourcePath: sourceLink,
        stateRoot: fixture.stateRoot,
      }),
      /reviewed-size regular file/,
    );

    const undersized = path.join(fixture.root, "small.tar.xz");
    await writeFile(undersized, "small");
    await assert.rejects(
      importLinuxReleaseArchive({
        importId: importIds[0],
        installLease,
        sourcePath: undersized,
        stateRoot: fixture.stateRoot,
      }),
      /reviewed-size regular file/,
    );

    const hostileOpen = async (filePath: string, flags: string | number, mode?: number) => {
      const handle = await open(filePath, flags, mode);
      if (filePath === sourcePath && flags === LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS) {
        const writer = await open(sourcePath, "r+");
        await writer.write(Buffer.from([1]), 0, 1, 0);
        await writer.close();
      }
      return handle;
    };
    await assert.rejects(
      importLinuxReleaseArchive({
        importId: importIds[1],
        installLease,
        openFile: hostileOpen,
        sourcePath,
        stateRoot: fixture.stateRoot,
      }),
      /changed while it was opened/,
    );
  });

  assert.deepEqual(await readdir(fixture.importsRoot), []);
});

test("exclusive import never overwrites an existing private path", async () => {
  const fixture = await createFixture();
  const sourcePath = await createSparseArchive(fixture.root, "source.tar.xz");
  const destination = path.join(fixture.importsRoot, `openbot-node-import-${importIds[0]}.tar.xz`);
  await writeFile(destination, "keep", { mode: 0o600 });

  await withLinuxInstallLease({ stateRoot: fixture.stateRoot }, async (installLease) => {
    await assert.rejects(
      importLinuxReleaseArchive({
        importId: importIds[0],
        installLease,
        sourcePath,
        stateRoot: fixture.stateRoot,
      }),
      { code: "EEXIST" },
    );
  });

  assert.equal(await readFile(destination, "utf8"), "keep");
});

test("cleanup preserves imported bytes when the expected digest is wrong", async () => {
  const fixture = await createFixture();
  const sourcePath = await createSparseArchive(fixture.root, "source.tar.xz");

  await withLinuxInstallLease({ stateRoot: fixture.stateRoot }, async (installLease) => {
    const imported = await importLinuxReleaseArchive({
      importId: importIds[0],
      installLease,
      sourcePath,
      stateRoot: fixture.stateRoot,
    });
    await assert.rejects(
      removeImportedLinuxReleaseArchive({
        archivePath: imported.archivePath,
        archiveSha256: "0".repeat(64),
        installLease,
        stateRoot: fixture.stateRoot,
      }),
      /does not match/,
    );
    assert.equal((await lstat(imported.archivePath)).isFile(), true);
  });
});

test("pre-digest rejects symlink, FIFO, and oversize or growing sources", async () => {
  const fixture = await createFixture();
  const tinyBounds = Object.freeze({ maximumBytes: 64, minimumBytes: 8 });

  const regular = path.join(fixture.root, "regular.bin");
  await writeFile(regular, Buffer.alloc(16, 5), { mode: 0o600 });
  assert.match(await sha256BoundedRegularFile(regular, tinyBounds), /^[0-9a-f]{64}$/u);

  const linkPath = path.join(fixture.root, "link.bin");
  await symlink(regular, linkPath);
  await assert.rejects(
    sha256BoundedRegularFile(linkPath, tinyBounds),
    /ELOOP|regular file|not a regular file/i,
  );

  const fifoPath = path.join(fixture.root, "fifo.bin");
  await execFileAsync("mkfifo", ["-m", "0600", fifoPath]);
  await assert.rejects(
    sha256BoundedRegularFile(fifoPath, tinyBounds),
    /regular file|not a regular file/i,
  );

  const oversize = path.join(fixture.root, "oversize.bin");
  await writeFile(oversize, Buffer.alloc(tinyBounds.maximumBytes + 1, 9), { mode: 0o600 });
  await assert.rejects(
    sha256BoundedRegularFile(oversize, tinyBounds),
    /outside the reviewed bound/,
  );

  // File grows past the configured maximum before digest — rejected by size bounds.
  const grownPastMax = path.join(fixture.root, "grown-past-max.bin");
  await writeFile(grownPastMax, Buffer.alloc(tinyBounds.maximumBytes, 3), { mode: 0o600 });
  const pastMaxWriter = await open(grownPastMax, "a");
  await pastMaxWriter.write(Buffer.alloc(1, 4));
  await pastMaxWriter.close();
  await assert.rejects(
    sha256BoundedRegularFile(grownPastMax, tinyBounds),
    /outside the reviewed bound/,
  );

  // Same-size declared file that gains bytes while the bounded reader is active.
  const growBounds = Object.freeze({
    maximumBytes: 2 * 1024 * 1024,
    minimumBytes: 1,
  });
  const growing = path.join(fixture.root, "growing.bin");
  const growHandle = await open(growing, "wx", 0o600);
  await growHandle.truncate(growBounds.maximumBytes);
  await growHandle.write(Buffer.alloc(4096, 3), 0, 4096, 0);
  await growHandle.close();
  let stopGrowing = false;
  const grower = (async () => {
    const writer = await open(growing, "a");
    try {
      while (!stopGrowing) {
        await writer.write(Buffer.alloc(256 * 1024, 4));
      }
    } finally {
      await writer.close();
    }
  })();
  try {
    await assert.rejects(
      (async () => {
        await Promise.resolve();
        return sha256BoundedRegularFile(growing, growBounds);
      })(),
      /grew beyond|exceeded its declared size|outside the reviewed bound/,
    );
  } finally {
    stopGrowing = true;
    await grower;
  }
});

test("post-pre-digest FIFO/symlink source reopen bounded-exits in a child subprocess", async () => {
  const fixture = await createFixture();
  const fifoSourcePath = await createSparseArchive(fixture.root, "fifo-source.tar.xz");
  const symlinkSourcePath = await createSparseArchive(fixture.root, "symlink-source.tar.xz");
  const minBytes = LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes;

  const childSource = `
import { execFileSync } from "node:child_process";
import { open, symlink, unlink } from "node:fs/promises";
import {
  importLinuxReleaseArchive,
  LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS,
} from ${JSON.stringify(importModulePath)};
import { withLinuxInstallLease } from ${JSON.stringify(leaseModulePath)};

const stateRoot = ${JSON.stringify(fixture.stateRoot)};
const fifoSourcePath = ${JSON.stringify(fifoSourcePath)};
const symlinkSourcePath = ${JSON.stringify(symlinkSourcePath)};
const minBytes = ${minBytes};

async function importWithPostDigestReplace(sourcePath, importId, replace) {
  await withLinuxInstallLease({ stateRoot }, async (installLease) => {
    await importLinuxReleaseArchive({
      importId,
      installLease,
      openFile: async (filePath, flags, mode) => {
        if (filePath === sourcePath) {
          if (flags !== LINUX_ARCHIVE_IMPORT_SOURCE_OPEN_FLAGS) {
            throw new Error(
              "production source open must pass O_RDONLY|O_NOFOLLOW|O_NONBLOCK; got " +
                String(flags),
            );
          }
          await replace(filePath);
        }
        return open(filePath, flags, mode);
      },
      sourcePath,
      stateRoot,
    });
  });
}

try {
  await importWithPostDigestReplace(
    fifoSourcePath,
    "00000000-0000-4000-8000-0000000000f1",
    async (filePath) => {
      await unlink(filePath);
      execFileSync("mkfifo", ["-m", "0600", filePath]);
    },
  );
  console.error("FIFO-replaced source open unexpectedly succeeded");
  process.exit(2);
} catch (error) {
  const text = String(error && error.code ? error.code + " " : "") + String(error);
  // Linux may nonblock-succeed O_RDONLY FIFO opens; production then fails closed on
  // identity/type checks. Either way the child must not hang.
  if (!/ENXIO|ELOOP|changed while it was opened|regular file|not a regular file|EINVAL/i.test(text)) {
    console.error("unexpected FIFO-replace error", error);
    process.exit(3);
  }
}

try {
  await importWithPostDigestReplace(
    symlinkSourcePath,
    "00000000-0000-4000-8000-0000000000f2",
    async (filePath) => {
      await unlink(filePath);
      const target = filePath + ".symlink-target";
      const handle = await open(target, "wx", 0o600);
      await handle.truncate(minBytes);
      await handle.write(Buffer.from("openbot-import-test"), 0, 19, 0);
      await handle.close();
      await symlink(target, filePath);
    },
  );
  console.error("symlink-replaced source open unexpectedly succeeded");
  process.exit(4);
} catch (error) {
  const text = String(error && error.code ? error.code + " " : "") + String(error);
  if (!/ELOOP|regular file|not a regular file/i.test(text)) {
    console.error("unexpected symlink-replace error", error);
    process.exit(5);
  }
}

process.exit(0);
`;

  const result = await spawnBounded(
    process.execPath,
    ["--input-type=module", "--eval", childSource],
    5000,
  );
  assert.equal(
    result.timedOut,
    false,
    `child hung: stdout=${result.stdout} stderr=${result.stderr}`,
  );
  assert.equal(
    result.code,
    0,
    `child exited ${result.code} signal=${result.signal} stdout=${result.stdout} stderr=${result.stderr}`,
  );
  assert.deepEqual(await readdir(fixture.importsRoot), []);
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-linux-import-test-"));
  const stateRoot = path.join(root, "state");
  const importsRoot = path.join(stateRoot, "imports");
  await mkdir(importsRoot, { recursive: true, mode: 0o700 });
  return { importsRoot, root, stateRoot };
}

async function createSparseArchive(root: string, name: string): Promise<string> {
  const sourcePath = path.join(root, name);
  const handle = await open(sourcePath, "wx", 0o600);
  await handle.truncate(LINUX_ARCHIVE_IMPORT_BOUNDS.minimumBytes);
  await handle.write(Buffer.from("openbot-import-test"), 0, 19, 0);
  await handle.close();
  return sourcePath;
}

interface BoundedSpawnResult {
  readonly timedOut: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<BoundedSpawnResult> {
  return new Promise<BoundedSpawnResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ timedOut: true, code: null, signal: "SIGKILL", stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal, stdout, stderr });
    });
  });
}
