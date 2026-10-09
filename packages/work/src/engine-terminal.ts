import { createHash } from "node:crypto";
import type { Client } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import {
  type EngineSettings,
  WORKFLOW_ID_PREFIX,
  WORKFLOW_TYPE,
  WorkConflict,
  type WorkStart,
  workStart,
} from "./contracts.js";

export type EngineClosure = {
  namespace: string;
  taskQueue: string;
  workflowId: string;
  engineRunId: string;
  firstRunId: string;
  input: WorkStart;
  state: "COMPLETED" | "FAILED" | "CANCELLED" | "TERMINATED" | "TIMED_OUT";
  closeEventId: string;
  closeEventTime: string;
  closeEventSha256: string;
};
const observed = new WeakSet<object>();
export function assertEngineClosure(value: EngineClosure) {
  if (!observed.has(value)) throw new WorkConflict("engine_closure_proof_required");
}
function bounded(value: unknown) {
  const wire = JSON.stringify(value);
  if (Buffer.byteLength(wire) > 65536) throw new WorkConflict("terminal_history_limit");
  return wire;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const states = {
  2: ["COMPLETED", "workflowExecutionCompletedEventAttributes", 2],
  3: ["FAILED", "workflowExecutionFailedEventAttributes", 3],
  4: ["CANCELLED", "workflowExecutionCanceledEventAttributes", 21],
  5: ["TERMINATED", "workflowExecutionTerminatedEventAttributes", 27],
  7: ["TIMED_OUT", "workflowExecutionTimedOutEventAttributes", 4],
} as const;
/** Follows immutable Continue-As-New links from the accepted first Run. Latest is only a veto.
 * No visibility row, lost connection or missing history can prove a terminal result. */
export function observeEngineClosure(
  client: Client,
  settings: EngineSettings,
  input: WorkStart,
  firstRunId: string,
  signal?: AbortSignal,
): Promise<EngineClosure | null> {
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  return client.withAbortSignal(boundedSignal, () => observe(client, settings, input, firstRunId));
}
async function observe(
  client: Client,
  settings: EngineSettings,
  input: WorkStart,
  firstRunId: string,
): Promise<EngineClosure | null> {
  workStart(input);
  if (client.options.namespace !== settings.namespace)
    throw new WorkConflict("engine_namespace_mismatch");
  const workflowId = WORKFLOW_ID_PREFIX + input.runId;
  const service = client.workflowService;
  const describe = async (runId?: string) => {
    const response = await client.withDeadline(Date.now() + 3000, () =>
      service.describeWorkflowExecution({
        namespace: settings.namespace,
        execution: { workflowId, ...(runId ? { runId } : {}) },
      }),
    );
    bounded(response);
    const info = response.workflowExecutionInfo;
    if (!info) throw new WorkConflict("terminal_description_missing");
    return info;
  };
  const latest = await describe();
  if (latest.status === 1) return null;
  const history = async (runId: string, close: boolean) => {
    const response = await client.withDeadline(Date.now() + 3000, () =>
      service.getWorkflowExecutionHistory({
        namespace: settings.namespace,
        execution: { workflowId, runId },
        maximumPageSize: 1,
        waitNewEvent: false,
        skipArchival: true,
        historyEventFilterType: close ? 2 : 1,
      }),
    );
    bounded(response);
    const events = response.history?.events;
    if (
      response.archived ||
      response.rawHistory?.length ||
      !events?.length ||
      events.length > 128 ||
      (close && (events.length !== 1 || response.nextPageToken?.length))
    )
      throw new WorkConflict("terminal_history_incomplete");
    return events[0]!;
  };
  let current = firstRunId,
    previous: string | undefined;
  const seen = new Set<string>();
  for (let count = 0; count < 128; count++) {
    if (!current || current.length > 128 || seen.has(current))
      throw new WorkConflict("terminal_chain_invalid");
    seen.add(current);
    const info = await describe(current);
    if (info.status === 1) return null;
    if (
      info.execution?.workflowId !== workflowId ||
      info.execution.runId !== current ||
      info.firstRunId !== firstRunId ||
      info.type?.name !== WORKFLOW_TYPE ||
      info.taskQueue !== settings.taskQueue ||
      !info.closeTime ||
      Number(info.historyLength?.toString()) < 2
    )
      throw new WorkConflict("terminal_description_changed");
    const started = await history(current, false),
      start = started.workflowExecutionStartedEventAttributes;
    const payload = start?.input?.payloads?.[0];
    if (
      started.eventId?.toString() !== "1" ||
      started.eventType !== 1 ||
      !start ||
      start.workflowId !== workflowId ||
      start.firstExecutionRunId !== firstRunId ||
      (start.continuedExecutionRunId || undefined) !== previous ||
      start.workflowType?.name !== WORKFLOW_TYPE ||
      start.taskQueue?.name !== settings.taskQueue ||
      start.cronSchedule ||
      (start.attempt ?? 1) !== 1 ||
      (start.retryPolicy && start.retryPolicy.maximumAttempts !== 1) ||
      start.input?.payloads?.length !== 1 ||
      !payload ||
      (payload.data?.length ?? 0) > 2048
    )
      throw new WorkConflict("terminal_chain_unproven");
    const actual = workStart(defaultPayloadConverter.fromPayload(payload));
    if (
      actual.taskId !== input.taskId ||
      actual.runId !== input.runId ||
      actual.attemptId !== input.attemptId
    )
      throw new WorkConflict("terminal_start_changed");
    const closed = await history(current, true);
    if (
      closed.eventId?.toString() !== info.historyLength?.toString() ||
      !closed.eventTime ||
      canonical(JSON.parse(bounded(closed.eventTime))) !==
        canonical(JSON.parse(bounded(info.closeTime)))
    )
      throw new WorkConflict("terminal_close_changed");
    if (info.status === 6) {
      const continuation = closed.workflowExecutionContinuedAsNewEventAttributes;
      if (closed.eventType !== 28 || !continuation?.newExecutionRunId)
        throw new WorkConflict("terminal_chain_unproven");
      previous = current;
      current = continuation.newExecutionRunId;
      continue;
    }
    const state = states[info.status as keyof typeof states];
    if (
      !state ||
      closed.eventType !== state[2] ||
      !closed[state[1]] ||
      closed.workflowExecutionFailedEventAttributes?.newExecutionRunId ||
      closed.workflowExecutionTimedOutEventAttributes?.newExecutionRunId
    )
      throw new WorkConflict("terminal_close_invalid");
    const check = await describe();
    if (
      current !== latest.execution?.runId ||
      canonical(JSON.parse(bounded(info))) !== canonical(JSON.parse(bounded(check)))
    )
      throw new WorkConflict("terminal_latest_changed");
    const proof: EngineClosure = Object.freeze({
      namespace: settings.namespace,
      taskQueue: settings.taskQueue,
      workflowId,
      engineRunId: current,
      firstRunId,
      input: Object.freeze({ ...input }),
      state: state[0],
      closeEventId: closed.eventId!.toString(),
      closeEventTime: canonical(JSON.parse(bounded(closed.eventTime))),
      closeEventSha256: createHash("sha256")
        .update(canonical(JSON.parse(bounded(closed))))
        .digest("hex"),
    });
    observed.add(proof);
    return proof;
  }
  throw new WorkConflict("terminal_chain_limit");
}
