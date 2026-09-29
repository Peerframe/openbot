export type RealtimeConnectionState = "connecting" | "live" | "retrying";
export type EventStreamSession = {
  /** Records valid activity; false if the stream is no longer active afterwards. */
  markLive(): boolean;
  isActive(): boolean;
};
export type OpenEventStreamOptions = {
  readonly url: string;
  onState(state: RealtimeConnectionState): void;
  bind(source: EventSource, session: EventStreamSession): void;
};
const RECONNECT_DELAY_MS = 2_000;
const STALE_AFTER_MS = 35_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/**
 * Owns one subscription's EventSource: source, reconnect timer, watchdog,
 * generation, and cleanup. Callers own parsing, validation, and onReady.
 */
export function openEventStream(options: OpenEventStreamOptions): () => void {
  let source: EventSource | undefined;
  let reconnectTimer: number | undefined;
  let watchdogTimer: number | undefined;
  let disposed = false;
  let generation = 0;
  let lastActivityAt = Date.now();
  const isCurrent = (expected: number, candidate: EventSource): boolean =>
    !disposed && generation === expected && source === candidate;
  const detachSource = (): void => {
    const current = source;
    source = undefined;
    generation += 1;
    if (!current) return;
    current.onopen = null;
    current.onerror = null;
    current.close();
  };
  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== undefined) return;
    detachSource();
    options.onState("retrying");
    if (disposed || reconnectTimer !== undefined || source !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, RECONNECT_DELAY_MS);
  };
  const connect = (): void => {
    if (disposed || source !== undefined) return;
    const nextSource = new EventSource(options.url);
    generation += 1;
    const expected = generation;
    source = nextSource;
    lastActivityAt = Date.now();
    const session: EventStreamSession = {
      isActive: () => isCurrent(expected, nextSource),
      markLive: () => {
        if (!isCurrent(expected, nextSource)) return false;
        lastActivityAt = Date.now();
        options.onState("live");
        return isCurrent(expected, nextSource);
      },
    };
    nextSource.onopen = () => {
      session.markLive();
    };
    nextSource.onerror = () => {
      if (!isCurrent(expected, nextSource)) return;
      scheduleReconnect();
    };
    options.bind(nextSource, session);
  };
  options.onState("connecting");
  connect();
  if (!disposed) {
    watchdogTimer = window.setInterval(() => {
      if (disposed || source === undefined) return;
      if (Date.now() - lastActivityAt > STALE_AFTER_MS) scheduleReconnect();
    }, WATCHDOG_INTERVAL_MS);
  }
  return () => {
    if (disposed) return;
    disposed = true;
    detachSource();
    if (watchdogTimer !== undefined) {
      window.clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };
}
