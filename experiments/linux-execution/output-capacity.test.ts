/** Counterexamples ported from the Python gate; injected ext4 facts are not real mount evidence. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  OutputCapacityRefused,
  deviceNumbers,
  readKernelText,
  verifyOutputCapacity,
} from "./output-capacity.ts";
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openbot-capacity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "output space");
  mkdirSync(output);
  const identity = statSync(output, { bigint: true }),
    limit = 64 * 1024 * 1024;
  const cfg = {
    device: deviceNumbers(identity.dev),
    sectors: String(limit / 512),
    filesystem: "ext4",
    mountRoot: "/",
    mountpoint: output,
    options: "rw,nodev,nosuid,noexec",
    propagation: "",
    superOptions: "rw",
    nested: "",
    fdinfo: "mnt_id:\t42\n",
    flags: 0n,
    blocks: 8192n,
    fragmentSize: 4096n,
  };
  const escaped = (path: string) => path.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
  const mountinfo = () =>
    `42 1 ${cfg.device} ${cfg.mountRoot} ${escaped(cfg.mountpoint)} ${cfg.options} ${cfg.propagation} - ${cfg.filesystem} /dev/loop0 ${cfg.superOptions}\n${cfg.nested}`;
  const dependencies = {
    platform: "linux",
    read: (path: string, _limit?: number) => {
      if (path.startsWith("/proc/self/fdinfo/")) return cfg.fdinfo;
      if (path === "/proc/self/mountinfo") return mountinfo();
      if (path === `/sys/dev/block/${cfg.device}/size`) return cfg.sectors;
      throw new Error("unexpected kernel read");
    },
    filesystem: () => ({ blocks: cfg.blocks, fragmentSize: cfg.fragmentSize, flags: cfg.flags }),
  };
  return {
    root,
    output,
    identity,
    limit,
    cfg,
    dependencies,
    escaped,
    verify: () => verifyOutputCapacity(output, limit, dependencies),
  };
}
test("dedicated bounded ext4 and escaped path preserve exact observations", (t) => {
  const f = fixture(t),
    seen = f.verify();
  assert.equal(seen.path, f.output);
  assert.equal(seen.device_bytes, f.limit);
  assert.equal(seen.filesystem_bytes, 32 * 1024 * 1024);
  assert.equal(seen.inode, Number(f.identity.ino));
});
test("low free space cannot prove a large device bounded", (t) => {
  const f = fixture(t);
  f.cfg.sectors = String(1024 ** 4 / 512);
  assert.throws(f.verify, /total output device/);
});
test("ordinary directory and bind subtree are refused", (t) => {
  const f = fixture(t);
  f.cfg.mountpoint = f.root;
  assert.throws(f.verify, /dedicated filesystem/);
  f.cfg.mountpoint = f.output;
  f.cfg.mountRoot = "/subtree";
  assert.throws(f.verify, /dedicated filesystem/);
});
for (const filesystem of ["tmpfs", "overlay", "nfs", "fuse"])
  test(`refuses ${filesystem} output`, (t) => {
    const f = fixture(t);
    f.cfg.filesystem = filesystem;
    assert.throws(f.verify, /persistent ext4/);
  });
for (const [options, propagation] of [
  ["rw,nodev,nosuid", ""],
  ["ro,nodev,nosuid,noexec", ""],
  ["rw,nodev,nosuid,noexec", "shared:3"],
  ["rw,nodev,nosuid,noexec", "master:3"],
  ["rw,nodev,nosuid,noexec", "propagate_from:3"],
])
  test(`refuses mount flags ${options} ${propagation}`, (t) => {
    const f = fixture(t);
    f.cfg.options = options!;
    f.cfg.propagation = propagation!;
    assert.throws(f.verify, OutputCapacityRefused);
  });
test("nested mount cannot bypass capacity", (t) => {
  const f = fixture(t);
  f.cfg.nested = `43 42 0:1 / ${f.escaped(join(f.output, "nested"))} rw - tmpfs tmpfs rw\n`;
  assert.throws(f.verify, /nested output mounts/);
});
for (const fdinfo of ["", "mnt_id: 1\n", "mnt_id: 42\nmnt_id: 42\n", "mnt_id: bad\n"])
  test(`refuses invalid descriptor identity ${JSON.stringify(fdinfo)}`, (t) => {
    const f = fixture(t);
    f.cfg.fdinfo = fdinfo;
    assert.throws(f.verify, OutputCapacityRefused);
  });
test("mount device must match open directory", (t) => {
  const f = fixture(t);
  f.cfg.device = "8:999";
  assert.throws(f.verify, /device disagree/);
});
test("second mount of same device refused", (t) => {
  const f = fixture(t);
  f.cfg.nested = `43 1 ${f.cfg.device} / /other-action rw - ext4 /dev/loop0 rw\n`;
  assert.throws(f.verify, /another mount/);
});
test("kernel I/O failures remain closed", (t) => {
  const f = fixture(t);
  f.dependencies.read = () => {
    throw new Error("unavailable");
  };
  assert.throws(f.verify, /could not be verified/);
});
for (const sectors of ["-1", "0", "bad", "1"])
  test(`refuses inconsistent capacity ${sectors}`, (t) => {
    const f = fixture(t);
    f.cfg.sectors = sectors;
    assert.throws(f.verify, OutputCapacityRefused);
  });
test("read-only superblock refused", (t) => {
  const f = fixture(t);
  f.cfg.flags = 1n;
  assert.throws(f.verify, /read-only/);
});
test("read-only mount option refused", (t) => {
  const f = fixture(t);
  f.cfg.superOptions = "ro";
  assert.throws(f.verify, OutputCapacityRefused);
});
test("symlink source refused", (t) => {
  const f = fixture(t),
    link = join(f.root, "link");
  symlinkSync(f.output, link);
  assert.throws(() => verifyOutputCapacity(link, f.limit, f.dependencies), /no symlinks/);
});
test("mount topology changing during observation refused", (t) => {
  const f = fixture(t),
    read = f.dependencies.read;
  let reads = 0;
  f.dependencies.read = (path, limit) => {
    const value = read(path, limit);
    return path === "/proc/self/mountinfo" && ++reads === 2
      ? value + "43 1 0:1 / /other rw - tmpfs tmpfs rw\n"
      : value;
  };
  assert.throws(f.verify, /topology changed/);
});
test("unsupported platform and invalid limits perform no kernel reads", (t) => {
  const f = fixture(t);
  f.dependencies.read = () => assert.fail("unexpected kernel read");
  assert.throws(
    () => verifyOutputCapacity(f.output, f.limit, { ...f.dependencies, platform: "darwin" }),
    /requires Linux/,
  );
  for (const value of [true, 0, -1, 1.5, f.limit + 1])
    assert.throws(
      () => verifyOutputCapacity(f.output, value as number, f.dependencies),
      /limit must be/,
    );
});
test("kernel text capture is byte-bounded and strictly UTF8", (t) => {
  const f = fixture(t),
    path = join(f.root, "capture");
  writeFileSync(path, "x".repeat(9));
  assert.throws(() => readKernelText(path, 8), /capture limit/);
  writeFileSync(path, Buffer.from([255]));
  assert.throws(() => readKernelText(path, 8));
});
