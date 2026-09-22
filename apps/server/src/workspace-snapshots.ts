import { randomUUID } from "node:crypto";
import type { WorkspaceSnapshot, WorkspaceSnapshotFrame } from "@openbot/domain";

export const maximumWorkspaceSnapshotStreams = 16;
export const maximumWorkspaceSnapshotBytes = 2 * 1024 * 1024;

interface SnapshotStream {
  read(signal: AbortSignal): Promise<WorkspaceSnapshot>;
  subscribe(invalidate: () => void): () => void;
  write(frame: WorkspaceSnapshotFrame): Promise<void>;
  abort(): void;
  signal: AbortSignal;
}

/** No event backlog: changes only invalidate the next complete authoritative read. */
export async function streamWorkspaceSnapshots(options: SnapshotStream): Promise<void> {
  const streamId = randomUUID();
  let sequence = 0;
  let dirty = true;
  let stopped = options.signal.aborted;
  let wake: (() => void) | undefined;
  let lastRead = Number.NEGATIVE_INFINITY;
  const stop = () => {
    stopped = true;
    wake?.();
    unsubscribe();
  };
  const unsubscribe = options.subscribe(() => {
    dirty = true;
    wake?.();
  });
  options.signal.addEventListener("abort", stop, { once: true });
  // Reconnect rechecks the session and discards all connection-local ordering state.
  const lifetime = setTimeout(() => options.abort(), 5 * 60_000);
  try {
    while (!stopped) {
      const delay = lastRead + (dirty ? 1000 : 15_000) - Date.now();
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resume, delay);
          function resume() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = resume;
        });
        continue;
      }
      dirty = false;
      lastRead = Date.now();
      const snapshot = await options.read(options.signal);
      if (stopped) break;
      const frame: WorkspaceSnapshotFrame = {
        type: "workspace.snapshot",
        version: 1,
        streamId,
        sequence: ++sequence,
        snapshot,
      };
      if (Buffer.byteLength(JSON.stringify(frame)) > maximumWorkspaceSnapshotBytes) {
        options.abort();
        break;
      }
      // Hono awaits writer backpressure. Close a stalled consumer instead of retaining
      // snapshots or launching additional reads while its previous write is pending.
      const deadline = setTimeout(() => options.abort(), 5000);
      try {
        await options.write(frame);
      } finally {
        clearTimeout(deadline);
      }
    }
  } finally {
    clearTimeout(lifetime);
    stop();
    options.signal.removeEventListener("abort", stop);
  }
}
