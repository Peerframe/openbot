import { randomUUID } from "node:crypto";
import { type CommandPreparationBinding, commandPreparationBindingSchema } from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import type { FileSession, OwnerFiles } from "./owner-files.js";
import type { RuntimeBinding } from "./runtime-port.js";
import { checkWorkApproval } from "./work-approval.js";
import { actionCommand, actionCommandOperation } from "./work-command-actions.js";
import { CommandPrepareClock } from "./work-command-clock.js";
import {
  checkCommandBudget,
  commandFingerprint,
  commandTimeUpper,
  parseCommandClaims,
  type TimingPolicy,
  timingPolicySchema,
  type WorkCommand,
} from "./work-command-contract.js";
import {
  type CommandSigner,
  type CommandVerifier,
  unverifiedCommandPayload,
} from "./work-command-crypto.js";
import {
  type CommandAttachment,
  freezeCommandInputs,
  revalidateCommandInputs,
} from "./work-command-inputs.js";
import type { WorkCommandProfile, WorkCommandProfiles } from "./work-command-profiles.js";
import {
  CommandRecords,
  commandNow,
  loadCommandPreparation,
  type PreparationRow,
  sameCommandValue,
} from "./work-command-records.js";
import { commandTokenDigest, commandValue } from "./work-command-values.js";
import { acceptedWork, checkWorkFence } from "./work-execution.js";
import { type WorkDb, type WorkTaskRow, type WorkTransactions, workEvent } from "./work-handoff.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import { rootWorkDeadline, workTree } from "./work-tree.js";
import { sha256, workCanonical } from "./work-values.js";
import type { CommandHandle, WorkerCommandChannel } from "./worker-command-channel.js";

const lookup = () => ({ status: "lookup_required" as const });
/** One preparation, one admission, one online consumption. Socket writes are deliberately absent:
 * the channel driver may deliver a token only after these transactions and identity guards commit. */
export class WorkCommandDispatches {
  readonly timing: TimingPolicy;
  readonly clock: CommandPrepareClock;
  readonly records: CommandRecords;
  private started = false;
  private startClaimed = false;
  // Retain the actual SDK-derived scope, never reconstruct effect authority from a persisted DTO.
  // Every use still checks current SQL approval, source, claim, epoch and original socket identity.
  private readonly scopes = new Map<string, { scope: WorkScope; preparationId: string }>();
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
    readonly profiles: WorkCommandProfiles,
    readonly transport: WorkerCommandChannel,
    readonly signer: CommandSigner,
    readonly verifier: CommandVerifier,
    readonly enforcementIssuer: string,
    timing: TimingPolicy,
    readonly attachments?: OwnerFiles,
  ) {
    this.timing = timingPolicySchema.parse(timing);
    this.clock = new CommandPrepareClock(Math.min(100, this.timing.clockQuantizationMs));
    if (signer.role !== "control" || signer.issuer === enforcementIssuer)
      throw new WorkConflict("command_composition_required");
    this.records = new CommandRecords(verifier, signer.issuer, enforcementIssuer, this.timing);
  }
  async start() {
    if (this.startClaimed) throw new WorkConflict("command_composition_required");
    this.startClaimed = true;
    await this.transactions.run(async (db) => {
      await db`UPDATE work_command_preparations SET state='closed',closed_at_ms=${await commandNow(db)},close_reason='restart' WHERE state IN ('reserved','authorized') AND server_instance_id<>${this.clock.instanceId}`;
    });
    this.started = true;
  }
  close() {
    this.started = false;
    for (const id of this.scopes.keys()) this.release(id);
  }
  release(id: string) {
    const original = this.scopes.get(id);
    if (original) this.clock.forget(original.preparationId);
    this.scopes.delete(id);
  }
  private available() {
    if (!this.started) throw new WorkConflict("command_preparation_unavailable");
  }
  private lock<T>(
    handle: CommandHandle,
    signal: AbortSignal,
    operation: (
      session: FileSession | undefined,
      live: Readonly<RuntimeBinding>,
      signal: AbortSignal,
    ) => Promise<T>,
  ) {
    this.available();
    const run = (session?: FileSession) =>
      this.transport.guard(handle, signal, (live, bounded) => operation(session, live, bounded));
    return this.attachments ? this.attachments.withLock(run, signal) : run();
  }
  private run<T>(
    handle: CommandHandle,
    signal: AbortSignal,
    operation: (
      db: WorkDb,
      session: FileSession | undefined,
      live: Readonly<RuntimeBinding>,
    ) => Promise<T>,
  ) {
    return this.lock(handle, signal, (session, live, bounded) =>
      this.transactions.run(async (db) => {
        bounded.throwIfAborted();
        const value = await operation(db, session, live);
        bounded.throwIfAborted();
        return value;
      }),
    );
  }
  private async action(db: WorkDb, scope: WorkScope, id: string, historical = false) {
    const task = historical
      ? await acceptedWork(db, scope.binding, true)
      : await currentWork(db, scope);
    const action = (await loadWorkActions(db, task.id)).find(
      (a) => a.id === id && a.run_id === scope.binding.input.runId,
    );
    if (!action || action.correction_context_id !== scope.contextId)
      throw new WorkConflict("command_context_changed");
    return { task, action };
  }
  private connection(
    live: Readonly<RuntimeBinding>,
    profile: WorkCommandProfile,
    expected?: string,
  ) {
    if (
      live.nodeId !== profile.route.nodeId ||
      live.credentialDigest !== profile.credentialDigest ||
      (expected !== undefined && live.connectionId !== expected)
    )
      throw new WorkConflict("command_connection_changed");
  }
  private proof(scope: WorkScope) {
    if (
      scope.fence.runId !== scope.binding.input.runId ||
      scope.fence.claimId !==
        sha256(
          JSON.stringify([
            scope.binding.engineRunId,
            scope.binding.activityId,
            scope.binding.activityAttempt,
          ]),
        )
    )
      throw new WorkConflict("command_context_changed");
    const proof = {
      version: 1,
      executionOwner: "typescript-v1",
      binding: scope.binding,
      correctionContextId: scope.contextId,
    };
    commandValue(proof);
    return JSON.parse(workCanonical(proof).wire);
  }
  private originalScope(id: string, row?: PreparationRow) {
    const scope = this.scopes.get(id)?.scope;
    if (
      !scope ||
      (row &&
        (row.original_claim_id !== scope.fence.claimId ||
          row.binding.originalEpoch !== scope.fence.epoch ||
          !sameCommandValue(row.engine_proof, this.proof(scope))))
    )
      throw new WorkConflict("command_original_activity_unavailable");
    return scope;
  }
  private async approved(
    db: WorkDb,
    scope: WorkScope,
    task: WorkTaskRow,
    action: WorkAction,
    statuses: readonly string[],
  ) {
    if (
      !statuses.includes(action.status) ||
      !action.requires_approval ||
      action.decision !== "approved" ||
      !action.unexpired ||
      Number(action.authority_generation) !== Number(task.authority_generation) ||
      action.correction_context_id !== scope.contextId ||
      Number(action.reserved_tokens) !== 0
    )
      throw new WorkConflict("command_approval_required");
    await checkWorkApproval(db, task.bot_id, action);
  }
  private async bounds(db: WorkDb, scope: WorkScope, task: WorkTaskRow, action: WorkAction) {
    const tree = workTree(task),
      root = Date.parse(
        await rootWorkDeadline(db, tree.rootTaskId, tree.rootWorkRunId ?? action.run_id),
      );
    const [expiry] =
      await db`SELECT floor(extract(epoch FROM least(a.expires_at,c.expires_at))*1000)::bigint AS expiry FROM work_actions a JOIN work_claims c ON c.run_id=a.run_id WHERE a.id=${action.id} AND c.claim_id=${scope.fence.claimId}`;
    const original = Number(expiry?.expiry);
    if (!Number.isSafeInteger(root) || !Number.isSafeInteger(original))
      throw new WorkConflict("command_deadline_expired");
    return { root, expiry: original };
  }
  private async clockClose(db: WorkDb) {
    if (this.clock.healthy()) return false;
    await db`UPDATE work_command_preparations SET state='closed',closed_at_ms=${await commandNow(db)},close_reason='clock_changed' WHERE state IN ('reserved','authorized') AND server_instance_id=${this.clock.instanceId}`;
    return true;
  }
  private async preparationAuthority(
    db: WorkDb,
    id: string,
    row: PreparationRow,
    binding: CommandPreparationBinding,
    session: FileSession | undefined,
    live: Readonly<RuntimeBinding>,
  ) {
    const scope = this.originalScope(id, row),
      { task, action } = await this.action(db, scope, id);
    await this.approved(db, scope, task, action, ["proposed"]);
    const { profile, sha256 } = await this.profiles.resolve(db, task);
    this.connection(live, profile, binding.connectionId);
    if (sha256 !== binding.profileDigest) throw new WorkConflict("command_profile_changed");
    const command = await this.profiles.checkCommand(profile, row.operation.command);
    await revalidateCommandInputs(db, scope, task, command, row.input_scope, session);
    return { scope, task, action, command, profile };
  }
  async reserve(
    scope: WorkScope,
    id: string,
    handle: CommandHandle,
    command: WorkCommand,
    attachments: CommandAttachment[],
    signal: AbortSignal,
  ) {
    const original: WorkScope = {
      ...scope,
      binding: structuredClone(scope.binding),
      fence: { ...scope.fence },
    };
    const result = await this.run(handle, signal, async (db, session, live) => {
      const { task, action } = await this.action(db, original, id);
      await this.approved(db, original, task, action, ["proposed"]);
      if ((await db`SELECT 1 FROM work_command_preparations WHERE action_id=${id}`).length)
        return lookup();
      if (await this.clockClose(db))
        return { status: "denied" as const, code: "unavailable" as const };
      const { profile, sha256 } = await this.profiles.resolve(db, task);
      this.connection(live, profile);
      const checked = await this.profiles.checkCommand(profile, command),
        intent = await actionCommand(action.intent);
      if (!sameCommandValue(intent.command, checked) || intent.profileDigest !== sha256)
        throw new WorkConflict("command_intent_changed");
      const operation = await actionCommandOperation(action, scope.fence.epoch, profile.route);
      const inputs = await freezeCommandInputs(db, original, task, checked, attachments, session),
        bounds = await this.bounds(db, original, task, action),
        now = await commandNow(db);
      checkCommandBudget(
        this.timing,
        now,
        Math.min(bounds.root, bounds.expiry),
        checked.limits.wallSeconds,
      );
      const binding = commandPreparationBindingSchema.parse({
        taskId: task.id,
        runId: action.run_id,
        actionId: id,
        preparationId: randomUUID(),
        connectionId: live.connectionId,
        originalEpoch: original.fence.epoch,
        authorityGeneration: Number(task.authority_generation),
        profileDigest: sha256,
        intentDigest: action.intent_digest,
        operationFingerprint: await commandFingerprint(operation),
        ...profile.route,
      });
      await db`INSERT INTO work_command_preparations(action_id,preparation_id,task_id,original_claim_id,binding,operation,engine_proof,input_scope,timing,server_instance_id,root_deadline_ms,original_expiry_ms) VALUES(${id},${binding.preparationId},${task.id},${original.fence.claimId},${db.json(binding)},${db.json(operation)},${db.json(this.proof(original))},${db.json(inputs)},${db.json(this.timing)},${this.clock.instanceId},${bounds.root},${bounds.expiry})`;
      await checkWorkFence(db, original.fence);
      return { status: "reserved" as const, binding };
    });
    if (result.status === "reserved")
      this.scopes.set(id, { scope: original, preparationId: result.binding.preparationId });
    return result;
  }
  async authorizePreparation(
    handle: CommandHandle,
    id: string,
    token: string,
    signal: AbortSignal,
  ) {
    const scope = this.originalScope(id);
    return this.run(handle, signal, async (db, session, live) => {
      const { action } = await this.action(db, scope, id),
        { row, binding } = await loadCommandPreparation(db, action);
      const authorized = await this.preparationAuthority(db, id, row, binding, session, live);
      if (await this.clockClose(db)) return { status: "denied" as const };
      if (row.state !== "reserved" || row.server_instance_id !== this.clock.instanceId)
        return lookup();
      const payload = unverifiedCommandPayload(token),
        challenge = await this.verifier.verify(token, {
          purpose: "work_command_prepare_challenge",
          issuer: this.enforcementIssuer,
          audience: this.signer.issuer,
          binding,
          request: { requestId: String(payload.requestId), nonce: String(payload.nonce) },
        });
      if (
        !sameCommandValue(row.timing, this.timing) ||
        challenge.expiresBoottimeUs - challenge.createdBoottimeUs !==
          this.timing.challengeBudgetMs * 1000
      )
        throw new WorkConflict("command_timing_changed");
      const now = await commandNow(db);
      checkCommandBudget(
        this.timing,
        now,
        Math.min(Number(row.root_deadline_ms), Number(row.original_expiry_ms)),
        authorized.command.limits.wallSeconds,
      );
      this.clock.begin(binding.preparationId, now);
      const { argv: _argv, ...staging } = authorized.command;
      const authorization = await this.signer.sign("work_command_prepare_authorize", {
        ...binding,
        version: 2,
        purpose: "work_command_prepare_authorize",
        iss: this.signer.issuer,
        aud: this.enforcementIssuer,
        jti: randomUUID(),
        requestId: challenge.requestId,
        nonce: challenge.nonce,
        challengeDigest: commandTokenDigest(token),
        issuedAtMs: now,
        rootDeadlineMs: Number(row.root_deadline_ms),
        timing: this.timing,
        staging,
      });
      await db`UPDATE work_command_preparations SET state='authorized',challenge_token=${token},authorization_token=${authorization},issued_at_ms=${now} WHERE action_id=${id}`;
      if (!this.clock.check(binding.preparationId, await commandNow(db), this.timing)) {
        await db`UPDATE work_command_preparations SET state='closed',closed_at_ms=${await commandNow(db)},close_reason='clock_changed' WHERE action_id=${id}`;
        return { status: "denied" as const };
      }
      await checkWorkFence(db, scope.fence);
      return { status: "authorized" as const, authorization };
    });
  }
  async acceptReady(handle: CommandHandle, id: string, token: string, signal: AbortSignal) {
    const scope = this.originalScope(id);
    return this.run(handle, signal, async (db, session, live) => {
      const { action } = await this.action(db, scope, id),
        { row, binding } = await loadCommandPreparation(db, action);
      await this.preparationAuthority(db, id, row, binding, session, live);
      if (row.state === "ready") {
        if (commandTokenDigest(token) !== row.readiness_digest)
          throw new WorkConflict("command_readiness_changed");
        await this.records.ready(row, binding, row.ready_token!);
        return {
          status: "ready" as const,
          preparationId: binding.preparationId,
          hardDeadlineMs: Number(row.native_deadline_ms),
          readinessDigest: row.readiness_digest!,
        };
      }
      if (row.state !== "authorized" || row.server_instance_id !== this.clock.instanceId)
        return lookup();
      const { grant } = await this.records.ready(row, binding, token),
        now = await commandNow(db);
      if (
        (await this.clockClose(db)) ||
        !this.clock.check(binding.preparationId, now, grant.timing)
      ) {
        await db`UPDATE work_command_preparations SET state='closed',closed_at_ms=${now},close_reason='expired' WHERE action_id=${id}`;
        return { status: "denied" as const };
      }
      const deadline =
        now +
        commandTimeUpper(grant.timing, grant.timing.runtimeMaxMs) +
        grant.timing.stopAllowanceMs;
      if (deadline > Math.min(Number(row.root_deadline_ms), Number(row.original_expiry_ms)))
        throw new WorkConflict("command_deadline_expired");
      const digest = commandTokenDigest(token);
      await db`UPDATE work_command_preparations SET state='ready',ready_token=${token},readiness_digest=${digest},received_at_ms=${now},native_deadline_ms=${deadline} WHERE action_id=${id}`;
      await checkWorkFence(db, scope.fence);
      return {
        status: "ready" as const,
        preparationId: binding.preparationId,
        hardDeadlineMs: deadline,
        readinessDigest: digest,
      };
    });
  }
  async admit(handle: CommandHandle, id: string, preparationId: string, signal: AbortSignal) {
    const scope = this.originalScope(id);
    let result:
      | {
          status: "issued";
          ticket: string;
          operation: ReturnType<typeof actionCommandOperation> extends Promise<infer T> ? T : never;
        }
      | undefined;
    const fresh = await this.lock(handle, signal, (session, live, bounded) =>
      this.ledger.admit(scope, id, async (db, action) => {
        bounded.throwIfAborted();
        const task = await currentWork(db, scope);
        await this.approved(db, scope, task, action, ["proposed"]);
        const { row, binding: prepared, operation } = await loadCommandPreparation(db, action);
        this.originalScope(id, row);
        if (
          row.state !== "ready" ||
          prepared.preparationId !== preparationId ||
          prepared.originalEpoch !== scope.fence.epoch
        )
          throw new WorkConflict("command_preparation_required");
        await this.records.ready(row, prepared, row.ready_token!);
        const { profile, sha256 } = await this.profiles.resolve(db, task);
        this.connection(live, profile, prepared.connectionId);
        const checked = await this.profiles.checkCommand(profile, operation.command);
        if (sha256 !== prepared.profileDigest) throw new WorkConflict("command_profile_changed");
        await revalidateCommandInputs(db, scope, task, checked, row.input_scope, session);
        const bounds = await this.bounds(db, scope, task, action),
          now = await commandNow(db),
          deadline = Number(row.native_deadline_ms);
        if (
          !this.clock.check(preparationId, now, this.timing, false) ||
          bounds.root !== Number(row.root_deadline_ms) ||
          deadline > Number(row.original_expiry_ms)
        )
          throw new WorkConflict("command_native_deadline_unbounded");
        const claims = await parseCommandClaims("work_command_dispatch", {
          ...prepared,
          version: 2,
          dispatchId: randomUUID(),
          readinessDigest: row.readiness_digest,
          hardDeadlineMs: deadline,
          iss: this.signer.issuer,
          aud: this.enforcementIssuer,
          jti: randomUUID(),
          iat: Math.floor(now / 1000),
          nbf: Math.floor(now / 1000),
          exp: Math.min(
            Math.floor(now / 1000) + 30,
            Math.floor(deadline / 1000),
            Math.floor(bounds.expiry / 1000),
          ),
          purpose: "work_command_dispatch",
          anchors: {
            admittedAtMs: now,
            rootDeadlineMs: bounds.root,
            nativeDeadlineMs: deadline,
            wallSeconds: checked.limits.wallSeconds,
            hardDeadlineMs: deadline,
            deadlineProfileVersion: 2,
          },
        });
        const ticket = await this.signer.sign(claims.purpose, claims, now);
        await db`INSERT INTO work_command_dispatches(action_id,dispatch_id,task_id,original_claim_id,original_epoch,authority_generation,connection_id,intent_digest,operation_fingerprint,operation,dispatch_claims,ticket_digest,engine_proof,input_scope,issued_at_ms,expires_at_ms,root_deadline_ms,native_deadline_ms,hard_deadline_ms,preparation_id,readiness_digest) VALUES(${id},${claims.dispatchId},${task.id},${scope.fence.claimId},${scope.fence.epoch},${claims.authorityGeneration},${claims.connectionId},${claims.intentDigest},${claims.operationFingerprint},${db.json(operation)},${db.json(claims)},${commandTokenDigest(ticket)},${db.json(this.proof(scope))},${db.json(row.input_scope)},${now},${claims.exp * 1000},${bounds.root},${deadline},${deadline},${preparationId},${row.readiness_digest})`;
        if ((await commandNow(db)) >= claims.exp * 1000)
          throw new WorkConflict("command_deadline_expired");
        bounded.throwIfAborted();
        result = { status: "issued", ticket, operation };
      }),
    );
    if (fresh && !result) throw new WorkConflict("command_admission_unknown");
    return fresh ? result! : lookup();
  }
  async consume(
    handle: CommandHandle,
    id: string,
    token: string,
    request: { requestId: string; nonce: string },
    signal: AbortSignal,
  ) {
    const scope = this.originalScope(id);
    return this.run(handle, signal, async (db, session, live) => {
      const { action } = await this.action(db, scope, id, true),
        original = await this.records.original(db, action),
        { row, preparation, binding } = original;
      this.originalScope(id, preparation);
      if (live.nodeId !== binding.nodeId || live.connectionId !== binding.connectionId)
        throw new WorkConflict("command_connection_changed");
      const challenge = await this.verifier.verify(token, {
        purpose: "work_command_consume",
        issuer: this.enforcementIssuer,
        audience: this.signer.issuer,
        binding,
        request,
        nowMs: await commandNow(db),
      });
      if (challenge.ticketDigest !== row.ticket_digest)
        throw new WorkConflict("command_ticket_changed");
      if (row.state !== "issued" || action.status === "unknown") return lookup();
      const task = await currentWork(db, scope);
      await this.approved(db, scope, task, action, ["admitted"]);
      const { profile, sha256 } = await this.profiles.resolve(db, task);
      this.connection(live, profile, binding.connectionId);
      if (sha256 !== binding.profileDigest) throw new WorkConflict("command_profile_changed");
      const command = await this.profiles.checkCommand(profile, row.operation.command);
      await revalidateCommandInputs(db, scope, task, command, row.input_scope, session);
      const now = await commandNow(db);
      if (
        !this.clock.check(binding.preparationId, now, this.timing, false) ||
        now >= Math.min(Number(row.expires_at_ms), binding.hardDeadlineMs)
      )
        throw new WorkConflict("command_deadline_expired");
      const launch = Math.min(now + 5000, binding.hardDeadlineMs),
        claims = await parseCommandClaims("work_command_permit", {
          ...binding,
          iss: this.signer.issuer,
          aud: this.enforcementIssuer,
          jti: randomUUID(),
          iat: Math.floor(now / 1000),
          nbf: Math.floor(now / 1000),
          exp: Math.floor(launch / 1000),
          purpose: "work_command_permit",
          ...request,
          requestDigest: commandTokenDigest(token),
          consumedAtMs: now,
          launchDeadlineMs: launch,
        });
      const permit = await this.signer.sign(claims.purpose, claims, now);
      const updated =
        await db`UPDATE work_command_dispatches SET state='consumed',consume_request_digest=${claims.requestDigest},consume_nonce=${request.nonce},consumed_at_ms=${now},permit_claims=${db.json(claims)} WHERE action_id=${id} AND state='issued' RETURNING action_id`;
      if (updated.length !== 1) throw new WorkConflict("command_consumption_unknown");
      await workEvent(db, task.id, "command.permit_issued", {
        actionId: id,
        dispatchId: binding.dispatchId,
        preparationId: binding.preparationId,
        permitDigest: commandTokenDigest(permit),
      });
      await checkWorkFence(db, scope.fence);
      if ((await commandNow(db)) >= claims.exp * 1000)
        throw new WorkConflict("command_deadline_expired");
      return { status: "consumed" as const, permit };
    });
  }
  async original(scope: WorkScope, id: string) {
    this.available();
    return this.transactions.run(async (db) =>
      this.records.original(db, (await this.action(db, scope, id, true)).action),
    );
  }
  async authorizeLookup(
    handle: CommandHandle,
    id: string,
    token: string,
    request: { requestId: string; nonce: string },
    includeOutput: boolean,
    signal: AbortSignal,
  ) {
    const scope = this.originalScope(id);
    return this.run(handle, signal, async (db, session, live) => {
      const { task, action } = await this.action(db, scope, id),
        { row, preparation, binding } = await this.records.original(db, action);
      this.originalScope(id, preparation);
      if (
        !["issued", "consumed"].includes(row.state) ||
        (includeOutput && row.state !== "consumed")
      )
        throw new WorkConflict("command_lookup_required");
      await this.approved(db, scope, task, action, ["admitted", "unknown"]);
      const { profile, sha256 } = await this.profiles.resolve(db, task);
      this.connection(live, profile, binding.connectionId);
      if (sha256 !== binding.profileDigest) throw new WorkConflict("command_profile_changed");
      const command = await this.profiles.checkCommand(profile, row.operation.command);
      await revalidateCommandInputs(db, scope, task, command, row.input_scope, session);
      const challenge = await this.verifier.verify(token, {
        purpose: "work_command_control_challenge",
        issuer: this.enforcementIssuer,
        audience: this.signer.issuer,
        binding: preparation.binding,
        request,
      });
      if (challenge.operation !== "lookup" || !this.clock.healthy())
        throw new WorkConflict("command_control_operation_changed");
      const bounds = await this.bounds(db, scope, task, action),
        now = await commandNow(db),
        expires = Math.min(now + 30000, bounds.expiry);
      const authorized = await this.signer.sign("work_command_control_request", {
        ...preparation.binding,
        version: 2,
        iss: this.signer.issuer,
        aud: this.enforcementIssuer,
        jti: randomUUID(),
        purpose: "work_command_control_request",
        challengeDigest: commandTokenDigest(token),
        ...request,
        issuedAtMs: now,
        expiresAtMs: expires,
        dispatch: binding,
        operation: "lookup",
        includeOutput,
      });
      await checkWorkFence(db, scope.fence);
      if ((await commandNow(db)) >= expires) throw new WorkConflict("command_control_expired");
      return authorized;
    });
  }
}
