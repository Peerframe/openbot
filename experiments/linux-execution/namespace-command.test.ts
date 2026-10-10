/** Real descriptor binding tests on Linux; actual setns/runsc remains a dedicated root CI gate. */
import assert from "node:assert/strict";
import { closeSync, readlinkSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { openNamespace, namespaceCommand } from "./namespace-command.ts";
const linux = process.platform === "linux";
test("open namespace retains exact kernel inode, independent of later PID lookup", {
  skip: !linux,
}, () => {
  for (const kind of ["mnt", "net"] as const) {
    const expected = readlinkSync(`/proc/self/ns/${kind}`),
      fd = openNamespace(process.pid, kind, expected);
    try {
      assert.equal(readlinkSync(`/proc/self/fd/${fd}`), expected);
    } finally {
      closeSync(fd);
    }
  }
});
test("second namespace failure closes the first descriptor before refusing", {
  skip: !linux,
}, async () => {
  const expected = readlinkSync("/proc/self/ns/mnt"),
    before = readdirSync("/proc/self/fd").length;
  await assert.rejects(
    () =>
      namespaceCommand({
        pid: process.pid,
        namespaces: { mnt: expected, net: "net:[1]" },
        argv: [process.execPath, "-e", "process.exit(99)"],
        environment: { PATH: "/usr/bin:/bin" },
        timeoutMs: 1000,
      }),
    /namespace_replaced/,
  );
  assert.equal(readdirSync("/proc/self/fd").length, before);
});
test("invalid namespace identity and replaced PID refuse before child execution", {
  skip: !linux,
}, () => {
  for (const [pid, expected] of [
    [-1, "mnt:[1]"],
    [process.pid, "net:[1]"],
    [process.pid, "mnt:[1]"],
  ] as const)
    assert.throws(() => openNamespace(pid, "mnt", expected));
});
