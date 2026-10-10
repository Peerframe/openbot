/** Actual Linux syscalls, including a distinct low-UID child; other hosts cannot claim success. */
import assert from "node:assert/strict";
import { openSync, closeSync, statfsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeClock, peerUid, filesystemFacts } from "./kernel-facts.ts";
const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
test("unsupported platforms and absent accepted handles fail closed", () => {
  if (!supported) assert.throws(nativeClock, /unsupported_kernel_abi/);
  const socket = new Socket();
  try {
    assert.throws(() => peerUid(socket), /unsupported_peer_credentials/);
  } finally {
    socket.destroy();
  }
});
test("actual Linux clocks have the same boot, nondecreasing monotonic and suspend-aware time", {
  skip: !supported,
}, () => {
  const before = nativeClock(),
    after = nativeClock();
  assert.equal(after[2], before[2]);
  assert(before[0] > 0 && before[1] >= before[0] && after[0] >= before[0] && after[1] >= before[1]);
});
test("actual accepted Unix socket reports low UID instead of any message claim", {
  skip: !supported || process.getuid?.() !== 0,
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openbot-peer-test-"));
  await chmod(directory, 0o755);
  const path = join(directory, "peer.sock");
  let child: ReturnType<typeof spawn> | undefined;
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o666);
    const observed = new Promise<number>((resolve, reject) =>
      server.once("connection", (socket) => {
        try {
          const uid = peerUid(socket);
          socket.resume();
          socket.end();
          resolve(uid);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      }),
    );
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {connect} from 'node:net';const socket=connect(${JSON.stringify(path)});socket.on('error',()=>process.exitCode=1);socket.on('connect',()=>socket.end('I claim UID 0'));`,
      ],
      { uid: 62425, gid: 62425, env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", resolve);
    });
    const [uid, status] = await Promise.all([observed, exited]);
    assert.equal(uid, 62425);
    assert.equal(status, 0);
  } finally {
    child?.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual filesystem descriptor capacity matches Node statfs and readonly mount flags", {
  skip: !supported,
}, () => {
  for (const path of ["/", "/tmp"]) {
    const fd = openSync(path, "r");
    try {
      const found = filesystemFacts(fd),
        node = statfsSync(path, { bigint: true });
      assert.equal(found.blocks, node.blocks);
      assert.equal(found.fragmentSize, node.bsize);
      if (process.env.OPENBOT_READONLY_KERNEL_TEST === "1")
        assert.equal(found.flags & 1n, path === "/" ? 1n : 0n);
    } finally {
      closeSync(fd);
    }
  }
});
