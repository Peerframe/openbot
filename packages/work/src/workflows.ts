import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { workStart, type WorkStart } from "./contracts.js";

export type WorkStep = { state: "continue" | "waiting" | "completed" | "cancelled" | "failed" };
export type WorkActivities = {
  awaitWorkAdmission(input: WorkStart): Promise<void>;
  advanceWork(input: WorkStart): Promise<WorkStep>;
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
  for (let iteration = 0; iteration < 64; iteration++) {
    changed = false;
    const step = await activities.advanceWork(input);
    if (
      !step ||
      !["continue", "waiting", "completed", "cancelled", "failed"].includes(step.state)
    ) {
      throw ApplicationFailure.nonRetryable("invalid_control_step", "InvalidWork");
    }
    if (step.state === "completed" || step.state === "cancelled" || step.state === "failed") return;
    // A signal only wakes the control reader; it cannot approve or authorize an effect.
    if (step.state === "waiting") await condition(() => changed, "30 seconds");
  }
  await continueAsNew<typeof OpenBotWorkTsV1>(input);
}
