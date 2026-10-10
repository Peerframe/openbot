/** Reads immutable command records and verifies their correlation with original Work actions. */
import { type CommandPreparationBinding, commandPreparationBindingSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import { actionCommand, actionCommandOperation } from "./work-command-actions.js";
import {
  type CommandOperation,
  commandExecutionBinding,
  commandFingerprint,
  commandTimeUpper,
  parseCommandClaims,
  type TimingPolicy,
} from "./work-command-contract.js";
import type { CommandVerifier } from "./work-command-crypto.js";
import { unverifiedCommandPayload } from "./work-command-crypto.js";
import { commandTokenDigest } from "./work-command-values.js";
import type { WorkDb } from "./work-handoff.js";
import type { WorkAction } from "./work-ledger.js";
import { type WorkJson, workCanonical } from "./work-values.js";
export type PreparationRow = {
  action_id: string;
  preparation_id: string;
  task_id: string;
  original_claim_id: string;
  binding: CommandPreparationBinding;
  operation: CommandOperation;
  engine_proof: WorkJson;
  input_scope: WorkJson;
  timing: TimingPolicy;
  server_instance_id: string;
  root_deadline_ms: string;
  original_expiry_ms: string;
  state: string;
  challenge_token: string | null;
  authorization_token: string | null;
  issued_at_ms: string | null;
  ready_token: string | null;
  readiness_digest: string | null;
  received_at_ms: string | null;
  native_deadline_ms: string | null;
};
export type DispatchRow = {
  action_id: string;
  dispatch_id: string;
  task_id: string;
  original_claim_id: string;
  original_epoch: string;
  authority_generation: string;
  connection_id: string;
  intent_digest: string;
  operation_fingerprint: string;
  operation: CommandOperation;
  dispatch_claims: WorkJson;
  ticket_digest: string;
  engine_proof: WorkJson;
  input_scope: WorkJson;
  state: string;
  issued_at_ms: string;
  expires_at_ms: string;
  root_deadline_ms: string;
  native_deadline_ms: string;
  hard_deadline_ms: string;
  consume_request_digest: string | null;
  consume_nonce: string | null;
  consumed_at_ms: string | null;
  permit_claims: WorkJson | null;
  preparation_id: string;
  readiness_digest: string;
};
export const sameCommandValue = (a: unknown, b: unknown) =>
  workCanonical(a).wire === workCanonical(b).wire;
export async function commandNow(db: WorkDb) {
  const [row] = await db`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now`;
  const now = Number(row?.now);
  if (!Number.isSafeInteger(now) || now <= 0) throw new WorkConflict("command_clock_changed");
  return now;
}
export async function loadCommandPreparation(db: WorkDb, action: WorkAction) {
  const [row] = await db<
    PreparationRow[]
  >`SELECT * FROM work_command_preparations WHERE action_id=${action.id} FOR UPDATE`;
  if (!row) throw new WorkConflict("command_preparation_required");
  const binding = commandPreparationBindingSchema.parse(row.binding),
    operation = await actionCommandOperation(action, binding.originalEpoch, row.operation.route);
  if (
    binding.taskId !== action.task_id ||
    binding.runId !== action.run_id ||
    binding.actionId !== action.id ||
    binding.preparationId !== row.preparation_id ||
    row.task_id !== action.task_id ||
    binding.intentDigest !== action.intent_digest ||
    binding.authorityGeneration !== Number(action.authority_generation) ||
    !sameCommandValue(operation, row.operation) ||
    (await commandFingerprint(operation)) !== binding.operationFingerprint ||
    Object.entries(operation.route).some(([k, v]) => Reflect.get(binding, k) !== v) ||
    binding.profileDigest !== operation.profileDigest
  )
    throw new WorkConflict("command_preparation_changed");
  return { row, binding, operation };
}
export async function validateCommandDispatch(row: DispatchRow, action: WorkAction) {
  const claims = await parseCommandClaims("work_command_dispatch", row.dispatch_claims),
    intent = await actionCommand(action.intent),
    operation = await actionCommandOperation(
      action,
      Number(row.original_epoch),
      row.operation.route,
    ),
    anchors = claims.anchors;
  if (
    row.task_id !== action.task_id ||
    row.action_id !== action.id ||
    !sameCommandValue(row.operation, operation) ||
    row.intent_digest !== action.intent_digest ||
    operation.intentDigest !== action.intent_digest ||
    (await commandFingerprint(operation)) !== row.operation_fingerprint ||
    claims.operationFingerprint !== row.operation_fingerprint ||
    claims.taskId !== action.task_id ||
    claims.runId !== action.run_id ||
    claims.actionId !== action.id ||
    claims.dispatchId !== row.dispatch_id ||
    claims.connectionId !== row.connection_id ||
    claims.originalEpoch !== Number(row.original_epoch) ||
    claims.authorityGeneration !== Number(row.authority_generation) ||
    claims.authorityGeneration !== Number(action.authority_generation) ||
    claims.intentDigest !== action.intent_digest ||
    claims.profileDigest !== intent.profileDigest ||
    claims.exp * 1000 !== Number(row.expires_at_ms) ||
    anchors.admittedAtMs !== Number(row.issued_at_ms) ||
    anchors.rootDeadlineMs !== Number(row.root_deadline_ms) ||
    anchors.nativeDeadlineMs !== Number(row.native_deadline_ms) ||
    anchors.hardDeadlineMs !== Number(row.hard_deadline_ms) ||
    Object.entries(operation.route).some(([k, v]) => Reflect.get(claims, k) !== v) ||
    anchors.wallSeconds !== intent.command.limits.wallSeconds ||
    claims.preparationId !== row.preparation_id ||
    claims.readinessDigest !== row.readiness_digest
  )
    throw new WorkConflict("command_dispatch_changed");
  return claims;
}
export class CommandRecords {
  constructor(
    readonly verifier: CommandVerifier,
    readonly controlIssuer: string,
    readonly enforcementIssuer: string,
    readonly timing: TimingPolicy,
  ) {}
  async ready(row: PreparationRow, binding: CommandPreparationBinding, readyToken: string) {
    if (!row.challenge_token || !row.authorization_token)
      throw new WorkConflict("command_preparation_required");
    const payload = unverifiedCommandPayload(row.challenge_token),
      request = { requestId: String(payload.requestId), nonce: String(payload.nonce) };
    const challenge = await this.verifier.verify(row.challenge_token, {
      purpose: "work_command_prepare_challenge",
      issuer: this.enforcementIssuer,
      audience: this.controlIssuer,
      binding,
      request,
    });
    const grant = await this.verifier.verify(row.authorization_token, {
      purpose: "work_command_prepare_authorize",
      issuer: this.controlIssuer,
      audience: this.enforcementIssuer,
      binding,
      request,
    });
    const { argv: _argv, ...staging } = row.operation.command;
    if (
      grant.challengeDigest !== commandTokenDigest(row.challenge_token) ||
      grant.issuedAtMs !== Number(row.issued_at_ms) ||
      grant.rootDeadlineMs !== Number(row.root_deadline_ms) ||
      !sameCommandValue(grant.timing, row.timing) ||
      !sameCommandValue(grant.timing, this.timing) ||
      !sameCommandValue(grant.staging, staging)
    )
      throw new WorkConflict("command_preparation_changed");
    const ready = await this.verifier.verify(readyToken, {
      purpose: "work_command_ready",
      issuer: this.enforcementIssuer,
      audience: this.controlIssuer,
      binding,
      request,
    });
    const proof = ready.proof,
      activeBoot = proof.activeMonotonicUs + proof.observedBoottimeUs - proof.observedMonotonicUs;
    if (
      ready.authorizationDigest !== commandTokenDigest(row.authorization_token) ||
      ready.inputDigest !== grant.staging.inputDigest ||
      proof.bootId !== challenge.bootId ||
      proof.enforcerInstanceId !== challenge.enforcerInstanceId ||
      proof.runtimeMaxUs !== grant.timing.runtimeMaxMs * 1000 ||
      proof.timingPolicyDigest !== grant.timing.policyDigest ||
      !(challenge.createdBoottimeUs <= activeBoot && activeBoot < challenge.expiresBoottimeUs)
    )
      throw new WorkConflict("command_readiness_changed");
    if (row.ready_token !== null) {
      const received = Number(row.received_at_ms),
        deadline =
          received +
          commandTimeUpper(grant.timing, grant.timing.runtimeMaxMs) +
          grant.timing.stopAllowanceMs;
      if (
        Number(row.native_deadline_ms) !== deadline ||
        row.readiness_digest !== commandTokenDigest(row.ready_token) ||
        !(
          grant.issuedAtMs <= received &&
          received <= grant.issuedAtMs + grant.timing.prepareBudgetMs
        ) ||
        deadline > Math.min(Number(row.root_deadline_ms), Number(row.original_expiry_ms))
      )
        throw new WorkConflict("command_readiness_changed");
    }
    return { ready, grant };
  }
  async original(db: WorkDb, action: WorkAction) {
    const { row: preparation, binding: prepared } = await loadCommandPreparation(db, action);
    const [row] = await db<
      DispatchRow[]
    >`SELECT * FROM work_command_dispatches WHERE action_id=${action.id} FOR UPDATE`;
    if (!row) throw new WorkConflict("command_dispatch_required");
    const claims = await validateCommandDispatch(row, action);
    if (
      row.preparation_id !== prepared.preparationId ||
      row.readiness_digest !== preparation.readiness_digest ||
      row.native_deadline_ms !== preparation.native_deadline_ms ||
      !sameCommandValue(row.engine_proof, preparation.engine_proof) ||
      !sameCommandValue(row.input_scope, preparation.input_scope) ||
      row.original_claim_id !== preparation.original_claim_id
    )
      throw new WorkConflict("command_readiness_changed");
    await this.ready(preparation, prepared, preparation.ready_token!);
    const events =
      await db`SELECT payload FROM work_events WHERE task_id=${action.task_id} AND kind='command.permit_issued' AND payload->>'actionId'=${action.id} ORDER BY revision LIMIT 2`;
    let permitDigest: string | null = null;
    if (row.state === "consumed") {
      const value = events[0]?.payload;
      if (
        events.length !== 1 ||
        !value ||
        Object.keys(value).sort().join(",") !== "actionId,dispatchId,permitDigest,preparationId" ||
        value.actionId !== action.id ||
        value.dispatchId !== claims.dispatchId ||
        value.preparationId !== claims.preparationId ||
        typeof value.permitDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.permitDigest)
      )
        throw new WorkConflict("command_permit_record_changed");
      permitDigest = value.permitDigest;
      const permit = await parseCommandClaims("work_command_permit", row.permit_claims);
      if (
        !sameCommandValue(commandExecutionBinding(permit), commandExecutionBinding(claims)) ||
        permit.consumedAtMs !== Number(row.consumed_at_ms) ||
        permit.nonce !== row.consume_nonce ||
        permit.requestDigest !== row.consume_request_digest
      )
        throw new WorkConflict("command_permit_record_changed");
    } else if (events.length) throw new WorkConflict("command_permit_record_changed");
    return {
      row,
      preparation,
      claims,
      binding: commandExecutionBinding(claims),
      operation: row.operation,
      permitDigest,
    };
  }
}
