import { Context } from "@temporalio/activity";
import {
  type EnginePort,
  type EngineSettings,
  WORKFLOW_ID_PREFIX,
  WORKFLOW_TYPE,
  WorkConflict,
  type WorkStart,
  workStart,
} from "./contracts.js";

export type ActivityBinding = {
  input: WorkStart;
  namespace: string;
  taskQueue: string;
  workflowId: string;
  engineRunId: string;
  firstRunId: string;
  activityId: string;
  activityAttempt: number;
};
/** Trusted SDK context plus exact Run history. This is identity evidence, never effect authority. */
export async function currentBinding(
  engine: EnginePort,
  settings: EngineSettings,
  input: WorkStart,
): Promise<ActivityBinding> {
  const info = Context.current().info;
  workStart(input);
  if (
    info.isLocal ||
    !info.workflowExecution ||
    info.namespace !== settings.namespace ||
    info.taskQueue !== settings.taskQueue ||
    info.workflowType !== WORKFLOW_TYPE ||
    info.workflowExecution.workflowId !== WORKFLOW_ID_PREFIX + input.runId ||
    engine.namespace !== settings.namespace
  )
    throw new WorkConflict("engine_activity_mismatch");
  const event = await engine.inspectStart(
    info.workflowExecution.workflowId,
    info.workflowExecution.runId,
  );
  if (
    !event ||
    event.workflowType !== WORKFLOW_TYPE ||
    event.taskQueue !== settings.taskQueue ||
    event.input.taskId !== input.taskId ||
    event.input.runId !== input.runId ||
    event.input.attemptId !== input.attemptId
  ) {
    throw new WorkConflict("engine_start_mismatch");
  }
  return {
    input,
    namespace: info.namespace,
    taskQueue: info.taskQueue,
    workflowId: info.workflowExecution.workflowId,
    engineRunId: info.workflowExecution.runId,
    firstRunId: event.firstRunId,
    activityId: info.activityId,
    activityAttempt: info.attempt,
  };
}
