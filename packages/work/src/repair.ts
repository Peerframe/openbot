import { Context } from "@temporalio/activity";
import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  defaultPayloadConverter,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/common";
import {
  type EngineSettings,
  REPAIR_ID_PREFIX,
  REPAIR_TYPE,
  type RepairStart,
  repairStart,
  WorkConflict,
} from "./contracts.js";
export async function inspectRepairStart(
  client: Client,
  settings: EngineSettings,
  input: RepairStart,
  runId?: string,
) {
  repairStart(input);
  if (client.options.namespace !== settings.namespace)
    throw new WorkConflict("repair_namespace_changed");
  const response = await client.withDeadline(Date.now() + 3000, () =>
    client.workflowService.getWorkflowExecutionHistory({
      namespace: settings.namespace,
      execution: { workflowId: REPAIR_ID_PREFIX + input.commandId, ...(runId ? { runId } : {}) },
      maximumPageSize: 1,
      waitNewEvent: false,
      skipArchival: true,
    }),
  );
  if (
    Buffer.byteLength(JSON.stringify(response)) > 65536 ||
    response.archived ||
    response.rawHistory?.length
  )
    throw new WorkConflict("repair_history_limit");
  const event = response.history?.events?.[0],
    start = event?.workflowExecutionStartedEventAttributes,
    payload = start?.input?.payloads?.[0];
  if (
    event?.eventId?.toString() !== "1" ||
    event.eventType !== 1 ||
    !start ||
    start.workflowType?.name !== REPAIR_TYPE ||
    start.taskQueue?.name !== settings.taskQueue ||
    start.workflowId !== REPAIR_ID_PREFIX + input.commandId ||
    start.continuedExecutionRunId ||
    !start.firstExecutionRunId ||
    start.firstExecutionRunId !== start.originalExecutionRunId ||
    (runId && runId !== start.firstExecutionRunId) ||
    start.input?.payloads?.length !== 1 ||
    !payload ||
    (payload.data?.length ?? 0) > 2048
  )
    throw new WorkConflict("repair_start_changed");
  const original = repairStart(defaultPayloadConverter.fromPayload(payload));
  if (
    Object.keys(original).some(
      (key) => original[key as keyof RepairStart] !== input[key as keyof RepairStart],
    )
  )
    throw new WorkConflict("repair_input_changed");
  return start.firstExecutionRunId;
}
/** Repair workflow creation is idempotent by the already persisted Owner command ID. */
export async function dispatchRepair(client: Client, settings: EngineSettings, input: RepairStart) {
  repairStart(input);
  try {
    await client.withDeadline(Date.now() + 3000, () =>
      client.workflow.start(REPAIR_TYPE, {
        workflowId: REPAIR_ID_PREFIX + input.commandId,
        args: [input],
        taskQueue: settings.taskQueue,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        workflowExecutionTimeout: 180000,
        retry: { maximumAttempts: 1 },
      }),
    );
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  const first = await inspectRepairStart(client, settings, input);
  const description = await client.withDeadline(Date.now() + 3000, () =>
    client.workflow.getHandle(REPAIR_ID_PREFIX + input.commandId).describe(),
  );
  if (
    description.runId !== first ||
    description.type !== REPAIR_TYPE ||
    description.taskQueue !== settings.taskQueue ||
    description.raw.workflowExecutionInfo?.firstRunId !== first
  )
    throw new WorkConflict("repair_engine_changed");
  return {
    workflowId: REPAIR_ID_PREFIX + input.commandId,
    closed: ["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(
      description.status.name,
    ),
  };
}
/** This check can only run inside the actual remote repair Activity; it grants lookup only. */
export async function currentRepairBinding(
  client: Client,
  settings: EngineSettings,
  input: RepairStart,
) {
  const info = Context.current().info;
  if (
    !info.workflowExecution ||
    info.isLocal ||
    info.namespace !== settings.namespace ||
    info.taskQueue !== settings.taskQueue ||
    info.workflowType !== REPAIR_TYPE ||
    info.workflowExecution.workflowId !== REPAIR_ID_PREFIX + input.commandId
  )
    throw new WorkConflict("repair_activity_changed");
  await inspectRepairStart(client, settings, input, info.workflowExecution.runId);
  return info.workflowExecution.workflowId;
}
