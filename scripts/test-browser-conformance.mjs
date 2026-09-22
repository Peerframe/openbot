import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformanceChild } from "../providers/docker/conformance/child-process.mjs";
import { SmokeDatabase } from "./smoke-dev-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
assert(
  args.length === 2 && args[0] === "--output" && args[1],
  "Usage: node scripts/test-browser-conformance.mjs --output <new-report.json>",
);
assert(
  ["darwin", "linux"].includes(process.platform),
  "This fixture driver requires POSIX child-process signals (Linux or macOS).",
);
const report = resolve(args[1]);
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const directory = await mkdtemp(join(tmpdir(), "openbot-browser-driver-"));
const database = new SmokeDatabase();
const environment = {
  PATH: process.env.PATH ?? "",
  TMPDIR: directory,
  CI: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_NO_UPDATE_NOTIFIER: "1",
  TURBO_CACHE: "local:rw",
};
function node(args, timeoutMs = 180_000, extraEnv = {}) {
  return runConformanceChild(args, {
    cwd: root,
    env: { ...environment, ...extraEnv },
    signal: controller.signal,
    timeoutMs,
  });
}
try {
  console.info("Docker browser conformance: building production components.");
  await node([
    "node_modules/turbo/bin/turbo",
    "run",
    "build",
    "--filter=@openbot/server",
    "--filter=@openbot/node",
    "--filter=@openbot/provider-conformance-runner",
  ]);
  await node(["--test", "providers/docker/conformance/computer.test.mjs"]);
  console.info("Docker browser conformance: starting owned PostgreSQL fixture.");
  const url = await database.start(controller.signal, randomBytes(24).toString("hex"));
  await node(
    [
      "packages/provider-conformance-runner/dist/cli.js",
      "--module",
      "providers/docker/conformance/suite.mjs",
      "--output",
      report,
    ],
    240_000,
    { OPENBOT_CONFORMANCE_DATABASE_URL: url },
  );
  console.info("Docker browser conformance: all required scenarios passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([
    database.stop(),
    rm(directory, { recursive: true, force: true }),
  ]);
  if (cleanup.every((result) => result.status === "fulfilled")) {
    console.info("Docker browser conformance: owned database and private files removed.");
  } else {
    console.error("Docker browser conformance cleanup failed; owned fixture requires inspection.");
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
