import type { DesktopNotificationInput, DesktopNotificationResult } from "./runtime-contract.js";

// macOS truncates notification bodies near 256 bytes; CJK text is three UTF-8 bytes per unit.
export const NOTIFICATION_TITLE_LIMIT = 40;
export const NOTIFICATION_BODY_LIMIT = 80;
const NOTIFICATION_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING = 4;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export interface NativeNotification {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
  close(): void;
}

interface NotifierOptions {
  isSupported(): boolean;
  create(input: DesktopNotificationInput): NativeNotification;
  focus(): void;
  timeoutMs?: number;
}

/** Exact keys, bounded single-line text; anything else is refused before reaching the OS. */
export function parseDesktopNotification(value: unknown): DesktopNotificationInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "body" || keys[1] !== "title") return undefined;
  const { title, body } = input;
  if (typeof title !== "string" || typeof body !== "string") return undefined;
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (
    cleanTitle.length === 0 ||
    cleanTitle.length > NOTIFICATION_TITLE_LIMIT ||
    cleanBody.length > NOTIFICATION_BODY_LIMIT ||
    CONTROL.test(cleanTitle) ||
    CONTROL.test(cleanBody)
  )
    return undefined;
  return { title: cleanTitle, body: cleanBody };
}

/**
 * Shows native notifications for the trusted renderer. A click only focuses the existing window;
 * the renderer decides where to navigate. Notifications are retained until they settle so their
 * listeners stay alive, and at most four are pending: the oldest is closed to admit a new one.
 */
export class DesktopNotifier {
  readonly #options: NotifierOptions;
  readonly #pending: Array<(status: DesktopNotificationResult["status"]) => void> = [];

  constructor(options: NotifierOptions) {
    this.#options = options;
  }

  show(value: unknown): Promise<DesktopNotificationResult> {
    const input = parseDesktopNotification(value);
    if (!input) return Promise.resolve({ status: "failed" });
    let supported = false;
    try {
      supported = this.#options.isSupported();
    } catch {
      supported = false;
    }
    if (!supported) return Promise.resolve({ status: "unsupported" });
    while (this.#pending.length >= MAX_PENDING) this.#pending[0]?.("expired");

    return new Promise((resolve) => {
      let notification: NativeNotification | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (status: DesktopNotificationResult["status"]) => {
        const index = this.#pending.indexOf(settle);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        if (timer !== undefined) clearTimeout(timer);
        if (status === "expired") {
          try {
            notification?.close();
          } catch {
            // Closing is best effort; the promise is already settled.
          }
        }
        if (status === "clicked") {
          try {
            this.#options.focus();
          } catch {
            // A destroyed window cannot be focused; the renderer is gone with it.
          }
        }
        resolve({ status });
      };
      this.#pending.push(settle);
      try {
        notification = this.#options.create(input);
        notification.on("click", () => settle("clicked"));
        notification.on("close", () => settle("closed"));
        notification.on("failed", () => settle("failed"));
        timer = setTimeout(
          () => settle("expired"),
          this.#options.timeoutMs ?? NOTIFICATION_TIMEOUT_MS,
        );
        notification.show();
      } catch {
        settle("failed");
      }
    });
  }

  closeAll(): void {
    while (this.#pending.length > 0) this.#pending[0]?.("expired");
  }
}
