/** Binds command protocol frames to the enrolled Worker connection. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type CommandNodeFrame,
  type CommandServerFrame,
  parseCommandFrame,
} from "@openbot/protocol";
import type { RuntimeBinding } from "./worker-runtime-contracts.js";

const failure = () => new Error("command_channel_unavailable");
export type CommandHandle = Readonly<{ live: Readonly<RuntimeBinding> }>;
export type CommandPending = Readonly<{ connection: CommandHandle; frame: CommandNodeFrame }>;
export type CommandNotifications = {
  frame: (pending: CommandPending) => boolean;
  connected?: (connection: CommandHandle) => void;
  disconnected?: (connection: CommandHandle) => void;
};
type Endpoint = {
  binding: RuntimeBinding;
  current: () => boolean;
  send: (wire: string, check: () => void) => Promise<void>;
  close: () => void;
  guard: <T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
};
type Item = { size: number; expires: number | null; timer: NodeJS.Timeout | null };
type Live = {
  handle: CommandHandle;
  endpoint: Endpoint;
  closed: boolean;
  items: Map<object, Item>;
  pending: Map<CommandPending, CommandNodeFrame>;
  replied: Set<CommandPending>;
  bytes: number;
};
/** Bounded correlation only. Opaque membership preserves the original socket, while SQL services
 * own preparation, admission, consumption and signed receipt authority. */
export class WorkerCommandChannel {
  private readonly handles = new Map<CommandHandle, Live>();
  private readonly byNode = new Map<string, CommandHandle>();
  private readonly inGuard = new AsyncLocalStorage<boolean>();
  constructor(private readonly notifications: CommandNotifications) {}
  private notify<T>(callback: ((arg: T) => unknown) | undefined, arg: T) {
    const value = callback?.(arg);
    if (value && typeof (value as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
      throw failure();
    }
    return value;
  }
  activate(endpoint: Endpoint): CommandHandle {
    const live = Object.freeze({ ...endpoint.binding }),
      handle = Object.freeze({ live });
    if (this.byNode.has(live.nodeId)) throw failure();
    const state: Live = {
      handle,
      endpoint,
      closed: false,
      items: new Map(),
      pending: new Map(),
      replied: new Set(),
      bytes: 0,
    };
    this.handles.set(handle, state);
    this.byNode.set(live.nodeId, handle);
    try {
      this.current(handle);
      this.notify(this.notifications.connected, handle);
    } catch (error) {
      this.fail(state);
      throw error;
    }
    return handle;
  }
  private current(handle: CommandHandle): Live {
    const state = this.handles.get(handle);
    if (
      !state ||
      state.closed ||
      !state.endpoint.current() ||
      this.byNode.get(handle.live.nodeId) !== handle
    )
      throw failure();
    if (
      [...state.items.values()].some(
        (item) => item.expires !== null && item.expires <= performance.now(),
      )
    ) {
      this.fail(state);
      throw failure();
    }
    return state;
  }
  connection(nodeId: string): CommandHandle {
    const handle = this.byNode.get(nodeId);
    if (!handle) throw failure();
    this.current(handle);
    return handle;
  }
  detach(handle: CommandHandle) {
    const state = this.handles.get(handle);
    if (!state) return;
    state.closed = true;
    this.handles.delete(handle);
    if (this.byNode.get(handle.live.nodeId) === handle) this.byNode.delete(handle.live.nodeId);
    for (const item of state.items.values()) if (item.timer) clearTimeout(item.timer);
    state.items.clear();
    state.pending.clear();
    state.replied.clear();
    state.bytes = 0;
    try {
      this.notify(this.notifications.disconnected, handle);
    } catch {
      /* Transport closure must not be prevented by a subscriber. */
    }
  }
  private fail(state: Live) {
    this.detach(state.handle);
    state.endpoint.close();
  }
  async guard<T>(
    handle: CommandHandle,
    signal: AbortSignal,
    operation: (live: Readonly<RuntimeBinding>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const state = this.current(handle);
    return state.endpoint.guard(signal, async (bounded) => {
      this.current(handle);
      return this.inGuard.run(true, async () => {
        const result = await operation(handle.live, bounded);
        bounded.throwIfAborted();
        this.current(handle);
        return result;
      });
    });
  }
  private reserve(state: Live, key: object, size: number, timed = false) {
    this.current(state.handle);
    if (state.items.has(key) || state.items.size >= 4 || state.bytes + size > 65536) {
      this.fail(state);
      throw failure();
    }
    const timer = timed ? setTimeout(() => this.fail(state), 5000) : null;
    timer?.unref();
    state.items.set(key, { size, expires: timed ? performance.now() + 5000 : null, timer });
    state.bytes += size;
  }
  private release(state: Live, key: object) {
    const item = state.items.get(key);
    if (!item) return;
    if (item.timer) clearTimeout(item.timer);
    state.items.delete(key);
    state.bytes -= item.size;
  }
  receive(handle: CommandHandle, frame: CommandNodeFrame, rawSize: number) {
    const state = this.current(handle);
    if (
      frame.nodeId !== handle.live.nodeId ||
      !Number.isSafeInteger(rawSize) ||
      rawSize <= 0 ||
      rawSize > 32768
    ) {
      this.fail(state);
      throw failure();
    }
    const original = structuredClone(frame),
      pending = Object.freeze({
        connection: handle,
        get frame() {
          return structuredClone(original);
        },
      });
    this.reserve(state, pending, rawSize + 4, true);
    state.pending.set(pending, original);
    try {
      if (this.notify(this.notifications.frame, pending) !== true) throw failure();
      this.current(handle);
    } catch (error) {
      this.fail(state);
      throw error;
    }
  }
  private pending(value: CommandPending) {
    const state = this.current(value.connection);
    if (!state.pending.has(value) || !state.items.has(value)) throw failure();
    return state;
  }
  complete(value: CommandPending) {
    const state = this.pending(value);
    state.pending.delete(value);
    state.replied.delete(value);
    this.release(state, value);
  }
  async reply(value: CommandPending, frame: CommandServerFrame) {
    const state = this.pending(value),
      original = state.pending.get(value)!;
    if (
      state.replied.has(value) ||
      (["nodeId", "preparationId", "requestId"] as const).some((k) => frame[k] !== original[k])
    )
      throw failure();
    state.replied.add(value);
    await this.send(value.connection, frame, value);
  }
  async send(handle: CommandHandle, input: CommandServerFrame, pending?: CommandPending) {
    // The authorization commit must finish before any wire effect. Inheriting this scope into an
    // unawaited async callback cannot bypass it; the private guard token follows the async chain.
    if (this.inGuard.getStore()) throw failure();
    const state = this.current(handle),
      frame = await parseCommandFrame(structuredClone(input), { server: true });
    if (frame.nodeId !== handle.live.nodeId) throw failure();
    const binding =
      frame.type === "work.command.prepare_open"
        ? frame.payload
        : frame.type === "work.command.control_open"
          ? frame.payload.binding
          : null;
    if (binding && binding.connectionId !== handle.live.connectionId) throw failure();
    const wire = JSON.stringify(frame),
      key = {};
    this.reserve(state, key, Buffer.byteLength(wire) + 4);
    const check = () => {
      this.current(handle);
      if (pending) this.pending(pending);
    };
    try {
      await state.endpoint.send(wire, check);
      check();
    } catch (error) {
      this.fail(state);
      throw error;
    } finally {
      this.release(state, key);
    }
  }
}
