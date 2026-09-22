import type { WorkspaceSnapshot, WorkspaceSnapshotFrame } from "@openbot/domain";
import type { RealtimeConnectionState } from "./api";

const MAXIMUM_FRAME_BYTES = 2 * 1024 * 1024;

/** Sequence belongs to one connection; it is never compared with GET or legacy events. */
export function subscribeToWorkspaceSnapshots(handlers: {
  onSnapshot(snapshot: WorkspaceSnapshot): void;
  onState(state: RealtimeConnectionState): void;
  onError(message: string): void;
}): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const reconnect = () => {
    if (closed) return;
    clearTimer();
    source?.close();
    source = undefined;
    handlers.onState("retrying");
    timer = setTimeout(connect, 2000);
  };
  const watch = () => {
    clearTimer();
    timer = setTimeout(reconnect, 35_000);
  };
  function connect() {
    if (closed) return;
    clearTimer();
    const current = new EventSource("/api/v1/workspace/snapshots");
    source = current;
    let streamId: string | undefined;
    let sequence = 0;
    const ownsConnection = () => !closed && source === current;
    // Opening headers alone is not evidence that the displayed snapshot is current.
    watch();
    current.onerror = () => {
      if (ownsConnection()) reconnect();
    };
    current.addEventListener("workspace.snapshot", (event) => {
      if (!ownsConnection()) return;
      const frame = parseFrame(event);
      if (!frame || (streamId !== undefined && streamId !== frame.streamId)) {
        closed = true;
        clearTimer();
        current.close();
        handlers.onState("retrying");
        handlers.onError("工作区快照格式不兼容，请刷新或更新客户端。");
        return;
      }
      if (frame.sequence <= sequence) return;
      streamId = frame.streamId;
      sequence = frame.sequence;
      handlers.onSnapshot(frame.snapshot);
      // A projection callback may dispose this subscription synchronously.
      if (!ownsConnection()) return;
      handlers.onState("live");
      watch();
    });
  }
  handlers.onState("connecting");
  connect();
  return () => {
    closed = true;
    clearTimer();
    source?.close();
    source = undefined;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(event: Event): WorkspaceSnapshotFrame | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
  // Check string length before allocating the UTF-8 buffer. Limits match the Server contract.
  if (event.data.length > MAXIMUM_FRAME_BYTES) return;
  if (new TextEncoder().encode(event.data).byteLength > MAXIMUM_FRAME_BYTES) return;
  try {
    const frame: unknown = JSON.parse(event.data);
    if (
      !record(frame) ||
      frame.type !== "workspace.snapshot" ||
      frame.version !== 1 ||
      typeof frame.streamId !== "string" ||
      frame.streamId.length === 0 ||
      frame.streamId.length > 64 ||
      !Number.isSafeInteger(frame.sequence) ||
      (frame.sequence as number) < 1 ||
      !record(frame.snapshot)
    )
      return;
    const snapshot = frame.snapshot;
    if (
      !record(snapshot.counts) ||
      !["channels", "bots", "connectedNodes", "activeRuns"].every((key) => {
        const count = (snapshot.counts as Record<string, unknown>)[key];
        return Number.isSafeInteger(count) && (count as number) >= 0;
      }) ||
      !["channels", "bots", "nodes", "runs", "approvals", "artifacts", "progress"].every(
        (key) =>
          Array.isArray(snapshot[key]) &&
          snapshot[key].every((item: unknown) => record(item) && typeof item.id === "string"),
      ) ||
      (snapshot.runs as unknown[]).length > 50 ||
      (snapshot.approvals as unknown[]).length > 100 ||
      (snapshot.artifacts as unknown[]).length > 100 ||
      (snapshot.progress as unknown[]).length > 200
    )
      return;
    return frame as unknown as WorkspaceSnapshotFrame;
  } catch {
    return;
  }
}
