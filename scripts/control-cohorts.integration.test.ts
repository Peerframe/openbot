/** Serial stateful contract scenarios retain SQL races and real process restart boundaries. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "@openbot/db";
import { OwnerFiles } from "../apps/server/dist/owner-files.js";
import { submitDueWork } from "../apps/server/dist/work-automations.js";
import { workTransactions } from "../apps/server/dist/work-handoff.js";
import { serverContractFixture } from "./server-contract-fixture.ts";
import { startTemporalFixture } from "./temporal-fixture.ts";
import { qualifyDirectRuntime } from "./integration/direct-runtime.ts";
import { qualifyTranscriptionRead } from "./integration/transcription.ts";
import { qualifyPrimaryBotWrite } from "./integration/primary-bot.ts";
import { qualifyOwnerAuth } from "./integration/owner-auth.ts";
import { qualifyChannelReads } from "./integration/channel-read.ts";
import { qualifyProductIdentity } from "./integration/product-identity.ts";
import { qualifyModelOwnership } from "./integration/model.ts";
import { qualifyProductReads } from "./integration/product-reads.ts";
import { qualifyFileOwnership } from "./integration/files.test.ts";
import { qualifySchedulingOwnership } from "./integration/scheduling.ts";
import { qualifyIdentityLifecycle } from "./integration/identity-lifecycle.ts";
import { qualifyPluginOwnership } from "./integration/plugins.ts";
import { qualifyEmployeeOwnership } from "./integration/employee.ts";

let temporal: Awaited<ReturnType<typeof startTemporalFixture>>;
beforeAll(async () => { temporal = await startTemporalFixture(); });
afterAll(async () => { await temporal?.close(); });
describe("Server authority and persistence", () => {
  for (const [name, qualify] of [
    ["direct Worker authority", qualifyDirectRuntime], ["transcription", qualifyTranscriptionRead], ["primary Bot", qualifyPrimaryBotWrite],
    ["Owner auth", qualifyOwnerAuth], ["channel reads", qualifyChannelReads],
    ["identity", qualifyProductIdentity], ["model settings", qualifyModelOwnership],
    ["audit and progress", qualifyProductReads], ["files and storage", qualifyFileOwnership],
    ["schedules and approvals", qualifySchedulingOwnership], ["identity lifecycle", qualifyIdentityLifecycle],
    ["plugins", qualifyPluginOwnership], ["Employee", qualifyEmployeeOwnership],
  ] as const) it(name, async () => {
    const owned = await serverContractFixture({ temporal });
    try {
      await qualify({ ...owned, endpoint: owned.plugins.endpoint, token: owned.plugins.token,
        storePath: join(owned.objectRoot, "plugins/state.json"),
        admit: async (scheduleId: string) => owned.whileStopped(async () => {
          // Stop the actual background owner for this isolated admission race. All four contenders
          // still use the real SQL/file stores; Worker execution has its separate end-to-end gate.
          const database = createDatabase(owned.dsn), stores = Array.from({ length: 4 }, () => workTransactions(owned.dsn));
          const files = new OwnerFiles(join(owned.objectRoot, "attachments"));
          try {
            await database.client`UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=${scheduleId}`;
            const batches = await Promise.all(stores.map((store) => submitDueWork(store, files, 10000, AbortSignal.timeout(10000))));
            assert.equal(batches.reduce((sum, count) => sum + count, 0), 1);
            const [first] = await database.client`SELECT last_run_id,last_outcome FROM automations WHERE id=${scheduleId}`;
            assert.equal(first!.last_outcome, "submitted");
            assert.equal((await database.client`SELECT task_id FROM work_sources WHERE legacy_run_id=${first!.last_run_id}`).length, 1);
            await database.client`UPDATE automations SET next_run_at=now()-interval '2 days' WHERE id=${scheduleId}`;
            assert.equal(await submitDueWork(stores[0]!, files, 10000, AbortSignal.timeout(10000)), 1);
            const [next] = await database.client`SELECT last_run_id,last_outcome FROM automations WHERE id=${scheduleId}`;
            assert.equal(next!.last_run_id, first!.last_run_id);
            assert.equal(next!.last_outcome, "skipped_active");
          } finally { await Promise.all(stores.map((store) => store.close())); await database.close(); }
        }),
      });
    } finally { await owned.close(); }
  });
});
