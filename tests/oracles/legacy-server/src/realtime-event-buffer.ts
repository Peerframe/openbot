/**
 * A per-subscriber buffer for realtime projections.
 *
 * The buffer fails closed on overflow: callers must terminate the stream and
 * rebuild state from an authoritative snapshot instead of silently dropping
 * or reordering control-plane events.
 */
export class RealtimeEventBuffer<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  #overflowed = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Realtime event buffer capacity must be a positive safe integer.");
    }
    this.#capacity = capacity;
  }

  enqueue(event: T): boolean {
    if (this.#overflowed) return false;
    if (this.#items.length >= this.#capacity) {
      this.#overflowed = true;
      this.#items.length = 0;
      return false;
    }
    this.#items.push(event);
    return true;
  }

  dequeue(): T | undefined {
    return this.#items.shift();
  }

  get empty(): boolean {
    return this.#items.length === 0;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }
}
