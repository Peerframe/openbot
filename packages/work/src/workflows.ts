import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import { type RepairStart, repairStart, type WorkStart, workStart } from "./contracts.js";

export type WorkStep = { state: "continue" | "waiting" | "completed" | "cancelled" | "failed" };
export type WorkActivities = {
  awaitWorkAdmission(input: WorkStart): Promise<void>;
  advanceWork(input: WorkStart): Promise<WorkStep>;
  inspectWorkTree(input: WorkStart): Promise<{ watch: boolean; deadline: number | null }>;
  closeWorkTree(input: WorkStart): Promise<void>;
};
const admission = proxyActivities<Pick<WorkActivities, "awaitWorkAdmission">>({
  startToCloseTimeout: "15 seconds",
  scheduleToCloseTimeout: "3 minutes",
  retry: {
    maximumAttempts: 60,
    initialInterval: "1 second",
    maximumInterval: "10 seconds",
    nonRetryableErrorTypes: ["WorkConflict", "InvalidWork"],
  },
});
export const workChanged = defineSignal("workChanged");
const activities = proxyActivities<WorkActivities>({
  startToCloseTimeout: "75 seconds",
  heartbeatTimeout: "10 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  scheduleToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["WorkConflict", "InvalidWork"] },
});

/** Replay contains only durable control flow; control Activities own all model/tool/SQL effects. */
export async function OpenBotWorkTsV1(input: WorkStart): Promise<void> {
  try {
    workStart(input);
  } catch {
    throw ApplicationFailure.nonRetryable("invalid_work_start", "InvalidWork");
  }
  await admission.awaitWorkAdmission(input);
  let changed = false;
  setHandler(workChanged, () => {
    changed = true;
  });
  const tree = proxyActivities<Pick<WorkActivities, "inspectWorkTree" | "closeWorkTree">>({
    startToCloseTimeout: "15 seconds",
    scheduleToCloseTimeout: "60 seconds",
    retry: { maximumAttempts: 5, nonRetryableErrorTypes: ["WorkConflict", "InvalidWork"] },
  });
  const initial = await tree.inspectWorkTree(input);
  const body = new CancellationScope(),
    alarm = new CancellationScope();
  let expired = false,
    completed = false;
  const monitor = initial.watch
    ? alarm.run(async () => {
        let state = initial;
        while (state.deadline === null) {
          await sleep("2 seconds");
          state = await tree.inspectWorkTree(input);
        }
        if (!Number.isSafeInteger(state.deadline))
          throw ApplicationFailure.nonRetryable("invalid_tree_deadline", "InvalidWork");
        await sleep(Math.max(0, state.deadline - Date.now()));
        // Close SQL authority before cancelling in-flight work; late observed truth can still settle.
        await tree.closeWorkTree(input);
        expired = true;
        body.cancel();
      })
    : undefined;
  // Handle monitor failure promptly instead of leaving a rejected detached promise.
  let alarmFailure: unknown;
  const monitored = monitor?.catch((error) => {
    if (!alarm.consideredCancelled) {
      alarmFailure = error;
      body.cancel();
    }
  });
  try {
    await body.run(async () => {
      for (let iteration = 0; iteration < 64; iteration++) {
        changed = false;
        const step = await activities.advanceWork(input);
        if (
          !step ||
          !["continue", "waiting", "completed", "cancelled", "failed"].includes(step.state)
        ) {
          throw ApplicationFailure.nonRetryable("invalid_control_step", "InvalidWork");
        }
        if (step.state === "completed" || step.state === "cancelled" || step.state === "failed") {
          completed = true;
          return;
        }
        // A signal only wakes the control reader; it cannot approve or authorize an effect.
        if (step.state === "waiting") await condition(() => changed, "30 seconds");
      }
    });
  } catch (error) {
    if (alarmFailure) throw alarmFailure;
    if (!expired) throw error;
  } finally {
    alarm.cancel();
    await monitored;
  }
  if (alarmFailure) throw alarmFailure;
  if (!expired && !completed) await continueAsNew<typeof OpenBotWorkTsV1>(input);
}

const repair = proxyActivities<{ repairClosedWork(input: RepairStart): Promise<void> }>({
  startToCloseTimeout: "30 seconds",
  scheduleToCloseTimeout: "120 seconds",
  retry: { maximumAttempts: 3, nonRetryableErrorTypes: ["WorkConflict", "InvalidWork"] },
});
export async function OpenBotClosedRepairTsV1(input: RepairStart): Promise<void> {
  repairStart(input);
  await repair.repairClosedWork(input);
}
