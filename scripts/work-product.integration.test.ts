/** Complete Work/model/plugin/browser/command product path; all external effect peers are synthetic. */
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { createDatabase } from "@openbot/db";
import { installWorkRuntime } from "@openbot/work";
import { it } from "vitest";
import { allowlistedEnvironment, OwnedDockerFixture, startControlPostgres } from "./python-acceptance-fixture.ts";
import { startTemporalFixture } from "./temporal-fixture.ts";
import { qualifyWorkProduct } from "./integration/work-product.ts";
it("retains actual authority, receipts, cancellation and no-replay behavior through product execution", async () => {
  await installWorkRuntime();
  const temporal = await startTemporalFixture();
  const docker = new OwnedDockerFixture(fileURLToPath(new URL("../", import.meta.url)), allowlistedEnvironment(["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]));
  try {
    const dsn = await startControlPostgres(docker, "openbot-work-product-" + randomUUID(), randomBytes(24).toString("hex"));
    const db = createDatabase(dsn); try { await db.migrate(); } finally { await db.close(); }
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../packages/work/dist/workflows.js", import.meta.url)) });
    await qualifyWorkProduct(dsn, temporal.settings, workflowBundle);
  } finally { try { docker.cleanup(); } finally { await temporal.close(); } }
});
