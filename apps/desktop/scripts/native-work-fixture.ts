import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit, pinned native-engine archive only. No download, installed profile or ambient engine. */
export async function runNativeWorkFixture(mode: "smoke" | "measure", runtime: string) {
  if (process.env.OPENBOT_NATIVE_TEMPORAL_FIXTURE) return false;
  const archive = process.env.OPENBOT_NATIVE_TEMPORAL_ARCHIVE;
  assert(
    archive,
    "Set OPENBOT_NATIVE_TEMPORAL_ARCHIVE to the reviewed 1.32.0 macOS arm64 archive.",
  );
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const child = spawn(
    join(runtime, "python/bin/python3.12"),
    [
      "-I",
      join(root, "experiments/work-journey/native_temporal_probe.py"),
      "--node",
      process.execPath,
      "--archive",
      archive,
      "--mode",
      mode,
      "--runtime",
      runtime,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => child.kill(signal));
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return true;
}

export async function configureNativeWorkFixture(dataRoot: string) {
  const receipt = process.env.OPENBOT_NATIVE_TEMPORAL_FIXTURE;
  assert(receipt, "The owned native engine must supply its private fixture receipt.");
  const fixture = JSON.parse(await readFile(receipt, "utf8"));
  assert.match(fixture.address, /^127\.0\.0\.1:\d+$/);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataRoot, "temporal.json"),
    JSON.stringify({
      temporal_address: fixture.address,
      namespace: "default",
      queue: `openbot-native-python-${randomUUID()}`,
      tls: fixture.tls,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
