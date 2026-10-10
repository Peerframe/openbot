/** Protected command Host. Durable reservations precede native effects; uncertain execution never replays. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import {
  commandDispatchOperationSchema,
  commandNodeFrameSchema,
  commandProtocolVersion,
  commandServerFrameSchema,
} from "../../packages/protocol/dist/index.js";
import {
  commandPreparationBinding,
  commandExecutionBinding,
  commandFingerprint,
  commandTimeLower,
  type CommandClaims,
  type CommandOperation,
  type TimingPolicy,
} from "../../apps/server/dist/work-command-contract.js";
import {
  CommandSigner,
  CommandVerifier,
  unverifiedCommandPayload,
} from "../../apps/server/dist/work-command-crypto.js";
import { exclusive, fsyncDirectory, readRecord, requireFact } from "./protected-io.ts";
import { HostExchangeBook, type PendingExchange } from "./host-exchange.ts";
import { Inputs } from "./host-inputs.ts";
type Binding = ReturnType<typeof commandPreparationBinding>;
type Authorization = CommandClaims<"work_command_prepare_authorize">;
export type NativeRecord = { root: string; input: string; output: string; [key: string]: unknown };
export type Launch = {
  bootId: string;
  enforcerInstanceId: string;
  expiresBoottimeUs: number;
  digest: string;
};
export type NativeHost = {
  instancePath?: string;
  reserve: (
    binding: Binding,
    authorization: Authorization,
    instance: string,
  ) => Promise<NativeRecord>;
  prepare: (
    record: NativeRecord,
    authorization: Authorization,
    start: readonly [number, number, string],
  ) => Promise<void>;
  checkAlive: (record: NativeRecord) => Promise<unknown>;
  readiness: (
    record: NativeRecord,
    authorization: Authorization,
  ) => Promise<CommandClaims<"work_command_ready">["proof"]>;
  execute: (record: NativeRecord, operation: CommandOperation, launch: Launch) => Promise<void>;
  lookup: (
    record: NativeRecord,
    operation: CommandOperation,
    includeOutput: boolean,
  ) => Promise<{
    observation: CommandClaims<"work_command_receipt">["observation"];
    data: Buffer | null;
  }>;
  stop: (record: NativeRecord) => Promise<void>;
};
export type HostConfiguration = {
  state: string;
  socketPath: string;
  nodeUid: number;
  nodeGid: number;
  route: CommandOperation["route"];
  policy: TimingPolicy;
  controlIssuer: string;
  enforcementIssuer: string;
  signer: CommandSigner;
  verifier: CommandVerifier;
};
type Original = { binding: Binding; native: NativeRecord; authorizationDigest: string };
type State = {
  binding: Binding;
  pending: PendingExchange;
  path?: string;
  native?: NativeRecord;
  authorization?: Authorization;
  inputs?: Inputs;
  ready?: boolean;
  consume?: PendingExchange;
  operation?: CommandOperation;
};
type Control = { pending: PendingExchange; binding: Binding; path: string; original: Original };
export class Host {
  readonly config: HostConfiguration;
  readonly native: NativeHost;
  readonly book: HostExchangeBook;
  readonly actions: string;
  readonly instancePath: string;
  readonly active = new Map<string, State>();
  readonly controls = new Map<string, Control>();
  readonly output = new Map<string, { data: Buffer; offset: number }>();
  private boundConnection?: string;
  closed = false;
  constructor(
    config: HostConfiguration,
    native: NativeHost,
    clock?: () => readonly [number, number, string],
  ) {
    this.config = config;
    this.native = native;
    this.book = new HostExchangeBook(config.policy, clock);
    this.actions = join(config.state, "actions");
    mkdirSync(this.actions, { recursive: true, mode: 0o700 });
    requireFact(readdirSync(this.actions).length <= 64, "capacity_exhausted");
    this.instancePath = join(config.state, "instance.json");
    const temporary = join(config.state, `instance-${this.book.instanceId}.tmp`);
    exclusive(temporary, { instanceId: this.book.instanceId });
    renameSync(temporary, this.instancePath);
    fsyncDirectory(config.state);
    native.instancePath = this.instancePath;
  }
  private frame(type: string, binding: Binding, requestId: string, payload: unknown) {
    return commandNodeFrameSchema.parseAsync({
      type,
      protocolVersion: commandProtocolVersion,
      nodeId: binding.nodeId,
      preparationId: binding.preparationId,
      requestId,
      payload,
    });
  }
  private correlate(frame: { nodeId: string; preparationId: string }, binding: Binding) {
    requireFact(
      Object.entries(this.config.route).every(([k, v]) => Reflect.get(binding, k) === v),
      "route_changed",
    );
    requireFact(
      frame.nodeId === binding.nodeId && frame.preparationId === binding.preparationId,
      "outer_identity_changed",
    );
  }
  recordPath(binding: Binding) {
    return join(this.actions, createHash("sha256").update(binding.actionId).digest("hex"));
  }
  private original(binding: Binding) {
    const path = this.recordPath(binding),
      original = readRecord(join(path, "original.json"), process.geteuid!()) as Original;
    requireFact(same(original.binding, binding), "original_identity_changed");
    return { path, original };
  }
  private async ready(state: State) {
    requireFact(
      state.inputs && state.native && state.authorization && state.path,
      "no_input_phase",
    );
    if (!state.inputs.complete() || state.ready) return [];
    const proof = await this.native.readiness(state.native, state.authorization),
      token = await state.pending.ready(proof, this.config.signer, this.config.controlIssuer);
    exclusive(join(state.path, "ready.json"), { token, proof });
    state.ready = true;
    return [
      await this.frame("work.command.ready", state.binding, state.binding.preparationId, { token }),
    ];
  }
  async handle(raw: unknown) {
    requireFact(!this.closed, "connection_closed");
    const f = await commandServerFrameSchema.parseAsync(raw);
    requireFact(f.nodeId === this.config.route.nodeId, "route_changed");
    if (f.type === "work.command.prepare_open") {
      const binding = f.payload;
      this.correlate(f, binding);
      this.boundConnection ??= binding.connectionId;
      requireFact(binding.connectionId === this.boundConnection, "connection_changed");
      requireFact(
        !existsSync(this.recordPath(binding)) &&
          !this.active.has(f.preparationId) &&
          this.active.size < 64,
        "original_already_reserved",
      );
      const pending = this.book.beginPrepare(binding);
      this.active.set(f.preparationId, { binding, pending });
      return [
        await this.frame("work.command.prepare_challenge", binding, f.requestId, {
          token: await pending.challenge(this.config.signer, this.config.controlIssuer),
        }),
      ];
    }
    if (f.type === "work.command.control_open") {
      const { binding, operation } = f.payload;
      this.correlate(f, binding);
      const original = this.original(binding);
      requireFact(!this.controls.has(f.requestId), "request_replayed");
      const pending = this.book.beginControl(binding, f.requestId, operation);
      this.controls.set(f.requestId, { pending, binding, ...original });
      return [
        await this.frame("work.command.control_challenge", binding, f.requestId, {
          token: await pending.challenge(this.config.signer, this.config.controlIssuer),
        }),
      ];
    }
    if (
      f.type === "work.command.lookup" ||
      f.type === "work.command.stop" ||
      f.type === "work.command.output_ack"
    ) {
      const control = this.controls.get(f.requestId);
      requireFact(control, "no_pending_control");
      this.correlate(f, control.binding);
      const pending = control.pending;
      if (f.type === "work.command.output_ack") {
        pending.checkControl(true);
        const output = this.output.get(f.requestId);
        requireFact(output && f.payload.nextOffset === output.offset, "output_offset_changed");
        return this.chunk(control);
      }
      const record = await pending.acceptControl(
          f.payload.token,
          this.config.verifier,
          this.config.controlIssuer,
          this.config.enforcementIssuer,
        ),
        value = record.value;
      requireFact(
        value.operation === (f.type === "work.command.lookup" ? "lookup" : "stop"),
        "operation_changed",
      );
      if (value.operation === "stop") {
        pending.checkControl();
        exclusive(join(control.path, `stop-${f.requestId}.json`), {
          digest: record.digest,
          reason: value.reason,
        });
        await this.native.stop(control.original.native);
        this.finishControl(control);
        return [];
      }
      requireFact(value.dispatch, "no_dispatch");
      const dispatch = readRecord(join(control.path, "dispatch.json"), process.geteuid!()) as {
        binding: unknown;
        operation: CommandOperation;
      };
      requireFact(same(value.dispatch, dispatch.binding), "original_dispatch_changed");
      pending.checkControl();
      const { observation, data } = await this.native.lookup(
        control.original.native,
        dispatch.operation,
        value.includeOutput,
      );
      const observations = join(control.path, "observations");
      mkdirSync(observations, { recursive: true, mode: 0o700 });
      const entries = readdirSync(observations);
      requireFact(
        entries.length < 4096 && entries.every((n) => /^[1-9][0-9]*\.json$/.test(n)),
        "observation_capacity",
      );
      const sequence = Math.max(0, ...entries.map((n) => Number(n.slice(0, -5)))) + 1;
      exclusive(join(observations, sequence + ".json"), {
        requestId: f.requestId,
        challengeDigest: value.challengeDigest,
      });
      observation.sequence = sequence;
      const permitPath = join(control.path, "permit.json"),
        consumed = existsSync(permitPath)
          ? (readRecord(permitPath, process.geteuid!()) as Launch)
          : null;
      const token = await pending.receipt(
          observation,
          consumed?.digest ?? null,
          this.config.signer,
          this.config.controlIssuer,
        ),
        results = [
          await this.frame("work.command.lookup_result", control.binding, f.requestId, { token }),
        ];
      if (data !== null) {
        pending.checkControl(true);
        requireFact(Buffer.isBuffer(data) && data.length <= 1048576, "output_bound");
        new TextDecoder("utf8", { fatal: true }).decode(data);
        requireFact(
          observation.outputs.length === 1 &&
            observation.outputs[0]!.sizeBytes === data.length &&
            observation.outputs[0]!.sha256 === createHash("sha256").update(data).digest("hex"),
          "output_receipt_changed",
        );
        this.output.set(f.requestId, { data, offset: 0 });
        results.push(...(await this.chunk(control)));
      } else this.finishControl(control);
      return results;
    }
    const state = this.active.get(f.preparationId);
    requireFact(state, "no_pending_preparation");
    this.correlate(f, state.binding);
    requireFact(state.binding.connectionId === this.boundConnection, "connection_changed");
    if (f.type === "work.command.prepare_authorize") {
      const record = await state.pending.acceptAuthorization(
        f.payload.token,
        this.config.verifier,
        this.config.controlIssuer,
        this.config.enforcementIssuer,
      );
      requireFact(
        record.value.timing.runtimeMaxMs <= 50000 && record.value.timing.stopAllowanceMs === 5000,
        "unqualified_timing",
      );
      requireFact(readdirSync(this.actions).length < 64, "capacity_exhausted");
      const path = this.recordPath(state.binding);
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(this.actions);
      const native = await this.native.reserve(state.binding, record.value, this.book.instanceId);
      exclusive(join(path, "original.json"), {
        binding: state.binding,
        native,
        authorizationDigest: record.digest,
      });
      Object.assign(state, { path, native, authorization: record.value });
      state.inputs = new Inputs(native.input, record.value.staging.inputManifest);
      await this.native.prepare(native, record.value, state.pending.start);
      return this.ready(state);
    }
    if (f.type === "work.command.input_chunk") {
      requireFact(
        f.requestId === state.binding.preparationId && state.inputs && state.native && !state.ready,
        "input_phase_changed",
      );
      state.pending.interval();
      await this.native.checkAlive(state.native);
      const nextOffset = state.inputs.append(f.payload);
      return [
        await this.frame("work.command.input_ack", state.binding, f.requestId, {
          fileIndex: f.payload.fileIndex,
          nextOffset,
        }),
        ...(await this.ready(state)),
      ];
    }
    if (f.type === "work.command.dispatch") {
      requireFact(
        state.ready && !state.consume && state.authorization && state.path,
        "dispatch_replayed",
      );
      const untrusted = unverifiedCommandPayload(f.payload.ticket),
        binding = commandExecutionBinding(
          untrusted as unknown as CommandClaims<"work_command_dispatch">,
        );
      const record = await state.pending.acceptDispatch(
        f.payload.ticket,
        this.config.verifier,
        this.config.controlIssuer,
        this.config.enforcementIssuer,
        binding,
      );
      requireFact(f.requestId === record.value.dispatchId, "outer_request_changed");
      const operation = await commandDispatchOperationSchema.parseAsync(f.payload.operation);
      requireFact(
        (await commandFingerprint(operation)) === state.binding.operationFingerprint,
        "operation_changed",
      );
      requireFact(
        same(operation.command, { ...state.authorization.staging, argv: operation.command.argv }),
        "staging_changed",
      );
      exclusive(join(state.path, "dispatch.json"), {
        binding: commandExecutionBinding(record.value),
        operation,
        digest: record.digest,
      });
      state.operation = operation;
      const consume = state.pending.beginConsume();
      state.consume = consume;
      const token = await consume.consumeChallenge(this.config.signer, this.config.controlIssuer);
      return [
        await this.frame("work.command.consume", state.binding, consume.requestId, { token }),
      ];
    }
    if (f.type === "work.command.consume_result") {
      const consume = state.consume;
      requireFact(
        consume &&
          state.path &&
          state.native &&
          state.operation &&
          f.requestId === consume.requestId,
        "consume_request_changed",
      );
      requireFact(f.payload.status === "consumed", "consume_refused");
      const record = await consume.acceptPermit(
          f.payload.permit,
          this.config.verifier,
          this.config.controlIssuer,
          this.config.enforcementIssuer,
        ),
        interval = consume.check(record.value),
        now = this.book.sample();
      const remaining =
          Math.min(record.value.launchDeadlineMs, record.value.hardDeadlineMs) - interval.upper,
        expiry = now[1] + commandTimeLower(this.book.policy, remaining) * 1000;
      requireFact(expiry > now[1], "permit_expired");
      const launch = {
        bootId: now[2],
        enforcerInstanceId: this.book.instanceId,
        expiresBoottimeUs: expiry,
        digest: record.digest,
      };
      exclusive(join(state.path, "permit.json"), launch);
      await this.native.execute(state.native, state.operation, launch);
      return [];
    }
    throw new Error("unsupported_frame");
  }
  private async chunk(control: Control) {
    control.pending.checkControl(true);
    const request = control.pending.requestId,
      output = this.output.get(request);
    requireFact(output, "no_pending_output");
    if (output.offset === output.data.length) {
      this.output.delete(request);
      this.finishControl(control);
      return [];
    }
    const offset = output.offset,
      data = output.data.subarray(offset, offset + 16384);
    output.offset += data.length;
    return [
      await this.frame("work.command.output_chunk", control.binding, request, {
        fileIndex: 0,
        offset,
        data: data.toString("base64"),
      }),
    ];
  }
  private finishControl(control: Control) {
    this.book.finishControl(control.pending);
    this.controls.delete(control.pending.requestId);
  }
  close() {
    this.closed = true;
    this.book.close();
    this.output.clear();
    for (const state of this.active.values()) state.inputs?.close();
  }
}
