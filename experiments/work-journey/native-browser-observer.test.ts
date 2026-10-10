/** Real Linux descriptor regressions for fixed runtime observations, using only a disposable proc-shaped tree. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserRuntimeObservation } from "./native-browser-observer.ts";
test("observes only stable original fixed executables and never reads unrelated cmdlines", {
  skip: process.platform !== "linux",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "obp5-proc-")),
    binary = join(root, "bin"),
    proc = join(root, "proc"),
    processPath = join(proc, "42");
  try {
    mkdirSync(binary + "/gvisor-bin", { recursive: true });
    mkdirSync(processPath, { recursive: true });
    for (const name of ["runsc", "gvisor-bin/gvisor_sentry", "unrelated"])
      writeFileSync(join(binary, name), "synthetic");
    symlinkSync(binary + "/gvisor-bin/gvisor_sentry", processPath + "/exe");
    writeFileSync(processPath + "/cgroup", "0::/system.slice/owned/sandbox\n");
    writeFileSync(
      processPath + "/stat",
      "42 (name with spaces) " + ["S", ...Array(18).fill("0"), "99"].join(" "),
    );
    writeFileSync(processPath + "/cmdline", "runsc-sandbox\0--oci-seccomp=true\0boot\0");
    const member = { pid: 42, cgroup: "/system.slice/owned/sandbox", startTicks: "99" },
      group = "/sys/fs/cgroup/system.slice/owned";
    const read = (members = [member]) => browserRuntimeObservation(group, members, binary, proc);
    const before = readdirSync("/proc/self/fd").length;
    assert.deepEqual(read(), {
      processes: [
        {
          ...member,
          executable: "gvisor-bin/gvisor_sentry",
          argv: ["runsc-sandbox", "--oci-seccomp=true", "boot"],
        },
      ],
      errors: [],
    });
    for (const changed of [
      { ...member, startTicks: "98" },
      { ...member, cgroup: "/outside" },
    ]) {
      const result = read([changed]);
      assert.equal(result.processes.length, 0);
      assert.equal(result.errors.length, 1);
    }
    for (const invalid of [
      Buffer.alloc(16385, 120),
      Buffer.from("missing terminator"),
      Buffer.from([0xff, 0]),
    ]) {
      writeFileSync(processPath + "/cmdline", invalid);
      const result = read();
      assert.equal(result.processes.length, 0);
      assert.equal(result.errors.length, 1);
    }
    writeFileSync(processPath + "/cmdline", Buffer.alloc(16385, 120));
    unlinkSync(processPath + "/exe");
    symlinkSync(binary + "/unrelated", processPath + "/exe");
    assert.deepEqual(read(), { processes: [], errors: [] });
    unlinkSync(processPath + "/cmdline");
    assert.deepEqual(read(), { processes: [], errors: [] });
    assert.equal(
      readdirSync("/proc/self/fd").length,
      before,
      "Every refused/ignored process descriptor closes",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
