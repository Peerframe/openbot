import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  PYTHON_INSTALL_TIMEOUT_MS,
  pythonInstallArguments,
  runPythonBuildStage,
} from "./python-build.ts";
import { NODE_ARCHIVE, PYTHON_ARCHIVE, verifiedDownload } from "./python-runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("pins real interpreter archives and rejects missing bytes, checksum drift and oversized input", async () => {
  expect(PYTHON_ARCHIVE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(NODE_ARCHIVE.sha256).toMatch(/^[a-f0-9]{64}$/u);
  const root = await mkdtemp(join(tmpdir(), "openbot-python-download-test-"));
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

it("preserves the reviewed standalone Python component license collection", async () => {
  const directory = new URL("../resources/python-notices/", import.meta.url);
  const source = JSON.parse(await readFile(new URL("SOURCE.json", directory), "utf8"));
  const notices = await readFile(new URL("NOTICES.txt", directory));
  expect(source.commit).toBe("00c8a06113f11220667c3bcf5fab1672ff9e78ef");
  expect(createHash("sha256").update(notices).digest("hex")).toBe(source.noticeSha256);
  for (const name of [
    "LICENSE.cpython.txt",
    "LICENSE.openssl-3.txt",
    "LICENSE.libffi.txt",
    "LICENSE.zlib.txt",
  ]) {
    expect(source.files[name].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(notices.toString()).toContain(`===== ${name} =====`);
  }
});

it("keeps a finite wheel-install budget and explicit bounded pip retries", () => {
  expect(PYTHON_INSTALL_TIMEOUT_MS).toBe(15 * 60_000);
  expect(pythonInstallArguments("synthetic.lock")).toEqual([
    "-I",
    "-B",
    "-m",
    "pip",
    "--isolated",
    "install",
    "--no-cache-dir",
    "--index-url",
    "https://pypi.org/simple",
    "--disable-pip-version-check",
    "--timeout",
    "30",
    "--retries",
    "5",
    "--resume-retries",
    "5",
    "--no-deps",
    "--only-binary=:all:",
    "-r",
    "synthetic.lock",
  ]);
});

it("accepts a completed build child with the original filtered environment", async () => {
  vi.stubEnv("OPENBOT_PYTHON_BUILD_TEST", "must-not-inherit");
  await expect(
    runPythonBuildStage(
      "synthetic success",
      process.execPath,
      [
        "-e",
        'if (process.env.OPENBOT_PYTHON_BUILD_TEST || process.env.PATH !== "/usr/bin:/bin" || process.env.LANG !== "C.UTF-8") process.exit(17)',
      ],
      tmpdir(),
    ),
  ).resolves.toBeUndefined();
});

it("reports the specific stage and nonzero exit without echoing arguments", async () => {
  const error = await runPythonBuildStage(
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
    runPythonBuildStage(
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
    runPythonBuildStage(
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
  const root = await mkdtemp(join(tmpdir(), "openbot-python-spawn-test-"));
  roots.push(root);
  const path = join(root, "private-missing-executable");
  const error = await runPythonBuildStage("synthetic missing executable", path, [], root).catch(
    (error) => error,
  );
  expect(error).toMatchObject({ spawnCode: "ENOENT", timedOut: false });
  expect(error.message).not.toContain(path);
});
