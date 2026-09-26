import {
  type BrowserCommand,
  type BrowserResult,
  browserResultSchema,
  protocolVersion,
} from "@openbot/protocol";
import type { ComputerProvider } from "@openbot/provider-sdk";

/** Request IDs are consumed before execution, including failed/uncertain operations. */
export class BrowserCommandHost {
  readonly #seen = new Map<string, number>();
  readonly #active = new Map<string, AbortController>();
  constructor(
    readonly nodeId: string,
    readonly providers: ComputerProvider[],
  ) {}

  async execute(command: BrowserCommand): Promise<BrowserResult> {
    const response = {
      type: "browser.result" as const,
      protocolVersion,
      nodeId: this.nodeId,
      requestId: command.requestId,
      sessionId: command.sessionId,
    };
    const deadline = Date.parse(command.expiresAt);
    for (const [id, expiry] of this.#seen) if (expiry <= Date.now()) this.#seen.delete(id);
    if (
      command.nodeId !== this.nodeId ||
      deadline <= Date.now() ||
      deadline > Date.now() + 35_000 ||
      this.#seen.has(command.requestId)
    ) {
      return { ...response, ok: false, error: "expired" };
    }
    if (this.#seen.size >= 1024 || this.#active.size >= 16)
      return { ...response, ok: false, error: "busy" };
    this.#seen.set(command.requestId, deadline);
    const provider = this.providers.find(
      (item) =>
        item.id === "docker" &&
        item.browser !== undefined &&
        item.capabilityManifest.some(
          (cap) => cap.id === "browser.session" && cap.version === 1 && cap.providerId === "docker",
        ),
    );
    if (!provider?.browser) return { ...response, ok: false, error: "unavailable" };
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    this.#active.set(command.requestId, controller);
    try {
      if (command.action.kind === "agent") {
        if (
          !provider.browserTask ||
          !provider.capabilityManifest.some(
            (cap) => cap.id === "browser.page" && cap.version === 1 && cap.providerId === "docker",
          )
        )
          return { ...response, ok: false, error: "unavailable" };
        const result = await provider.browserTask(command, signal);
        signal.throwIfAborted();
        return browserResultSchema.parse({ ...response, ok: true, ...result });
      }
      const frame = await provider.browser(command, signal);
      signal.throwIfAborted();
      return browserResultSchema.parse({ ...response, ok: true, frame });
    } catch {
      // Upstream errors may contain typed content or account URLs. Never relay them verbatim.
      return { ...response, ok: false, error: signal.aborted ? "expired" : "action_failed" };
    } finally {
      this.#active.delete(command.requestId);
    }
  }

  disconnect(): void {
    for (const controller of this.#active.values()) controller.abort();
    // Provider control latches intentionally survive reconnect. Expiry never resumes Agent input.
  }
}
