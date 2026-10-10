/** Real adjacent Temporal upgrade with held TS product histories and a cold engine-only restore. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { installWorkRuntime } from "@openbot/work";
import { it } from "vitest";
import {
  allowlistedEnvironment,
  OwnedDockerFixture,
  startControlPostgres,
} from "./acceptance-fixture.ts";
import { startUpgradeTemporalFixture } from "./temporal-upgrade-fixture.ts";
import { qualifyWorkUpgrade } from "./integration/work-upgrade.ts";
it("retains authority, original histories and no-replay behavior across 1.31.3 to 1.32.0 and cold restore", {
  timeout: 1500000,
}, async () => {
  const archive = process.env.OPENBOT_TEMPORAL_PREVIOUS_ARCHIVE;
  assert(archive, "Supply the reviewed platform's official 1.31.3 archive.");
  const signal = AbortSignal.timeout(1400000);
  await installWorkRuntime();
  const engine = await startUpgradeTemporalFixture(archive, signal);
  const docker = new OwnedDockerFixture(
    fileURLToPath(new URL("../", import.meta.url)),
    allowlistedEnvironment([
      "PATH",
      "HOME",
      "TMPDIR",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
    ]),
  );
  try {
    await engine.warmup();
    const dsn = await startControlPostgres(
      docker,
      "openbot-upgrade-control-" + randomUUID(),
      randomBytes(24).toString("hex"),
    );
    const bundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../packages/work/dist/workflows.js", import.meta.url)),
    });
    await qualifyWorkUpgrade(dsn, engine, bundle);
  } finally {
    try {
      docker.cleanup();
    } finally {
      await engine.close();
    }
  }
});
