import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertLinuxInstallLease,
  discardIncompleteLock,
  enterLinuxInstallLease,
  withLinuxInstallLease,
} from "./node-linux-install-lease.ts";

const leaseModulePath = fileURLToPath(new URL("./node-linux-install-lease.ts", import.meta.url));

const TOKEN_NAME = "lease.token";
const TOKEN_BYTES = 32;

test("holds one private directory lease across nested installer operations", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");

  await withLinuxInstallLease({ stateRoot }, async (lease) => {
    assert.equal((await lstat(lockPath)).isDirectory(), true);
    await assertLinuxInstallLease(lease, stateRoot);
    const leaveNestedOperation = await enterLinuxInstallLease(stateRoot, lease);
    await leaveNestedOperation();
    assert.equal((await lstat(lockPath)).isDirectory(), true);
  });

  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("an operation without an outer lease acquires and releases its own lock", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");

  const leave = await enterLinuxInstallLease(stateRoot);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
  await leave();

  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("rejects forged, released, cross-root, and concurrent leases", async () => {
  const stateRoot = await createStateRoot();
  const otherRoot = await createStateRoot();
  let released: unknown;

  await withLinuxInstallLease({ stateRoot }, async (lease) => {
    released = lease;
    await assert.rejects(assertLinuxInstallLease({}, stateRoot), /forged/);
    await assert.rejects(assertLinuxInstallLease(lease, otherRoot), /another root/);
    await assert.rejects(
      withLinuxInstallLease({ stateRoot }, async () => undefined),
      /stale lock exists/,
    );
  });

  await assert.rejects(assertLinuxInstallLease(released, stateRoot), /released/);
});

test("does not remove a lock directory that was replaced while held", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");

  await assert.rejects(
    withLinuxInstallLease({ stateRoot }, async () => {
      await rmdirAndReplace(lockPath);
    }),
    /removed or replaced/,
  );

  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test("release refuses a same-length nonce rewrite and retains the replacement token", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  const replacement = randomBytes(TOKEN_BYTES);

  await assert.rejects(
    withLinuxInstallLease({ stateRoot }, async () => {
      const handle = await open(tokenPath, "r+");
      await handle.write(replacement, 0, TOKEN_BYTES, 0);
      await handle.sync();
      await handle.close();
    }),
    /removed or replaced/,
  );

  assert.equal((await lstat(lockPath)).isDirectory(), true);
  assert.equal((await lstat(tokenPath)).isFile(), true);
  assert.deepEqual(await readFile(tokenPath), replacement);
});

test("release refuses a token path replaced by a symlink without deleting the target", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  const targetPath = path.join(stateRoot, "foreign-token");
  const foreign = randomBytes(TOKEN_BYTES);
  await writeFile(targetPath, foreign, { mode: 0o600 });

  await assert.rejects(
    withLinuxInstallLease({ stateRoot }, async () => {
      await rm(tokenPath);
      await symlink(targetPath, tokenPath);
    }),
    /removed or replaced/,
  );

  assert.equal((await lstat(tokenPath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(targetPath), foreign);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test("discardIncompleteLock retains a foreign token and refuses unsafe cleanup", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  await mkdir(lockPath, { mode: 0o700 });
  const foreign = randomBytes(TOKEN_BYTES);
  await writeFile(tokenPath, foreign, { mode: 0o600 });

  await assert.rejects(
    discardIncompleteLock(lockPath, tokenPath, undefined),
    /lock cleanup is unproven and was refused/,
  );
  assert.deepEqual(await readFile(tokenPath), foreign);
  assert.equal((await lstat(lockPath)).isDirectory(), true);

  const claimed = randomBytes(TOKEN_BYTES);
  await assert.rejects(
    discardIncompleteLock(lockPath, tokenPath, claimed),
    /owned token cleanup is unsafe/,
  );
  assert.deepEqual(await readFile(tokenPath), foreign);

  const symlinkTarget = path.join(stateRoot, "symlink-target-token");
  await writeFile(symlinkTarget, foreign, { mode: 0o600 });
  await rm(tokenPath);
  await symlink(symlinkTarget, tokenPath);
  await assert.rejects(
    discardIncompleteLock(lockPath, tokenPath, claimed),
    /owned token cleanup is unsafe/,
  );
  assert.equal((await lstat(tokenPath)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(symlinkTarget), foreign);
});

test("discardIncompleteLock refuses unproven cleanup of an empty replacement lock directory", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  await mkdir(lockPath, { mode: 0o700 });

  await assert.rejects(
    discardIncompleteLock(lockPath, tokenPath, undefined),
    /lock cleanup is unproven and was refused/,
  );
  assert.equal((await lstat(lockPath)).isDirectory(), true);
  await assert.rejects(lstat(tokenPath), { code: "ENOENT" });
});

test("FIFO-replaced token open/check path bounded-exits in a child subprocess", async () => {
  const stateRoot = await createStateRoot();
  const lockPath = path.join(stateRoot, "transaction.lock");
  const tokenPath = path.join(lockPath, TOKEN_NAME);
  await mkdir(lockPath, { mode: 0o700 });
  await mkfifo(tokenPath, 0o600);

  const childSource = `
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertLinuxInstallLease,
  discardIncompleteLock,
  withLinuxInstallLease,
} from ${JSON.stringify(leaseModulePath)};

const lockPath = ${JSON.stringify(lockPath)};
const tokenPath = ${JSON.stringify(tokenPath)};
const stateRoot = ${JSON.stringify(stateRoot)};
const claimed = randomBytes(32);

try {
  await discardIncompleteLock(lockPath, tokenPath, claimed);
  console.error("discardIncompleteLock unexpectedly succeeded on FIFO token");
  process.exit(2);
} catch (error) {
  if (!/owned token cleanup is unsafe/.test(String(error))) {
    console.error("unexpected discard error", error);
    process.exit(3);
  }
}

const assertRoot = path.join(path.dirname(stateRoot), "state-assert");
await mkdir(assertRoot, { mode: 0o700 });
let assertRejected = false;
try {
  await withLinuxInstallLease({ stateRoot: assertRoot }, async (lease) => {
    const heldToken = path.join(assertRoot, "transaction.lock", "lease.token");
    await rm(heldToken);
    execFileSync("mkfifo", ["-m", "0600", heldToken]);
    try {
      await assertLinuxInstallLease(lease, assertRoot);
      console.error("assertLinuxInstallLease unexpectedly succeeded on FIFO token");
      process.exit(4);
    } catch (error) {
      if (!/removed or replaced/.test(String(error))) {
        console.error("unexpected assert error", error);
        process.exit(5);
      }
      assertRejected = true;
    }
  });
} catch (error) {
  // Release after FIFO replace also fails closed.
  if (!/removed or replaced/.test(String(error))) {
    console.error("unexpected lease wrapper error", error);
    process.exit(6);
  }
}
if (!assertRejected) {
  console.error("assert path did not reject");
  process.exit(7);
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
  assert.equal((await lstat(tokenPath)).isFIFO(), true);
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

async function createStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openbot-linux-lease-test-"));
  const stateRoot = path.join(root, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  return stateRoot;
}

async function rmdirAndReplace(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true });
  await mkdir(lockPath, { mode: 0o700 });
}

async function mkfifo(fifoPath: string, mode: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const modeFlag = (mode & 0o777).toString(8).padStart(3, "0");
  await new Promise<void>((resolve, reject) => {
    execFile("mkfifo", ["-m", modeFlag, fifoPath], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
