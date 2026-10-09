import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  defaultPayloadConverter,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/common";
import {
  EngineAlreadyStarted,
  type EnginePort,
  type EngineSettings,
  type EngineStart,
  WORKFLOW_TYPE,
  type WorkStart,
  workStart,
} from "./contracts.js";

/** The trusted composition owns credentials; workflows and model input never select a destination. */
export class TemporalEngine implements EnginePort {
  readonly namespace: string;
  constructor(readonly client: Client) {
    this.namespace = client.options.namespace;
  }
  async start(workflowId: string, input: WorkStart, settings: EngineSettings): Promise<void> {
    try {
      await this.client.withDeadline(Date.now() + 5000, () =>
        this.client.workflow.start(WORKFLOW_TYPE, {
          workflowId,
          args: [workStart(input)],
          taskQueue: settings.taskQueue,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
          workflowExecutionTimeout: settings.executionTimeoutMs,
          retry: { maximumAttempts: 1 },
        }),
      );
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) throw new EngineAlreadyStarted();
      throw error;
    }
  }
  async inspectStart(workflowId: string, engineRunId?: string): Promise<EngineStart | null> {
    try {
      // Only the first immutable event is needed. Do not download unbounded workflow history.
      const response = await this.client.withDeadline(Date.now() + 5000, () =>
        this.client.workflowService.getWorkflowExecutionHistory({
          namespace: this.namespace,
          execution: { workflowId, ...(engineRunId ? { runId: engineRunId } : {}) },
          maximumPageSize: 1,
          waitNewEvent: false,
          skipArchival: true,
        }),
      );
      const event = response.history?.events?.[0];
      const start = event?.workflowExecutionStartedEventAttributes;
      const payload = start?.input?.payloads?.[0];
      if (
        event?.eventId?.toString() !== "1" ||
        !start ||
        !payload ||
        start.input?.payloads?.length !== 1 ||
        (payload.data?.length ?? 0) > 2048 ||
        !start.firstExecutionRunId ||
        !start.workflowType?.name ||
        !start.taskQueue?.name
      )
        return null;
      let input: WorkStart;
      try {
        input = workStart(defaultPayloadConverter.fromPayload(payload));
      } catch {
        return null;
      }
      return {
        workflowType: start.workflowType.name,
        taskQueue: start.taskQueue.name,
        firstRunId: start.firstExecutionRunId,
        input,
      };
    } catch (error) {
      if (
        error instanceof WorkflowNotFoundError ||
        (error instanceof Error && Reflect.get(error, "code") === 5)
      )
        return null;
      throw error;
    }
  }
}
export { Client, Connection, WorkflowNotFoundError };
