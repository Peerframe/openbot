import {
  type CommandNodeFrame,
  type CommandPreparationBinding,
  type CommandServerFrame,
  commandPreparationBindingSchema,
  commandProtocolVersion,
  parseCommandFrame,
} from "@openbot/protocol";
import { WorkConflict } from "@openbot/work";
import type {
  CommandHandle,
  CommandNotifications,
  CommandPending,
  WorkerCommandChannel,
} from "./worker-command-channel.js";

const unavailable = () => new WorkConflict("command_exchange_unavailable");
/** Synchronous, bounded wire correlation. Sessions cannot create or renew durable Work authority. */
export class CommandInbox {
  private channel?: WorkerCommandChannel;
  private readonly sessions = new Map<CommandHandle, Map<string, CommandExchange>>();
  private count = 0;
  readonly notifications: CommandNotifications = {
    frame: (pending) =>
      this.sessions.get(pending.connection)?.get(pending.frame.preparationId)?.receive(pending) ===
      true,
    disconnected: (handle) => {
      for (const session of this.sessions.get(handle)?.values() ?? []) session.close();
    },
  };
  get transport() {
    if (!this.channel) throw unavailable();
    return this.channel;
  }
  attach(transport: WorkerCommandChannel) {
    if (this.channel || !transport) throw unavailable();
    this.channel = transport;
  }
  async exchange<T>(
    handle: CommandHandle,
    value: CommandPreparationBinding,
    operation: (session: CommandExchange) => Promise<T>,
  ): Promise<T> {
    const binding = commandPreparationBindingSchema.parse(value),
      byPreparation = this.sessions.get(handle) ?? new Map<string, CommandExchange>();
    if (
      !this.channel ||
      byPreparation.has(binding.preparationId) ||
      this.count >= 64 ||
      binding.nodeId !== handle.live.nodeId ||
      binding.connectionId !== handle.live.connectionId
    )
      throw unavailable();
    const session = new CommandExchange(this.transport, handle, binding);
    byPreparation.set(binding.preparationId, session);
    this.sessions.set(handle, byPreparation);
    this.count++;
    try {
      return await operation(session);
    } finally {
      session.close();
      byPreparation.delete(binding.preparationId);
      this.count--;
      if (!byPreparation.size) this.sessions.delete(handle);
    }
  }
}
export class CommandExchange {
  private readonly queue: CommandPending[] = [];
  private closed = false;
  private taking = false;
  private wake: (() => void) | undefined;
  constructor(
    private readonly transport: WorkerCommandChannel,
    readonly connection: CommandHandle,
    private readonly binding: CommandPreparationBinding,
  ) {}
  receive(pending: CommandPending) {
    if (this.closed || this.queue.length >= 4) return false;
    this.queue.push(pending);
    this.wake?.();
    return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.queue.splice(0)) this.complete(pending);
    this.wake?.();
  }
  private complete(pending: CommandPending) {
    try {
      this.transport.complete(pending);
    } catch (error) {
      if (!this.closed) throw error;
    }
  }
  private frame(type: CommandServerFrame["type"], request: string, payload: unknown) {
    return parseCommandFrame(
      {
        type,
        protocolVersion: commandProtocolVersion,
        nodeId: this.binding.nodeId,
        preparationId: this.binding.preparationId,
        requestId: request,
        payload,
      },
      { server: true },
    );
  }
  async send(
    type: CommandServerFrame["type"],
    request: string,
    payload: unknown,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (this.closed) throw unavailable();
    const frame = await this.frame(type, request, payload);
    signal.throwIfAborted();
    await this.transport.send(this.connection, frame);
  }
  async reply(
    pending: CommandPending,
    type: CommandServerFrame["type"],
    payload: unknown,
    signal: AbortSignal,
  ) {
    const frame = await this.frame(type, pending.frame.requestId, payload);
    signal.throwIfAborted();
    if (this.closed) throw unavailable();
    await this.transport.reply(pending, frame);
  }
  async take<K extends CommandNodeFrame["type"], T>(
    type: K,
    request: string | null,
    signal: AbortSignal,
    operation: (
      pending: CommandPending,
      frame: Extract<CommandNodeFrame, { type: K }>,
    ) => Promise<T>,
    timeoutMs = 5000,
  ): Promise<T> {
    if (this.closed || this.taking) throw unavailable();
    this.taking = true;
    let pending: CommandPending | undefined;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      if (!this.queue.length)
        await new Promise<void>((resolve, reject) => {
          const aborted = () => finish(unavailable());
          const finish = (error?: Error) => {
            bounded.removeEventListener("abort", aborted);
            this.wake = undefined;
            error ? reject(error) : resolve();
          };
          this.wake = () => finish();
          bounded.addEventListener("abort", aborted, { once: true });
          if (bounded.aborted) aborted();
        });
      bounded.throwIfAborted();
      if (this.closed) throw unavailable();
      pending = this.queue.shift();
      if (!pending) throw unavailable();
      const frame = pending.frame;
      if (
        frame.type !== type ||
        frame.nodeId !== this.binding.nodeId ||
        frame.preparationId !== this.binding.preparationId ||
        (request !== null && frame.requestId !== request)
      )
        throw new WorkConflict("command_exchange_changed");
      return await operation(pending, frame as Extract<CommandNodeFrame, { type: K }>);
    } finally {
      this.taking = false;
      if (pending) this.complete(pending);
    }
  }
}
