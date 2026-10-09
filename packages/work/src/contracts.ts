/** Correlation and continuation only. Control rechecks authority for every Activity effect. */
export const EXECUTION_OWNER = "typescript-v1";
export const WORKFLOW_TYPE = "OpenBotWorkTsV1";
export const WORKFLOW_ID_PREFIX = "openbot-work-ts-v1-";
export type WorkIdentity = { taskId: string; runId: string };
export type WorkStart = WorkIdentity & { attemptId: string };
export type EngineStart = {
  workflowType: string;
  taskQueue: string;
  firstRunId: string;
  input: WorkStart;
};
export type EngineSettings = { namespace: string; taskQueue: string; executionTimeoutMs: number };
export type Reservation = { shouldStart: boolean; attemptId: string | null };
export type PriorSubmission = { engineReference: string; attemptId: string | null };
export interface HandoffPort {
  unconfirmed(identity: WorkIdentity): Promise<PriorSubmission | null>;
  reserve(identity: WorkIdentity, reference: string): Promise<Reservation>;
  acknowledge(
    identity: WorkIdentity,
    reference: string,
    attemptId: string,
    firstRunId: string,
  ): Promise<boolean>;
}
export interface EnginePort {
  readonly namespace: string;
  start(workflowId: string, input: WorkStart, settings: EngineSettings): Promise<void>;
  inspectStart(workflowId: string, engineRunId?: string): Promise<EngineStart | null>;
}
export class EngineAlreadyStarted extends Error {}
export class WorkConflict extends Error {
  override readonly name = "WorkConflict";
}
export class HandoffPending extends Error {
  override readonly name = "HandoffPending";
}
export function boundedText(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > limit
  )
    throw new WorkConflict("invalid_work_identity");
  return value;
}
export function workIdentity(value: WorkIdentity): WorkIdentity {
  return { taskId: boundedText(value.taskId, 128), runId: boundedText(value.runId, 128) };
}
export function validAttempt(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
export function workStart(value: unknown): WorkStart {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "attemptId,runId,taskId"
  )
    throw new WorkConflict("invalid_work_start");
  const input = value as WorkStart;
  if (!validAttempt(input.attemptId)) throw new WorkConflict("invalid_work_start");
  return { ...workIdentity(input), attemptId: input.attemptId };
}
export function engineReference(namespace: string, runId: string): string {
  boundedText(namespace, 64);
  boundedText(runId, 128);
  return `temporal:${namespace}:${WORKFLOW_ID_PREFIX}${runId}`;
}

export const REPAIR_TYPE = "OpenBotClosedRepairTsV1";
export const REPAIR_ID_PREFIX = "openbot-closed-repair-ts-v1-";
export type RepairStart = WorkIdentity & { actionId: string; commandId: string };
export function repairStart(value: unknown): RepairStart {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "actionId,commandId,runId,taskId"
  )
    throw new WorkConflict("invalid_repair_start");
  const input = value as RepairStart;
  return {
    ...workIdentity(input),
    actionId: boundedText(input.actionId, 128),
    commandId: boundedText(input.commandId, 128),
  };
}
