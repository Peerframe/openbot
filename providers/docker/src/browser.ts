import { type BrowserCommand, type BrowserFrame, browserFrameSchema } from "@openbot/protocol";

type Request = (
  botId: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
) => Promise<unknown>;

/** The local latch is enforcement, not authority. Only Server-issued commands reach this adapter. */
export class BrowserCoordinator {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #control = new Map<string, { sessionId: string; expiresAt: number }>();
  readonly #generations = new Map<string, symbol>();

  constructor(
    readonly request: Request,
    readonly checkUrl: (url: string) => Promise<void>,
  ) {}

  async run<T>(
    botId: string,
    signal: AbortSignal,
    operation: (generation: symbol) => Promise<T>,
  ): Promise<T> {
    return this.#serial(botId, async () => {
      signal.throwIfAborted();
      // An expired human session remains paused until an Owner explicitly takes and returns it.
      if (this.#control.has(botId)) throw new Error("Browser is paused for human control.");
      let generation = this.#generations.get(botId);
      if (generation === undefined) {
        generation = Symbol();
        this.#generations.set(botId, generation);
      }
      return operation(generation);
    });
  }

  async resume<T>(
    botId: string,
    signal: AbortSignal,
    generation: symbol,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.run(botId, signal, async (current) => {
      if (current !== generation)
        throw new Error("Browser control changed; submit a new task for review.");
      return operation();
    });
  }

  async command(command: BrowserCommand, signal: AbortSignal): Promise<BrowserFrame> {
    if (command.action.kind === "agent") throw new Error("Work browser composition required.");
    return this.#serial(command.botId, async () => {
      signal.throwIfAborted();
      if (Date.parse(command.expiresAt) <= Date.now()) throw new Error("Expired browser command.");
      const { botId, sessionId, action } = command;
      if (action.kind === "agent") throw new Error("Work browser composition required.");
      const call = (path: string, body?: unknown, requestSignal = signal) =>
        this.request(botId, path, requestSignal, body);
      const held = this.#control.get(botId);
      const leaseExpiry =
        command.controlExpiresAt === undefined ? 0 : Date.parse(command.controlExpiresAt);
      const validLease = leaseExpiry > Date.now() && leaseExpiry <= Date.now() + 35_000;
      if (action.kind === "take") {
        if (!validLease) throw new Error("Missing control lease.");
        if (held && held.expiresAt > Date.now() && held.sessionId !== sessionId)
          throw new Error("Browser is controlled by another session.");
        // Invalidate pending reviews before dispatch, even if takeover's result is unknown.
        // Explicit release removes the pause but never revives this previous generation.
        this.#generations.set(botId, Symbol());
        // Reserve before the side effect; an uncertain backend result must remain paused.
        this.#control.set(botId, { sessionId, expiresAt: leaseExpiry });
        await call("/control/take", {});
      } else if (action.kind !== "observe") {
        if (!held || held.sessionId !== sessionId || held.expiresAt <= Date.now() || !validLease) {
          throw new Error("Take control before browser input.");
        }
        held.expiresAt = leaseExpiry;
        if (action.kind === "release") {
          await call("/control/release", {});
          // Keep the local pause until the release result and screenshot are confirmed.
        } else if (action.kind === "navigate") {
          await this.checkUrl(action.url);
          signal.throwIfAborted();
          // Upstream navigation is a Bot endpoint. Keep the local exclusive latch throughout this
          // short transition so no Run can slip into the upstream's temporary Bot-holder state.
          try {
            await call("/control/release", {});
            await call("/navigate", { url: action.url });
          } finally {
            await call("/control/take", {}, AbortSignal.timeout(5000));
          }
        } else {
          const { kind, ...body } = action;
          await call(`/human/${kind}`, body);
        }
      } else if (held?.sessionId === sessionId && held.expiresAt > Date.now() && validLease) {
        held.expiresAt = leaseExpiry;
      }
      const raw = await call("/screenshot");
      const frame = browserFrameSchema.parse(raw);
      const bytes = Buffer.from(frame.base64, "base64");
      if (
        bytes.length < 24 ||
        bytes.length > 5 * 1024 * 1024 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(16) !== frame.width ||
        bytes.readUInt32BE(20) !== frame.height
      ) {
        throw new Error("Invalid browser frame.");
      }
      signal.throwIfAborted();
      if (action.kind === "release") this.#control.delete(botId);
      return frame;
    });
  }

  async #serial<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(botId);
    const current = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.#tails.set(botId, current);
    try {
      return await current;
    } finally {
      if (this.#tails.get(botId) === current) this.#tails.delete(botId);
    }
  }
}
