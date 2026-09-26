import {
  type CommandNodeFrame,
  type CommandServerFrame,
  commandFrameMaxBytes,
  parseCommandFrame,
} from "@openbot/protocol";

const maxMessages = 4;
const maxQueuedBytes = 65_536;
const localIoTimeoutMs = 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export type CommandRelayCloseCode =
  | "closed"
  | "aborted"
  | "stale_connection"
  | "invalid_frame"
  | "queue_full"
  | "io_failed"
  | "io_timeout";
export class CommandRelayError extends Error {
  constructor(readonly code: CommandRelayCloseCode) {
    super(`command_relay_${code}`);
  }
}

export interface CommandRelayTransport {
  /** Local write completion only. It is never an execution or peer acknowledgement. */
  send(value: CommandServerFrame): Promise<void>;
  close(): void;
}
export interface CommandRelayInstallation {
  /** Supplied by trusted installation composition, never by a model or ambient path variable. */
  readonly selection: Readonly<{
    nodeId: string;
    providerId: string;
    enforcementKeyId: string;
    ledgerId: string;
  }>;
  openTransport(options: {
    signal: AbortSignal;
    connectionId: string;
    onMessage(value: unknown): Promise<void>;
    onClose(): void;
  }): Promise<CommandRelayTransport>;
}
export interface CommandRelayWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
}
interface Item {
  bytes: number;
  run(): Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Two finite per-direction queues; an entry stays counted while async validation/write is active. */
class DirectionQueue {
  readonly items: Item[] = [];
  bytes = 0;
  constructor(readonly fail: (code: CommandRelayCloseCode) => void) {}
  push(bytes: number, run: () => Promise<void>): Promise<void> {
    if (this.items.length >= maxMessages || this.bytes + bytes > maxQueuedBytes) {
      this.fail("queue_full");
      return Promise.reject(new CommandRelayError("queue_full"));
    }
    return new Promise<void>((resolve, reject) => {
      const item = {
        bytes,
        run,
        resolve,
        reject,
        timer: setTimeout(() => this.fail("io_timeout"), localIoTimeoutMs),
      };
      this.items.push(item);
      this.bytes += bytes;
      if (this.items.length === 1) this.next(item);
    });
  }
  next(item: Item): void {
    void Promise.resolve()
      .then(item.run)
      .then(
        () => {
          if (this.items[0] !== item) return;
          this.items.shift();
          this.bytes -= item.bytes;
          clearTimeout(item.timer);
          item.resolve();
          const next = this.items[0];
          if (next) this.next(next);
        },
        () => this.fail("io_failed"),
      );
  }
  cancel(code: CommandRelayCloseCode): void {
    for (const item of this.items.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new CommandRelayError(code));
    }
    this.bytes = 0;
  }
}

/** One enforcer transport belongs to exactly one already-authenticated captured WebSocket. */
export class CommandRelay {
  readonly #controller = new AbortController();
  readonly #toHost = new DirectionQueue((code) => this.close(code));
  readonly #toServer = new DirectionQueue((code) => this.close(code));
  readonly #ready: Promise<CommandRelayTransport>;
  readonly #selection: CommandRelayInstallation["selection"];
  #transport?: CommandRelayTransport;
  #closed?: CommandRelayCloseCode;
  #openingTimer?: ReturnType<typeof setTimeout>;
  readonly #abort = () => this.close("aborted");

  constructor(
    installation: CommandRelayInstallation,
    readonly socket: CommandRelayWebSocket,
    readonly isCurrent: () => boolean,
    readonly signal: AbortSignal,
    readonly connectionId: string,
    readonly onClosed: (code: CommandRelayCloseCode) => void = () => undefined,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(connectionId))
      throw new CommandRelayError("invalid_frame");
    this.#selection = Object.freeze({ ...installation.selection });
    signal.addEventListener("abort", this.#abort, { once: true });
    this.#ready = Promise.resolve().then(async () => {
      this.assertCurrent();
      const transport = await installation.openTransport({
        signal: this.#controller.signal,
        connectionId,
        onMessage: (value) => this.receiveHost(value),
        onClose: () => this.close("io_failed"),
      });
      if (this.#closed || signal.aborted || !isCurrent() || socket.readyState !== 1) {
        transport.close();
        this.close("stale_connection");
        throw new CommandRelayError("stale_connection");
      }
      this.#transport = transport;
      clearTimeout(this.#openingTimer);
      return transport;
    });
    this.#openingTimer = setTimeout(() => this.close("io_timeout"), localIoTimeoutMs);
    void this.#ready.catch(() => this.close("io_failed"));
    if (signal.aborted) this.close("aborted");
  }

  /** Snapshot bounded original WS bytes before any asynchronous parser or transport callback. */
  receiveServer(raw: Uint8Array): Promise<void> {
    try {
      this.assertCurrent();
      if (
        !(raw instanceof Uint8Array) ||
        raw.byteLength < 1 ||
        raw.byteLength > commandFrameMaxBytes
      )
        throw new CommandRelayError("invalid_frame");
      const snapshot = new Uint8Array(raw);
      return this.#toHost.push(snapshot.byteLength + 4, async () => {
        this.assertCurrent();
        let frame: CommandServerFrame;
        try {
          frame = await parseCommandFrame(JSON.parse(decoder.decode(snapshot)), { server: true });
        } catch {
          this.close("invalid_frame");
          throw new CommandRelayError("invalid_frame");
        }
        this.checkSelection(frame);
        const transport = await this.wait(this.#ready);
        this.assertCurrent();
        await this.wait(transport.send(frame));
        this.assertCurrent();
      });
    } catch (error) {
      return this.reject(error);
    }
  }

  private receiveHost(value: unknown): Promise<void> {
    try {
      this.assertCurrent();
      // The injected transport must already enforce plain JSON/UTF8/32KiB and no custom serializers.
      // Re-encode synchronously so a later transport mutation cannot alter the queued observation.
      const json = JSON.stringify(value);
      if (typeof json !== "string") throw new CommandRelayError("invalid_frame");
      const size = encoder.encode(json).length;
      if (size < 1 || size > commandFrameMaxBytes) throw new CommandRelayError("invalid_frame");
      const snapshot: unknown = JSON.parse(json);
      return this.#toServer.push(size + 4, async () => {
        this.assertCurrent();
        let frame: CommandNodeFrame;
        try {
          frame = await parseCommandFrame(snapshot, { server: false });
        } catch {
          this.close("invalid_frame");
          throw new CommandRelayError("invalid_frame");
        }
        this.checkSelection(frame);
        this.assertCurrent();
        const output = JSON.stringify(frame);
        if (
          !Number.isSafeInteger(this.socket.bufferedAmount) ||
          this.socket.bufferedAmount < 0 ||
          this.socket.bufferedAmount + encoder.encode(output).length > maxQueuedBytes
        ) {
          this.close("queue_full");
          throw new CommandRelayError("queue_full");
        }
        await this.wait(
          new Promise<void>((resolve, reject) => {
            // Check in the same synchronous turn as dispatch, against the captured socket only.
            this.assertCurrent();
            this.socket.send(output, (error) =>
              error ? reject(new CommandRelayError("io_failed")) : resolve(),
            );
          }),
        );
        this.assertCurrent();
      });
    } catch (error) {
      return this.reject(error);
    }
  }

  private checkSelection(frame: CommandServerFrame | CommandNodeFrame): void {
    let selection: CommandRelayInstallation["selection"] | undefined;
    if (frame.type === "work.command.prepare_open") selection = frame.payload;
    if (frame.type === "work.command.control_open") selection = frame.payload.binding;
    if (frame.type === "work.command.dispatch") selection = frame.payload.operation.route;
    if (
      (frame.type === "work.command.prepare_open" &&
        frame.payload.connectionId !== this.connectionId) ||
      (frame.type === "work.command.control_open" &&
        frame.payload.binding.connectionId !== this.connectionId) ||
      frame.nodeId !== this.#selection.nodeId ||
      (selection &&
        (Object.keys(this.#selection) as (keyof typeof selection)[]).some(
          (key) => selection?.[key] !== this.#selection[key],
        ))
    ) {
      this.close("invalid_frame");
      throw new CommandRelayError("invalid_frame");
    }
  }
  private assertCurrent(): void {
    if (this.#closed) throw new CommandRelayError(this.#closed);
    if (this.signal.aborted) {
      this.close("aborted");
      throw new CommandRelayError("aborted");
    }
    if (!this.isCurrent() || this.socket.readyState !== 1) {
      this.close("stale_connection");
      throw new CommandRelayError("stale_connection");
    }
  }
  private reject(error: unknown): Promise<never> {
    const code = error instanceof CommandRelayError ? error.code : "invalid_frame";
    this.close(code);
    return Promise.reject(new CommandRelayError(code));
  }
  private wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = this.#controller.signal;
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(new CommandRelayError(this.#closed ?? "aborted"));
      };
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      void operation.then(
        (value) => {
          signal.removeEventListener("abort", aborted);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", aborted);
          reject(new CommandRelayError("io_failed"));
        },
      );
    });
  }
  close(code: CommandRelayCloseCode = "closed"): void {
    if (this.#closed) return;
    this.#closed = code;
    clearTimeout(this.#openingTimer);
    this.signal.removeEventListener("abort", this.#abort);
    this.#controller.abort();
    this.#toHost.cancel(code);
    this.#toServer.cancel(code);
    try {
      this.#transport?.close();
    } catch {
      /* The captured transport remains closed/unknown; no retry. */
    }
    try {
      this.onClosed(code);
    } catch {
      /* Diagnostics never reopen a connection. */
    }
  }
}
