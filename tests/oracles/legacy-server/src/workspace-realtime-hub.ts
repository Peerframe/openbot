import type { WorkspaceRealtimeEvent } from "@openbot/domain";

type WorkspaceEventListener = (event: WorkspaceRealtimeEvent) => void;

export class WorkspaceRealtimeHub {
  readonly #listeners = new Set<WorkspaceEventListener>();

  subscribe(listener: WorkspaceEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(event: WorkspaceRealtimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
