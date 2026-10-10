/** Original native readback counterexamples; injected mount facts do not qualify a real unit. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  openSync,
  closeSync,
  ftruncateSync,
  fstatSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  boundedOutput,
  checkSocketMountFacts,
  configurationValues,
  guard,
  preflightPaths,
  privateMountFlags,
  properties,
  socketMountSnapshot,
  socketPaths,
  verifyRuntimeSocketMount,
} from "./native-facts.ts";
import { exclusive, readRecord } from "./protected-io.ts";
import type { Mount } from "./output-capacity.ts";
const own = (t: TestContext) => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "ob-native-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
for (const change of ["expired", "boot", "instance"])
  test(`actual local launch guard refuses ${change}`, (t) => {
    const path = join(own(t), "instance.json");
    exclusive(path, { instanceId: "original" });
    const value = {
      bootId: "boot",
      enforcerInstanceId: change === "instance" ? "old" : "original",
      expiresBoottimeUs: 5000,
    };
    assert.throws(
      () =>
        guard(
          value,
          path,
          () => [
            change === "expired" ? 5000 : 1000,
            change === "expired" ? 5000 : 1000,
            change === "boot" ? "another" : "boot",
          ],
          (p) => readRecord(p, process.getuid!()),
        ),
      /native_guard_expired/,
    );
  });
test("valid guard and exact native lifetime retain kill and secrets policy", (t) => {
  const path = join(own(t), "instance.json");
  exclusive(path, { instanceId: "original" });
  assert.deepEqual(
    guard(
      { bootId: "boot", enforcerInstanceId: "original", expiresBoottimeUs: 5000 },
      path,
      () => [1, 2, "boot"],
      (p) => readRecord(p, process.getuid!()),
    ),
    [1, 2],
  );
  const p = properties(50000, "/opt/keys");
  assert.equal(p.RuntimeMaxSec, "50000ms");
  assert.equal(p.Restart, "no");
  assert.equal(p.KillMode, "control-group");
  assert.equal(p.InaccessiblePaths, "/opt/keys");
  assert.throws(() => properties(50001, "/opt/keys"));
  assert.throws(() => properties(true as unknown as number, "/opt/keys"));
});
test("libnetwork and hashed shim socket paths fit kernel limit", () => {
  preflightPaths("/opt/obh/a123456789ab");
  assert.throws(() => preflightPaths("/opt/" + "a".repeat(70)));
  assert(socketPaths("/opt/x").some((v) => v.includes("libnetwork/0123456789ab.sock")));
});
test("private daemon uses only original private sockets and fixed runtime", () => {
  const root = "/opt/obh/a123456789ab",
    { daemon: d, containerd: c } = configurationValues(root, "original.service", "/opt/bin");
  assert.equal(d.containerd, root + "/containerd.sock");
  assert.deepEqual(d.hosts, ["unix://" + root + "/docker.sock"]);
  assert.equal(d["containerd-namespace"], "openbot-command");
  for (const key of [
    "iptables",
    "ip6tables",
    "ip-forward",
    "ip-masq",
    "userland-proxy",
    "live-restore",
  ] as const)
    assert.equal(d[key], false);
  assert(c.includes("io.containerd.cri.v1") && c.includes(root + "/containerd-state"));
  assert.deepEqual(d.runtimes.runsc.runtimeArgs, ["--platform=systrap"]);
  assert.deepEqual(d["log-opts"], { "max-size": "1m", "max-file": "1", compress: "false" });
});
for (const change of ["large", "sparse", "symlink", "extra", "fifo", "nul", "invalid_utf8"])
  test(`native output refuses ${change}`, (t) => {
    const root = own(t),
      path = join(root, "proof.txt");
    writeFileSync(path, "good");
    if (change === "large") writeFileSync(path, "x".repeat(11));
    if (change === "sparse") {
      const fd = openSync(path, "w");
      try {
        ftruncateSync(fd, 100 * 1024 ** 3);
      } finally {
        closeSync(fd);
      }
    }
    if (change === "symlink") {
      unlinkSync(path);
      symlinkSync("/etc/passwd", path);
    }
    if (change === "extra") writeFileSync(join(root, "other"), "x");
    if (change === "fifo") {
      unlinkSync(path);
      assert.equal(spawnSync("/usr/bin/mkfifo", [path]).status, 0);
    }
    if (change === "nul") writeFileSync(path, Buffer.from([97, 0]));
    if (change === "invalid_utf8") writeFileSync(path, Buffer.from([255]));
    assert.throws(() => boundedOutput(root, { name: "proof.txt", maxBytes: 10 }));
  });
test("native output returns exact bounded UTF8 bytes", (t) => {
  const root = own(t),
    data = Buffer.from("x,y\n1,2\n");
  writeFileSync(join(root, "proof.csv"), data);
  assert.deepEqual(boundedOutput(root, { name: "proof.csv", maxBytes: 1048576 }), data);
});
function shim() {
  const mount: Mount = {
    id: 5,
    device: "0:2",
    path: "/run/containerd",
    root: "/",
    filesystem: "tmpfs",
    options: new Set(["rw", "nosuid", "nodev", "noexec"]),
    superOptions: new Set(["rw", "size=16384k", "mode=700"]),
    propagation: [],
  };
  return { mount, identity: { uid: 0, mode: 0o40700, dev: 2, ino: 3 } };
}
test("fixed private tmpfs request and valid exact readback", () => {
  const p = properties(50000, "/opt/keys");
  assert.equal(p.MountFlags, "private");
  assert.equal(p.TemporaryFileSystem, "/run/containerd:rw,nosuid,nodev,noexec,mode=0700,size=16m");
  const { mount, identity } = shim();
  assert.equal(
    checkSocketMountFacts([mount], identity, 5, 16 * 1024 ** 2).filesystemBytes,
    16 * 1024 ** 2,
  );
});
for (const [change, code] of [
  ["path", "path"],
  ["root", "root"],
  ["filesystem", "filesystem"],
  ["options", "options"],
  ["readonly", "readonly"],
  ["shared", "propagation"],
  ["slave", "propagation"],
  ["unknown_propagation", "propagation"],
  ["uid", "uid"],
  ["mode", "mode"],
  ["size", "capacity"],
  ["zero_size", "capacity"],
  ["missing", "ambiguous"],
  ["duplicate", "ambiguous"],
])
  test(`shim ${change} retains exact refusal code`, () => {
    const { mount, identity } = shim();
    let entries = [mount],
      size = 16 * 1024 ** 2;
    switch (change) {
      case "path":
        mount.path = "/unexpected";
        break;
      case "root":
        mount.root = "/subtree";
        break;
      case "filesystem":
        mount.filesystem = "ext4";
        break;
      case "options":
        mount.options.delete("noexec");
        break;
      case "readonly":
        mount.superOptions.add("ro");
        break;
      case "shared":
        mount.propagation = ["shared:123"];
        break;
      case "slave":
        mount.propagation = ["master:123"];
        break;
      case "unknown_propagation":
        mount.propagation = ["future:unknown"];
        break;
      case "uid":
        identity.uid = 1000;
        break;
      case "mode":
        identity.mode = 0o40755;
        break;
      case "size":
        size += 4096;
        break;
      case "zero_size":
        size = 0;
        break;
      case "missing":
        entries = [];
        break;
      case "duplicate":
        entries.push({ ...mount });
        break;
    }
    assert.throws(
      () => checkSocketMountFacts(entries, identity, 5, size),
      new RegExp("^Error: shim_mount_" + code + "$"),
    );
  });
test("safe snapshot excludes arbitrary paths, labels and option values", () => {
  const { mount, identity } = shim();
  Object.assign(mount, {
    path: "/private-secret-path",
    root: "/private-subtree",
    filesystem: "private-fs-name",
    propagation: ["shared:123", "master:2", "propagate_from:4", "unbindable", "secret_field"],
  });
  mount.options.add("sensitive=secret_value");
  mount.superOptions.add("context=secret_label");
  const value = socketMountSnapshot([mount], identity, 5, 16 * 1024 ** 2),
    encoded = JSON.stringify(value);
  for (const secret of [
    "private-secret",
    "private-subtree",
    "private-fs-name",
    "secret_value",
    "secret_label",
    "secret_field",
    "sensitive=",
  ])
    assert(!encoded.includes(secret));
  assert("mount" in value);
  assert.equal(value.mount.filesystem, "other");
  assert.equal(value.mount.unknownFlagCount, 1);
  assert.deepEqual(value.mount.propagation, [
    { kind: "shared", group: 123 },
    { kind: "master", group: 2 },
    { kind: "propagate_from", group: 4 },
    { kind: "unbindable" },
    { kind: "unknown" },
  ]);
});
for (const recordFailure of [false, true])
  test(`failed shim readback closes descriptor and persists only safe evidence (${recordFailure})`, (t) => {
    const root = own(t),
      fd = openSync(root, "r"),
      { mount, identity } = shim();
    if (!recordFailure) mount.propagation = ["shared:123"];
    const path = join(root, "shim.json"),
      ops = {
        open: () => fd,
        read: () => "same",
        filesystem: () => ({ blocks: 4096n, fragmentSize: 4096n, flags: 0n }),
        identity: () => Object.assign(fstatSync(fd), identity),
        mountId: () => 5,
        mounts: () => [mount],
        exclusive: recordFailure
          ? () => {
              throw new Error("synthetic fsync failure");
            }
          : exclusive,
      };
    assert.throws(
      () => verifyRuntimeSocketMount(path, ops),
      recordFailure ? /synthetic fsync failure/ : /shim_mount_propagation/,
    );
    assert.throws(() => fstatSync(fd), { code: "EBADF" });
    if (!recordFailure) {
      const value = readRecord(path, process.getuid!()) as { mount: { propagation: unknown } };
      assert.deepEqual(value.mount.propagation, [{ kind: "shared", group: 123 }]);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });
const objectReply = { type: "o", data: ["/org/freedesktop/systemd1/unit/original"] };
for (const value of [
  { type: "s", data: "private" },
  { type: "u", data: 262144 },
  { type: "t", data: "262144" },
  { type: "t", data: true },
  { type: "t", data: [262144] },
  { type: "t", data: 0 },
  { type: "t", data: 524288 },
  { type: "t", data: 1048576 },
  { type: "t", data: 278528 },
  { type: "t", data: 262144, extra: 0 },
  { type: "t" },
  [],
  null,
])
  test(`MountFlags refuses ${JSON.stringify(value)}`, async () => {
    const replies = [objectReply, value];
    await assert.rejects(
      privateMountFlags("original.service", async () => JSON.stringify(replies.shift())),
      /unit_mount_flags_changed/,
    );
  });
test("MountFlags rejects floating-point numeric token even if mathematically integral", async () => {
  const replies = [JSON.stringify(objectReply), '{"type":"t","data":262144.0}'];
  await assert.rejects(
    privateMountFlags("original.service", async () => replies.shift()!),
    /unit_mount_flags_changed/,
  );
});
for (const value of [
  { type: "s", data: objectReply.data },
  { type: "o", data: objectReply.data[0] },
  { type: "o", data: [] },
  { type: "o", data: ["/elsewhere"] },
  { type: "o", data: [objectReply.data[0], "second"] },
  { type: "o", data: [false] },
  [],
  null,
])
  test(`GetUnit refuses ${JSON.stringify(value)}`, async () => {
    let calls = 0;
    await assert.rejects(
      privateMountFlags("original.service", async () => {
        calls++;
        return JSON.stringify(value);
      }),
      /unit_mount_object_changed/,
    );
    assert.equal(calls, 1);
  });
test("MountFlags resolves original typed service then reads exact property", async () => {
  const replies = [
      { type: "o", data: ["/org/freedesktop/systemd1/unit/original_2eservice"] },
      { type: "t", data: 262144 },
    ],
    calls: string[][] = [];
  assert.deepEqual(
    await privateMountFlags("original.service", async (args) => {
      calls.push(args);
      return JSON.stringify(replies.shift());
    }),
    { type: "t", data: 262144 },
  );
  assert.deepEqual(calls[0]!.slice(-3), ["GetUnit", "s", "original.service"]);
  assert.deepEqual(calls[1], [
    "/usr/bin/busctl",
    "--json=short",
    "get-property",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1/unit/original_2eservice",
    "org.freedesktop.systemd1.Service",
    "MountFlags",
  ]);
});
