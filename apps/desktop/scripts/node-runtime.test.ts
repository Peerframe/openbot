/** Preserves archive-integrity and bounded build-child negatives after CPython retirement. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRuntimeBuildStage } from "./runtime-build.ts";
import { NODE_ARCHIVE, verifiedDownload } from "./node-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("pins real interpreter archives and rejects missing bytes, checksum drift and oversized input", async () => {
  expect(NODE_ARCHIVE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const root = await mkdtemp(join(tmpdir(), "openbot-native-download-test-"));
  roots.push(root);
  const bytes = Buffer.from("bounded synthetic artifact");
  const archive = {
    url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
    maximumBytes: 1024,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await verifiedDownload(archive, join(root, "valid"));
  expect(await readFile(join(root, "valid"))).toEqual(bytes);
  await expect(
    verifiedDownload({ ...archive, sha256: "0".repeat(64) }, join(root, "drift")),
  ).rejects.toThrow("checksum");
  await expect(readFile(join(root, "drift"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    verifiedDownload({ ...archive, maximumBytes: 1 }, join(root, "large")),
  ).rejects.toThrow("bound");
});

it("accepts a completed build child with the original filtered environment", async () => {
  vi.stubEnv("OPENBOT_NATIVE_BUILD_TEST", "must-not-inherit");
  await expect(
    runRuntimeBuildStage(
      "synthetic success",
      process.execPath,
      [
        "-e",
        'if (process.env.OPENBOT_NATIVE_BUILD_TEST || process.env.PATH !== "/usr/bin:/bin" || process.env.LANG !== "C.UTF-8") process.exit(17)',
      ],
      tmpdir(),
    ),
  ).resolves.toBeUndefined();
});

it("reports the specific stage and nonzero exit without echoing arguments", async () => {
  const error = await runRuntimeBuildStage(
    "synthetic failed check",
    process.execPath,
    ["-e", "process.exit(7)", "private-argument"],
    tmpdir(),
  ).catch((error) => error);
  expect(error).toMatchObject({
    stage: "synthetic failed check",
    exitCode: 7,
    signal: null,
    timedOut: false,
  });
  expect(error.message).toContain('stage "synthetic failed check"');
  expect(error.message).not.toContain("private-argument");
  expect(error.elapsedMs).toBeGreaterThanOrEqual(0);
});

it("distinguishes child self-termination from a stage timeout", async () => {
  await expect(
    runRuntimeBuildStage(
      "synthetic signal",
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      tmpdir(),
    ),
  ).rejects.toMatchObject({
    // Windows self-termination cannot set the parent process handle's signal field.
    stage: "synthetic signal",
    exitCode: process.platform === "win32" ? 1 : null,
    signal: process.platform === "win32" ? null : "SIGTERM",
    timedOut: false,
  });
});

it("kills an overdue child and records the timeout rather than a generic failure", async () => {
  await expect(
    runRuntimeBuildStage(
      "synthetic deadline",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      tmpdir(),
      100,
    ),
  ).rejects.toMatchObject({
    stage: "synthetic deadline",
    exitCode: null,
    signal: "SIGKILL",
    timedOut: true,
  });
});

it("reports spawn failure without exposing the attempted executable path", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-native-spawn-test-"));
  roots.push(root);
  const path = join(root, "private-missing-executable");
  const error = await runRuntimeBuildStage("synthetic missing executable", path, [], root).catch(
    (error) => error,
  );
  expect(error).toMatchObject({ spawnCode: "ENOENT", timedOut: false });
  expect(error.message).not.toContain(path);
});
