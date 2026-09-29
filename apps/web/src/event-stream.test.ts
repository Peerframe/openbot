// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RealtimeConnectionState,
  subscribeToChannelEvents,
  subscribeToWorkspaceEvents,
} from "./api";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  /** Delivers even after close, to simulate queued callbacks. */
  emit(type: string, payload?: unknown): void {
    const data = payload === undefined ? "" : JSON.stringify(payload);
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.onopen?.(new Event("open"));
  }
  error(): void {
    this.onerror?.(new Event("error"));
  }
}
const sources = (): FakeEventSource[] => FakeEventSource.instances;
function sourceAt(index: number): FakeEventSource {
  const source = sources()[index];
  if (!source) throw new Error(`Missing EventSource ${index}`);
  return source;
}
function capture(callback: ((event: Event) => void) | null): (event: Event) => void {
  if (!callback) throw new Error("Missing active EventSource callback");
  return callback;
}
const channelUpdated = (channelId: string) => ({
  type: "channel.updated",
  channelId,
  channel: { id: channelId, botIds: [] },
});
function channelHandlers(states: RealtimeConnectionState[]) {
  return {
    onMessage: vi.fn(),
    onFrame: vi.fn(),
    onProgress: vi.fn(),
    onOutput: vi.fn(),
    onReactions: vi.fn(),
    onChannel: vi.fn(),
    onRun: vi.fn(),
    onReady: vi.fn(),
    onState: vi.fn((state: RealtimeConnectionState) => {
      states.push(state);
    }),
  };
}
const retries = (states: RealtimeConnectionState[]): number =>
  states.filter((state) => state === "retrying").length;
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("realtime subscriptions", () => {
  it("keeps channel and workspace streams independent", () => {
    const channelStates: RealtimeConnectionState[] = [];
    const workspaceStates: RealtimeConnectionState[] = [];
    const onReady = vi.fn();
    subscribeToChannelEvents("c1", channelHandlers(channelStates));
    const stopWorkspace = subscribeToWorkspaceEvents({
      onApproval: vi.fn(),
      onEmployeeProfileChanged: vi.fn(),
      onNode: vi.fn(),
      onNodeRemoved: vi.fn(),
      onReady,
      onRun: vi.fn(),
      onState: (state) => workspaceStates.push(state),
    });
    expect(sources().map((source) => source.url)).toEqual([
      "/api/v1/channels/c1/events",
      "/api/v1/workspace/events",
    ]);
    sourceAt(0).error();
    expect(retries(channelStates)).toBe(1);
    expect(retries(workspaceStates)).toBe(0);
    sourceAt(1).emit("workspace.ready", { type: "workspace.ready", nodes: [] });
    expect(onReady).toHaveBeenCalledWith([]);
    stopWorkspace();
    expect(sourceAt(1).closed).toBe(true);
  });
  it("reconnects only after strictly more than 35000ms without activity", () => {
    const states: RealtimeConnectionState[] = [];
    subscribeToChannelEvents("c1", channelHandlers(states));
    vi.advanceTimersByTime(35_000);
    expect(retries(states)).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(retries(states)).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(sources()).toHaveLength(2);
  });
  it("heartbeat refreshes activity", () => {
    const states: RealtimeConnectionState[] = [];
    subscribeToChannelEvents("c1", channelHandlers(states));
    vi.advanceTimersByTime(30_000);
    sourceAt(0).emit("heartbeat");
    vi.advanceTimersByTime(10_000);
    expect(retries(states)).toBe(0);
    expect(states).toContain("live");
  });
  it("coalesces duplicate errors into one reconnect", () => {
    const states: RealtimeConnectionState[] = [];
    subscribeToChannelEvents("c1", channelHandlers(states));
    sourceAt(0).error();
    sourceAt(0).error();
    expect(retries(states)).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(sources()).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    expect(sources()).toHaveLength(2);
  });
  it("disposal inside retrying onState leaves no reconnect", () => {
    let stop = (): void => undefined;
    const handlers = channelHandlers([]);
    handlers.onState.mockImplementation((state) => {
      if (state === "retrying") stop();
    });
    stop = subscribeToChannelEvents("c1", handlers);
    sourceAt(0).error();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sources()).toHaveLength(1);
  });
  it("disposal inside live onState stops the payload delivery", () => {
    let stop = (): void => undefined;
    const handlers = channelHandlers([]);
    handlers.onState.mockImplementation((state) => {
      if (state === "live") stop();
    });
    stop = subscribeToChannelEvents("c1", handlers);
    sourceAt(0).emit("channel.updated", channelUpdated("c1"));
    expect(handlers.onChannel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores callbacks from a replaced source", () => {
    const handlers = channelHandlers([]);
    subscribeToChannelEvents("c1", handlers);
    const first = sourceAt(0);
    first.error();
    vi.advanceTimersByTime(2_000);
    first.emit("channel.ready");
    first.emit("channel.updated", channelUpdated("c1"));
    first.open();
    expect(handlers.onReady).not.toHaveBeenCalled();
    expect(handlers.onChannel).not.toHaveBeenCalled();
    sourceAt(1).emit("channel.ready");
    expect(handlers.onReady).toHaveBeenCalledTimes(1);
  });
  it("wrong-channel and invalid payloads do not count as activity", () => {
    const states: RealtimeConnectionState[] = [];
    const handlers = channelHandlers(states);
    subscribeToChannelEvents("c1", handlers);
    vi.advanceTimersByTime(30_000);
    sourceAt(0).emit("channel.updated", channelUpdated("c2"));
    sourceAt(0).emit("channel.updated", { type: "channel.updated" });
    vi.advanceTimersByTime(10_000);
    expect(handlers.onChannel).not.toHaveBeenCalled();
    expect(states).not.toContain("live");
    expect(retries(states)).toBe(1);
  });
});

// Exercise the public consumers independently of the Worker's helper implementation.
function consumer(kind: "channel" | "workspace") {
  const states: RealtimeConnectionState[] = [];
  const handlers = {
    ...channelHandlers(states),
    onApproval: vi.fn(),
    onEmployeeProfileChanged: vi.fn(),
    onNode: vi.fn(),
    onNodeRemoved: vi.fn(),
  };
  const stop =
    kind === "channel"
      ? subscribeToChannelEvents("c1", handlers)
      : subscribeToWorkspaceEvents(handlers);
  const ready = (source: FakeEventSource) =>
    kind === "channel"
      ? source.emit("channel.ready")
      : source.emit("workspace.ready", { type: "workspace.ready", nodes: [] });
  return { states, handlers, stop, ready };
}

describe.each(["channel", "workspace"] as const)("%s independent consumer acceptance", (kind) => {
  it("preserves callback receiver and live-before-ready ordering", () => {
    const { states, handlers, stop, ready } = consumer(kind);
    expect(states).toEqual(["connecting"]);
    handlers.onState.mockImplementation(function (this: typeof handlers, state) {
      expect(this).toBe(handlers);
      states.push(state);
    });
    handlers.onReady.mockImplementation(() => expect(states.at(-1)).toBe("live"));
    sourceAt(0).open();
    ready(sourceAt(0));
    expect(handlers.onReady).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects queued callbacks before and after replacement and after disposal", () => {
    const { states, handlers, stop, ready } = consumer(kind);
    const old = sourceAt(0);
    const queuedOpen = capture(old.onopen);
    const queuedError = capture(old.onerror);
    old.error();
    const afterError = [...states];
    queuedOpen(new Event("open"));
    queuedError(new Event("error"));
    old.emit("heartbeat");
    ready(old);
    expect(states).toEqual(afterError);
    expect(handlers.onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_999);
    expect(sources()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources()).toHaveLength(2);
    queuedOpen(new Event("open"));
    queuedError(new Event("error"));
    ready(old);
    expect(states).toEqual(afterError);
    const current = sourceAt(1);
    const currentOpen = capture(current.onopen);
    const currentError = capture(current.onerror);
    stop();
    stop();
    currentOpen(new Event("open"));
    currentError(new Event("error"));
    current.emit("heartbeat");
    ready(current);
    vi.advanceTimersByTime(60_000);
    expect(states).toEqual(afterError);
    expect(handlers.onReady).not.toHaveBeenCalled();
    expect(sources()).toHaveLength(2);
    expect(sources().every((source) => source.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "retrying"])(
    "cancels reentrantly during %s without delivery or reconnect",
    (phase) => {
      const { handlers, stop, ready } = consumer(kind);
      handlers.onState.mockImplementation((state) => {
        if (state === phase) stop();
      });
      if (phase === "live") ready(sourceAt(0));
      else sourceAt(0).error();
      expect(handlers.onReady).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(sources()).toHaveLength(1);
      expect(sourceAt(0).closed).toBe(true);
    },
  );

  it("does not deliver ready when onState replaces the active connection", () => {
    const { handlers, stop, ready } = consumer(kind);
    let once = true;
    handlers.onState.mockImplementation((state) => {
      if (state === "live" && once) {
        once = false;
        sourceAt(0).error();
      }
    });
    ready(sourceAt(0));
    expect(handlers.onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    ready(sourceAt(1));
    expect(handlers.onReady).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("rejects malformed workspace ready without refreshing its inactivity deadline", () => {
  const { states, handlers, stop } = consumer("workspace");
  vi.advanceTimersByTime(30_000);
  sourceAt(0).emit("workspace.ready", { type: "workspace.ready", nodes: [{}] });
  sourceAt(0).emit("workspace.ready", { type: "unexpected", nodes: [] });
  vi.advanceTimersByTime(5_000);
  expect(retries(states)).toBe(0);
  vi.advanceTimersByTime(5_000);
  expect(retries(states)).toBe(1);
  expect(handlers.onReady).not.toHaveBeenCalled();
  expect(states).not.toContain("live");
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
