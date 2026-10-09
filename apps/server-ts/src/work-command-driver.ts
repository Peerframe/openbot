import { randomUUID } from "node:crypto";
import { WorkConflict } from "@openbot/work";
import type { WorkCommand } from "./work-command-contract.js";
import { commandPreparationBinding } from "./work-command-contract.js";
import { unverifiedCommandPayload } from "./work-command-crypto.js";
import type { WorkCommandDispatches } from "./work-command-dispatches.js";
import type { CommandInbox } from "./work-command-inbox.js";
import type { CommandAttachment } from "./work-command-inputs.js";
import { commandNow } from "./work-command-records.js";
import type { WorkScope } from "./work-ledger.js";
import { sha256 } from "./work-values.js";
import type { CommandHandle } from "./worker-command-channel.js";

/** Wire orchestration only. A missing ACK never restarts preparation, admission or consumption. */
export class WorkCommandDriver {
  constructor(
    readonly service: WorkCommandDispatches,
    readonly inbox: CommandInbox,
  ) {
    if (service.transport !== inbox.transport)
      throw new WorkConflict("command_channel_composition_changed");
  }
  async execute(
    scope: WorkScope,
    id: string,
    handle: CommandHandle,
    command: WorkCommand,
    attachments: CommandAttachment[],
    blobs: ReadonlyMap<string, Buffer>,
    signal: AbortSignal,
  ) {
    if (
      blobs.size !== command.inputManifest.length ||
      command.inputManifest.some((item) => {
        const data = blobs.get(item.path);
        return !data || data.length !== item.size || sha256(data) !== item.sha256;
      })
    )
      throw new WorkConflict("command_input_manifest_changed");
    const reserved = await this.service.reserve(scope, id, handle, command, attachments, signal);
    if (reserved.status !== "reserved") return { status: "lookup_required" as const };
    return this.inbox.exchange(handle, reserved.binding, async (session) => {
      const prep = reserved.binding.preparationId,
        bounded = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.service.timing.prepareBudgetMs),
        ]);
      await session.send("work.command.prepare_open", prep, reserved.binding, bounded);
      await session.take(
        "work.command.prepare_challenge",
        prep,
        bounded,
        async (pending, frame) => {
          const result = await this.service.authorizePreparation(
            handle,
            id,
            frame.payload.token,
            bounded,
          );
          if (result.status !== "authorized") throw new WorkConflict("command_preparation_refused");
          await session.reply(
            pending,
            "work.command.prepare_authorize",
            { token: result.authorization },
            bounded,
          );
        },
      );
      for (const [index, item] of command.inputManifest.entries()) {
        const data = blobs.get(item.path)!;
        for (let offset = 0; offset < data.length; offset += 16384) {
          const chunk = data.subarray(offset, offset + 16384);
          await session.send(
            "work.command.input_chunk",
            prep,
            { fileIndex: index, offset, data: chunk.toString("base64") },
            bounded,
          );
          await session.take(
            "work.command.input_ack",
            prep,
            bounded,
            async (_pending, frame) => {
              if (
                frame.payload.fileIndex !== index ||
                frame.payload.nextOffset !== offset + chunk.length
              )
                throw new WorkConflict("command_input_ack_changed");
            },
            this.service.timing.prepareBudgetMs,
          );
        }
      }
      await session.take(
        "work.command.ready",
        prep,
        bounded,
        async (_pending, frame) => {
          if (
            (await this.service.acceptReady(handle, id, frame.payload.token, bounded)).status !==
            "ready"
          )
            throw new WorkConflict("command_preparation_refused");
        },
        this.service.timing.prepareBudgetMs,
      );
      const issued = await this.service.admit(handle, id, prep, signal);
      if (issued.status !== "issued") return { status: "lookup_required" as const };
      const dispatch = String(unverifiedCommandPayload(issued.ticket).dispatchId);
      await session.send(
        "work.command.dispatch",
        dispatch,
        { ticket: issued.ticket, operation: issued.operation },
        signal,
      );
      await session.take("work.command.consume", null, signal, async (pending, frame) => {
        const token = frame.payload.token,
          payload = unverifiedCommandPayload(token);
        const result = await this.service.consume(
          handle,
          id,
          token,
          { requestId: frame.requestId, nonce: String(payload.nonce) },
          signal,
        );
        if (result.status !== "consumed") throw new WorkConflict("command_consume_refused");
        await session.reply(pending, "work.command.consume_result", result, signal);
      });
      return { status: "dispatched" as const };
    });
  }
  async lookup(
    scope: WorkScope,
    handle: CommandHandle,
    id: string,
    includeOutput: boolean,
    signal: AbortSignal,
  ) {
    const original = await this.service.original(scope, id),
      binding = commandPreparationBinding(original.binding),
      requestId = randomUUID();
    return this.inbox.exchange(handle, binding, async (session) => {
      await session.send(
        "work.command.control_open",
        requestId,
        { binding, operation: "lookup" },
        signal,
      );
      let nonce: string | undefined;
      await session.take(
        "work.command.control_challenge",
        requestId,
        signal,
        async (pending, frame) => {
          const payload = unverifiedCommandPayload(frame.payload.token);
          nonce = String(payload.nonce);
          const authorized = await this.service.authorizeLookup(
            handle,
            id,
            frame.payload.token,
            { requestId, nonce },
            includeOutput,
            signal,
          );
          await session.reply(pending, "work.command.lookup", { token: authorized }, signal);
        },
      );
      if (!nonce) throw new WorkConflict("command_control_challenge_required");
      const request = { requestId, nonce };
      const observed = await session.take(
        "work.command.lookup_result",
        requestId,
        signal,
        async (_pending, frame) => {
          const now = await this.service.transactions.run(commandNow),
            token = frame.payload.token;
          const receipt = await this.service.verifier.verify(token, {
            purpose: "work_command_receipt",
            issuer: this.service.enforcementIssuer,
            audience: this.service.signer.issuer,
            binding: original.binding,
            request,
            nowMs: now,
          });
          if (
            receipt.permitDigest !== original.permitDigest ||
            (receipt.observation.outputs.length && !includeOutput)
          )
            throw new WorkConflict("command_permit_record_changed");
          return { token, receipt };
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const output = observed.receipt.observation.outputs[0];
      if (output) {
        const expected = original.operation.command.output;
        if (
          output.name !== expected.name ||
          output.mediaType !== expected.mediaType ||
          output.sizeBytes > expected.maxBytes
        )
          throw new WorkConflict("command_output_changed");
        while (size < output.sizeBytes)
          await session.take(
            "work.command.output_chunk",
            requestId,
            signal,
            async (pending, frame) => {
              const data = Buffer.from(frame.payload.data, "base64");
              if (
                frame.payload.fileIndex !== 0 ||
                frame.payload.offset !== size ||
                size + data.length > output.sizeBytes
              )
                throw new WorkConflict("command_output_changed");
              chunks.push(data);
              size += data.length;
              await session.reply(
                pending,
                "work.command.output_ack",
                { fileIndex: 0, nextOffset: size },
                signal,
              );
            },
          );
      }
      const data = Buffer.concat(chunks);
      if (output && sha256(data) !== output.sha256)
        throw new WorkConflict("command_output_changed");
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      const now = await this.service.transactions.run(commandNow);
      await this.service.verifier.verify(observed.token, {
        purpose: "work_command_receipt",
        issuer: this.service.enforcementIssuer,
        audience: this.service.signer.issuer,
        binding: original.binding,
        request,
        nowMs: now,
      });
      signal.throwIfAborted();
      return { ...observed, output: data, verifiedAtMs: now };
    });
  }
}
