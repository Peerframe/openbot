import {
  boundedText,
  EngineAlreadyStarted,
  engineReference,
  validAttempt,
  workIdentity,
  WORKFLOW_ID_PREFIX,
  WORKFLOW_TYPE,
  WorkConflict,
  type EnginePort,
  type EngineSettings,
  type HandoffPort,
  type WorkIdentity,
} from "./contracts.js";

export type DispatchResult = {
  acknowledged: boolean;
  startRequested: boolean;
  reason:
    | "acknowledged"
    | "already_acknowledged"
    | "unconfirmed_missing_history"
    | "unconfirmed_attempt_unbound"
    | "unconfirmed_start_event_mismatch";
};

/** One reservation permits one high-level start. Redelivery only inspects immutable history. */
export async function dispatchOne(
  identity: WorkIdentity,
  settings: EngineSettings,
  handoff: HandoffPort,
  engine: EnginePort,
): Promise<DispatchResult> {
  workIdentity(identity);
  boundedText(settings.namespace, 64);
  boundedText(settings.taskQueue, 256);
  if (
    !Number.isInteger(settings.executionTimeoutMs) ||
    settings.executionTimeoutMs < 1000 ||
    settings.executionTimeoutMs > 86_400_000
  )
    throw new WorkConflict("invalid_execution_timeout");
  if (engine.namespace !== settings.namespace) throw new WorkConflict("engine_namespace_mismatch");
  const workflowId = WORKFLOW_ID_PREFIX + identity.runId;
  const reference = engineReference(settings.namespace, identity.runId);
  const prior = await handoff.unconfirmed(identity);
  if (prior && prior.engineReference !== reference)
    throw new WorkConflict("handoff_reference_changed");
  const reservation = prior
    ? { shouldStart: false, attemptId: prior.attemptId }
    : await handoff.reserve(identity, reference);
  const attempt = reservation.attemptId;
  if (!validAttempt(attempt))
    return { acknowledged: false, startRequested: false, reason: "unconfirmed_attempt_unbound" };
  const input = { ...workIdentity(identity), attemptId: attempt };
  if (reservation.shouldStart) {
    try {
      await engine.start(workflowId, input, settings);
    } catch (error) {
      if (!(error instanceof EngineAlreadyStarted)) throw error;
    }
  }
  const startRequested = reservation.shouldStart;
  const event = await engine.inspectStart(workflowId);
  if (!event) return { acknowledged: false, startRequested, reason: "unconfirmed_missing_history" };
  if (
    event.workflowType !== WORKFLOW_TYPE ||
    event.taskQueue !== settings.taskQueue ||
    event.input.taskId !== input.taskId ||
    event.input.runId !== input.runId ||
    event.input.attemptId !== attempt ||
    !event.firstRunId ||
    event.firstRunId.length > 128
  ) {
    return { acknowledged: false, startRequested, reason: "unconfirmed_start_event_mismatch" };
  }
  const recorded = await handoff.acknowledge(identity, reference, attempt, event.firstRunId);
  return {
    acknowledged: true,
    startRequested,
    reason: recorded ? "acknowledged" : "already_acknowledged",
  };
}
