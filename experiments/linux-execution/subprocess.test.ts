/** Real owned subprocesses verify output/drain bounds and minimal environment without Docker. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerUnavailable, SubprocessCommander } from "./subprocess.ts";
const node = (captureLimit = 4096) =>
  new SubprocessCommander({
    binary: process.execPath,
    captureLimit,
    environment: { PATH: "/usr/bin:/bin" },
  });
test("fixed argv preserves literals, separates output and does not inherit ambient authority", async () => {
  const result = await node().run(
    [
      "-e",
      "process.stdout.write(JSON.stringify({args:process.argv.slice(1),keys:Object.keys(process.env)}));process.stderr.write('err')",
      "--",
      "$(whoami)",
      "; echo unsafe",
    ],
    3000,
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "err");
  const value = JSON.parse(result.stdout);
  assert.deepEqual(value.args, ["$(whoami)", "; echo unsafe"]);
  assert.deepEqual(
    value.keys.filter(
      (key: string) => process.platform !== "darwin" || key !== "__CF_USER_TEXT_ENCODING",
    ),
    ["PATH"],
  );
});
test("missing executable and invalid capture limits fail before spawn", () => {
  assert.throws(
    () => new SubprocessCommander({ binary: "/nonexistent/openbot-fixed-binary" }),
    DockerUnavailable,
  );
  for (const limit of [0, -1, 1.5, Infinity]) assert.throws(() => node(limit), /capture limit/);
});
test("combined stdout/stderr overflow is unknown and retains only the bound", async () => {
  const result = await node().run(
    ["-e", "process.stdout.write('x'.repeat(3000));process.stderr.write('y'.repeat(100000));"],
    3000,
  );
  assert.equal(result.outputTruncated, true);
  assert.equal(result.uncertain, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.capturedBytes, 4096);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 4096);
});
test("exact capture limit remains complete", async () => {
  const r = await node().run(["-e", "process.stdout.write('x'.repeat(4096))"], 3000);
  assert.equal(r.ok, true);
  assert.equal(r.outputTruncated, false);
  assert.equal(r.capturedBytes, 4096);
});
test("nonzero complete exit is definite failure", async () => {
  const r = await node().run(
    ["-e", "process.stderr.write('No such object');process.exitCode=1"],
    3000,
  );
  assert.equal(r.status, 1);
  assert.equal(r.uncertain, false);
  assert.equal(r.ok, false);
});
test("deadline includes child lifetime", async () => {
  const r = await node().run(["-e", "setInterval(()=>{},1000)"], 150);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.equal(r.ok, false);
});
test("exited parent with descendant holding pipes cannot become successful", {
  skip: process.platform === "win32",
}, async () => {
  const source =
    "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}).unref()";
  const r = await node().run(["-e", source], 250);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.equal(r.ok, false);
});
test("truncated missing-object text remains unknown", async () => {
  const r = await node().run(
    ["-e", "process.stderr.write('No such object'+ 'x'.repeat(10000));process.exitCode=1"],
    3000,
  );
  assert.equal(r.outputTruncated, true);
  assert.equal(r.uncertain, true);
  assert.equal(r.status, null);
});

test("only the two explicit namespace descriptors reach the fixed child", async (t) => {
  const { mkdtempSync, writeFileSync, openSync, closeSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ob-fds-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "mount"), "mount identity");
  writeFileSync(join(root, "network"), "network identity");
  const first = openSync(join(root, "mount"), "r"),
    second = openSync(join(root, "network"), "r");
  try {
    const runner = new SubprocessCommander({
      binary: process.execPath,
      environment: { PATH: "/usr/bin:/bin" },
      namespaceDescriptors: [first, second],
    });
    const found = await runner.run(
      [
        "-e",
        "const fs=require('node:fs');process.stdout.write(JSON.stringify([fs.readFileSync(3,'utf8'),fs.readFileSync(4,'utf8')]));",
      ],
      3000,
    );
    assert(found.ok);
    assert.deepEqual(JSON.parse(found.stdout), ["mount identity", "network identity"]);
  } finally {
    closeSync(first);
    closeSync(second);
  }
});
