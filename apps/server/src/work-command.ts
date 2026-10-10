/** Orchestrates approved command effects and lookup-only recovery of uncertain outcomes. */
import { setTimeout as delay } from "node:timers/promises";
import { WorkConflict } from "@openbot/work";
import { z } from "zod";
import type { FileSession, OwnerFiles } from "./owner-files.js";
import { actionCommand } from "./work-command-actions.js";
import {
  type CommandClaims,
  commandExecutionBinding,
  workCommandSchema,
} from "./work-command-contract.js";
import { WorkCommandDispatches } from "./work-command-dispatches.js";
import { WorkCommandDriver } from "./work-command-driver.js";
import { freezeCommandInputs } from "./work-command-inputs.js";
import { type WorkCommandSetup, workCommandKeys } from "./work-command-installation.js";
import { commandSource } from "./work-command-profiles.js";
import { commandNow, sameCommandValue } from "./work-command-records.js";
import { commandDigest } from "./work-command-values.js";
import { acceptedWork } from "./work-execution.js";
import type { WorkDb, WorkTransactions } from "./work-handoff.js";
import {
  currentWork,
  loadWorkActions,
  type WorkAction,
  type WorkLedger,
  type WorkScope,
} from "./work-ledger.js";
import type { WorkModelObservation, WorkTool } from "./work-model.js";
import { workAttachmentIds } from "./work-source.js";
import { type WorkJson, workCanonical } from "./work-values.js";

const argsSchema = z
  .object({
    argv: workCommandSchema.shape.argv,
    output: workCommandSchema.shape.output.extend({ maxBytes: z.number().int().min(1).max(65536) }),
  })
  .strict();
export const workCommandTool: WorkTool = {
  name: "run_command",
  description:
    "Propose one offline command for Owner approval. Read only supplied /input files and write the declared UTF-8 text or CSV file under /output. No network or secrets. Process exit is an observation, not proof of content correctness.",
  parameters: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 4096 },
      },
      output: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
          },
          mediaType: { type: "string", enum: ["text/plain", "text/csv"] },
          maxBytes: { type: "integer", minimum: 1, maximum: 65536 },
        },
        required: ["name", "mediaType", "maxBytes"],
        additionalProperties: false,
      },
    },
    required: ["argv", "output"],
    additionalProperties: false,
  },
};
const observedSchema = z
  .object({
    schema: z.literal("openbot.work-command-observation/v1"),
    token: z.string().max(8192),
    verifiedAtMs: z.number().int().positive(),
    receipt: z.record(z.string(), z.json()),
    output: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().min(0).max(65536),
      })
      .strict(),
    payload: z.record(z.string(), z.json()),
  })
  .strict();
function payload(receipt: CommandClaims<"work_command_receipt">, data: Buffer) {
  const observation = receipt.observation,
    output = observation.outputs[0];
  if (observation.phase !== "exited" || observation.outputs.length !== 1 || !output)
    throw new WorkConflict("command_output_changed");
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  let text = "",
    end = Math.min(data.length, 16384);
  for (let cut = 0; cut < 4; cut++) {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        data.subarray(0, end - cut),
      );
      break;
    } catch {
      if (cut === 3) throw new WorkConflict("command_output_changed");
    }
  }
  return {
    status: "exited",
    exitCode: observation.exitCode,
    output,
    text,
    truncated: text.length !== decoded.length,
    untrusted: true,
    publishedOnTaskCompletion: true,
  };
}
/** Product adapter for one approved offline command. Output stays private until independent review. */
export class WorkCommands {
  private driverValue?: WorkCommandDriver;
  constructor(
    readonly transactions: WorkTransactions,
    readonly ledger: WorkLedger,
    readonly setup: WorkCommandSetup,
    readonly attachments?: OwnerFiles,
  ) {}
  async start() {
    if (this.driverValue) throw new WorkConflict("command_composition_required");
    const { configuration, profiles, inbox } = this.setup,
      { signer, verifier } = await workCommandKeys(configuration);
    const service = new WorkCommandDispatches(
      this.transactions,
      this.ledger,
      profiles,
      inbox.transport,
      signer,
      verifier,
      configuration.enforcement.issuer,
      configuration.timing,
      this.attachments,
    );
    await service.start();
    this.driverValue = new WorkCommandDriver(service, inbox);
  }
  close() {
    this.driverValue?.service.close();
  }
  private get driver() {
    if (!this.driverValue) throw new WorkConflict("command_composition_required");
    return this.driverValue;
  }
  private lock<T>(operation: (session?: FileSession) => Promise<T>, signal?: AbortSignal) {
    return this.attachments ? this.attachments.withLock(operation, signal) : operation();
  }
  private async snapshot(
    db: WorkDb,
    scope: WorkScope,
    session?: FileSession,
    args?: z.infer<typeof argsSchema>,
  ) {
    if (scope.commandProfiles !== this.setup.profiles)
      throw new WorkConflict("command_composition_required");
    const task = await currentWork(db, scope),
      source = await commandSource(db, task),
      { profile, sha256 } = await this.setup.profiles.resolve(db, task),
      refs = workAttachmentIds(task.objective).sort();
    if (refs.length && !session) throw new WorkConflict("command_input_scope_changed");
    const originals = refs.map((id, index) => ({
      path: `input-${String(index + 1).padStart(2, "0")}`,
      attachmentId: id,
      ...session!.content(String(source.channel_id), id),
    }));
    if (originals.reduce((size, item) => size + item.data.length, 0) > 20 * 1024 * 1024)
      throw new WorkConflict("command_input_limit");
    const policy = this.setup.profiles.policy(profile),
      manifest = originals.map((item) => ({
        path: item.path,
        size: item.data.length,
        sha256: item.item.sha256,
      })),
      attachments = originals.map(({ path, attachmentId }) => ({ path, attachmentId })),
      blobs = new Map(originals.map((item) => [item.path, item.data]));
    const description = {
      inputs: originals.map((v) => ({
        path: "/input/" + v.path,
        attachmentId: v.attachmentId,
        name: v.item.name,
        sizeBytes: v.data.length,
        sha256: v.item.sha256,
      })),
      image: policy.image,
      limits: policy.limits,
      outputDirectory: "/output",
      maxOutputBytes: 65536,
      network: "none",
      rootfs: "readonly",
      requiresOwnerApproval: true,
    };
    if (!args) return { description, profile, sha256, command: null, attachments, blobs };
    const command = await this.setup.profiles.checkCommand(profile, {
      ...policy,
      ...args,
      inputManifest: manifest,
      inputDigest: "sha256:" + commandDigest(manifest),
      network: "none",
      rootfs: "readonly",
      user: "10001:10001",
      environment: [],
    });
    await freezeCommandInputs(db, scope, task, command, attachments, session);
    return { description, profile, sha256, command, attachments, blobs };
  }
  async describe(db: WorkDb, scope: WorkScope, session?: FileSession) {
    return (await this.snapshot(db, scope, session)).description;
  }
  private async original(db: WorkDb, scope: WorkScope, action: WorkAction, session?: FileSession) {
    const effect = await actionCommand(action.intent),
      snapshot = await this.snapshot(db, scope, session, argsSchema.parse(action.intent.arguments));
    if (
      effect.profileDigest !== snapshot.sha256 ||
      !sameCommandValue(effect.command, snapshot.command)
    )
      throw new WorkConflict("command_intent_changed");
    return { ...snapshot, command: snapshot.command! };
  }
  async execute(
    scope: WorkScope,
    key: string,
    call: WorkModelObservation["calls"][number],
    signal: AbortSignal,
  ) {
    if (call.name !== "run_command") throw new WorkConflict("command_proposal_changed");
    const args = argsSchema.parse(call.arguments),
      intent = await this.lock(
        (session) =>
          this.transactions.run(async (db) => {
            const snapshot = await this.snapshot(db, scope, session, args);
            return {
              kind: "deferred_tool",
              tool: call.name,
              arguments: args,
              effect: {
                kind: "work_command",
                version: 1,
                profileDigest: snapshot.sha256,
                command: snapshot.command!,
              },
            };
          }),
        signal,
      );
    const action = await this.ledger.propose(scope, key, intent, 0, true);
    if (action.status === "applied" || action.decision === "pending") return;
    const original = await this.lock(
      (session) => this.transactions.run((db) => this.original(db, scope, action, session)),
      signal,
    );
    const handle = this.driver.service.transport.connection(original.profile.route.nodeId);
    try {
      try {
        await this.driver.execute(
          scope,
          action.id,
          handle,
          original.command,
          original.attachments,
          original.blobs,
          signal,
        );
      } catch (error) {
        const status = await this.transactions.run(async (db) => {
          await acceptedWork(db, scope.binding, true);
          return (await loadWorkActions(db, action.task_id)).find((a) => a.id === action.id)
            ?.status;
        });
        if (signal.aborted || !["admitted", "unknown"].includes(status ?? "")) throw error;
      }
      const dispatch = await this.driver.service.original(scope, action.id),
        now = await this.transactions.run(commandNow),
        budget = Math.max(0, Math.min(55000, dispatch.binding.hardDeadlineMs - now));
      if (budget <= 0) throw new WorkConflict("command_observation_unavailable");
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
      let result: Awaited<ReturnType<WorkCommandDriver["lookup"]>> | undefined;
      for (let i = 0; i < 128; i++) {
        result = await this.driver.lookup(scope, handle, action.id, true, bounded);
        if (result.receipt.observation.phase === "exited") break;
        if (!["prepared", "running"].includes(result.receipt.observation.phase))
          throw new WorkConflict("command_observation_unavailable");
        result = undefined;
        await delay(500, undefined, { signal: bounded });
      }
      if (!result || result.receipt.observation.outputs.length !== 1)
        throw new WorkConflict("command_observation_unavailable");
      const observed = result;
      await this.lock(async (session) => {
        const verifiedAtMs = await this.transactions.run(async (db) => {
          await this.original(db, scope, action, session);
          return commandNow(db);
        });
        const receipt = await this.driver.service.verifier.verify(observed.token, {
          purpose: "work_command_receipt",
          issuer: this.setup.configuration.enforcement.issuer,
          audience: this.setup.configuration.control.issuer,
          binding: dispatch.binding,
          request: { requestId: observed.receipt.requestId, nonce: observed.receipt.nonce },
          nowMs: verifiedAtMs,
        });
        const value = z.json().parse({
          schema: "openbot.work-command-observation/v1",
          token: observed.token,
          verifiedAtMs,
          receipt,
          output: this.ledger.files.put(observed.output),
          payload: payload(receipt, observed.output),
        });
        await this.transactions.run((db) => this.evidence(db, scope, action, value, session));
        bounded.throwIfAborted();
        await this.ledger.record(scope.binding, action, "tool", value);
      }, bounded);
    } catch (error) {
      await this.ledger.unknown(scope.binding, action.id);
      throw error;
    } finally {
      // Historical receipt verification needs persisted evidence, never a reusable live authority.
      this.driver.service.release(action.id);
    }
  }
  payload(_action: WorkAction, value: WorkJson | null) {
    return observedSchema.parse(value).payload;
  }
  private async evidence(
    db: WorkDb,
    scope: WorkScope,
    action: WorkAction,
    observed: WorkJson | null,
    session?: FileSession,
  ) {
    const original = await this.original(db, scope, action, session),
      value = observedSchema.parse(observed),
      dispatch = await this.driver.service.records.original(db, action),
      claimed = value.receipt;
    const receipt = await this.driver.service.verifier.verify(value.token, {
      purpose: "work_command_receipt",
      issuer: this.setup.configuration.enforcement.issuer,
      audience: this.setup.configuration.control.issuer,
      binding: dispatch.binding,
      request: { requestId: String(claimed.requestId), nonce: String(claimed.nonce) },
      nowMs: value.verifiedAtMs,
    });
    if (
      !sameCommandValue(receipt, claimed) ||
      receipt.permitDigest !== dispatch.permitDigest ||
      dispatch.row.state !== "consumed"
    )
      throw new WorkConflict("command_receipt_changed");
    const data = this.ledger.files.read(value.output),
      output = receipt.observation.outputs[0];
    if (
      !output ||
      !sameCommandValue(value.output, { sha256: output.sha256, sizeBytes: output.sizeBytes }) ||
      output.name !== original.command.output.name ||
      output.mediaType !== original.command.output.mediaType ||
      output.sizeBytes > original.command.output.maxBytes ||
      !sameCommandValue(value.payload, payload(receipt, data))
    )
      throw new WorkConflict("command_output_changed");
    return { data, output, value };
  }
  private async rows(db: WorkDb, scope: WorkScope) {
    const task = await currentWork(db, scope);
    return (await loadWorkActions(db, task.id)).filter(
      (a) =>
        a.run_id === scope.binding.input.runId &&
        a.intent.tool === "run_command" &&
        a.status === "applied" &&
        Number(a.authority_generation) === Number(task.authority_generation),
    );
  }
  async revalidate(db: WorkDb, scope: WorkScope, session?: FileSession) {
    for (const action of await this.rows(db, scope))
      await this.evidence(
        db,
        { ...scope, contextId: action.correction_context_id },
        action,
        await this.ledger.observed(db, action, "tool"),
        session,
      );
  }
  async artifacts(db: WorkDb, scope: WorkScope, session?: FileSession) {
    const results = [];
    for (const action of await this.rows(db, scope)) {
      const { data, output } = await this.evidence(
        db,
        { ...scope, contextId: action.correction_context_id },
        action,
        await this.ledger.observed(db, action, "tool"),
        session,
      );
      results.push({
        key: action.id,
        name: output.name,
        mediaType: output.mediaType,
        sha256: output.sha256,
        sizeBytes: output.sizeBytes,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
      });
    }
    return results;
  }
}
