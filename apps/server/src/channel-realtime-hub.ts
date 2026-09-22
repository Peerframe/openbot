import type { ChannelRealtimeEvent } from "@openbot/domain";

type ChannelEventListener = (event: ChannelRealtimeEvent) => void;

export class ChannelRealtimeHub {
  readonly #listeners = new Map<string, Set<ChannelEventListener>>();
  readonly #observers = new Set<() => void>();

  /** Internal content-free invalidation; consumers must read authorized Server state. */
  observe(listener: () => void): () => void {
    this.#observers.add(listener);
    return () => this.#observers.delete(listener);
  }

  subscribe(channelId: string, listener: ChannelEventListener): () => void {
    const listeners = this.#listeners.get(channelId) ?? new Set<ChannelEventListener>();
    listeners.add(listener);
    this.#listeners.set(channelId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(channelId);
    };
  }

  publish(event: ChannelRealtimeEvent): void {
    for (const observer of this.#observers) observer();
    for (const listener of this.#listeners.get(event.channelId) ?? []) {
      listener(event);
    }
  }
}
