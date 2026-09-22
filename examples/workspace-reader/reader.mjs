/** Framework-free read-only consumer of the documented v1 snapshot contract. */
export function subscribeWorkspace({
  onSnapshot,
  onState,
  EventSourceImpl = globalThis.EventSource,
  timers = { set: (callback, delay) => setTimeout(callback, delay), clear: (id) => clearTimeout(id) },
}) {
  let closed = false;
  let current;
  let timer;
  function connect() {
    if (closed) return;
    const source = new EventSourceImpl("/api/v1/workspace/snapshots");
    current = source;
    const markLive = () => {
      timers.clear(timer);
      timer = timers.set(() => {
        if (closed || current !== source) return;
        current = undefined;
        source.close();
        onState("stale");
        timer = timers.set(connect, 2000);
      }, 35_000);
    };
    markLive();
    let streamId;
    let sequence = 0;
    source.onopen = () => {
      if (closed || current !== source) return;
      streamId = undefined;
      sequence = 0;
      onState("synchronizing");
    };
    source.onerror = () => {
      if (!closed && current === source) onState("stale");
    };
    source.addEventListener("workspace.snapshot", (event) => {
      if (closed || current !== source) return;
      try {
        const frame = JSON.parse(event.data);
        if (
          frame.version !== 1 ||
          frame.type !== "workspace.snapshot" ||
          typeof frame.streamId !== "string" ||
          frame.streamId.length > 64 ||
          !Number.isSafeInteger(frame.sequence) ||
          frame.sequence < 1 ||
          !frame.snapshot ||
          !frame.snapshot.counts ||
          !["channels", "bots", "nodes", "runs", "approvals", "artifacts", "progress"].every(
            (key) => Array.isArray(frame.snapshot[key]),
          ) ||
          !["channels", "bots", "connectedNodes", "activeRuns"].every(
            (key) =>
              Number.isSafeInteger(frame.snapshot.counts[key]) && frame.snapshot.counts[key] >= 0,
          )
        ) {
          throw new Error("unsupported_workspace_contract");
        }
        if (streamId !== undefined && frame.streamId !== streamId)
          throw new Error("unexpected_stream");
        if (frame.sequence <= sequence) return;
        streamId = frame.streamId;
        sequence = frame.sequence;
        onSnapshot(frame.snapshot);
        onState("current");
        markLive();
      } catch {
        closed = true;
        timers.clear(timer);
        source.close();
        onState("incompatible");
      }
    });
  }
  connect();
  return () => {
    closed = true;
    timers.clear(timer);
    current?.close();
  };
}
