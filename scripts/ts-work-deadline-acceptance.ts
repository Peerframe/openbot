import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApplicationFailure } from "@temporalio/common";
import { Worker, type NativeConnection, type WorkflowBundle } from "@temporalio/worker";
import { Client, WORKFLOW_TYPE } from "../packages/work/dist/index.js";

/** Real SDK ordering probe; the authority callbacks are explicitly synthetic. */
export async function qualifyDeadlineCloseRace(
  client: Client,
  connection: NativeConnection,
  workflowBundle: WorkflowBundle,
) {
  for (const closeFails of [false, true]) {
    const taskQueue = "openbot-deadline-race-" + randomUUID();
    const runId = randomUUID();
    const workflowId = "openbot-work-ts-v1-" + runId;
    let closeStarted!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let advances = 0,
      closes = 0;
    const worker = await Worker.create({
      connection,
      namespace: "default",
      taskQueue,
      workflowBundle,
      shutdownGraceTime: "1 second",
      shutdownForceTime: "5 seconds",
      activities: {
        awaitWorkAdmission: async () => {},
        inspectWorkTree: async () => ({ watch: true, deadline: Date.now() + 300 }),
        advanceWork: async () => {
          advances++;
          await closing;
          throw ApplicationFailure.nonRetryable("collaboration_authority_closed", "WorkConflict");
        },
        closeWorkTree: async () => {
          closes++;
          closeStarted();
          // Hold the closure acknowledgement until the conflicting Activity failure is durably
          // handled. This reproduces SQL closure becoming visible before its Activity returns.
          const end = Date.now() + 10_000;
          while (Date.now() < end) {
            const history = await client.workflow.getHandle(workflowId).fetchHistory();
            const failed = history.events?.findIndex((e) => e.activityTaskFailedEventAttributes);
            if (
              failed !== undefined &&
              failed >= 0 &&
              history.events?.slice(failed + 1).some((e) => e.workflowTaskCompletedEventAttributes)
            ) {
              if (closeFails)
                throw ApplicationFailure.nonRetryable(
                  "synthetic_tree_close_failed",
                  "WorkConflict",
                );
              return;
            }
            await delay(20);
          }
          throw ApplicationFailure.nonRetryable("deadline_race_fixture_timeout", "InvalidWork");
        },
      },
    });
    await worker.runUntil(async () => {
      const handle = await client.workflow.start(WORKFLOW_TYPE, {
        workflowId,
        taskQueue,
        args: [{ taskId: randomUUID(), runId, attemptId: randomUUID().replaceAll("-", "") }],
        workflowExecutionTimeout: "20 seconds",
      });
      if (closeFails) {
        await assert.rejects(handle.result(), (error: unknown) => {
          const failure = error as { cause?: { cause?: { message?: string } } };
          assert.equal(failure.cause?.cause?.message, "synthetic_tree_close_failed");
          return true;
        });
      } else await handle.result();
      const history = await handle.fetchHistory();
      assert.ok(history.events?.some((e) => e.timerFiredEventAttributes));
      assert.equal(advances, 1);
      assert.equal(closes, 1);
      await Worker.runReplayHistory({ workflowBundle }, history);
    });
  }
  console.log(
    "PASS real SDK tree-close acknowledgement race completes after successful closure, propagates failed closure and replays both histories; callbacks synthetic",
  );
}
