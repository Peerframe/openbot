import { setTimeout as delay } from "node:timers/promises";
import type { Downloader, FetchDownloaderOptions } from "@electron/get";
import { FetchDownloader, HTTPError } from "@electron/get";

type ElectronDownloadSleep = (
  milliseconds: number,
  value: undefined,
  options: { signal?: AbortSignal | undefined },
) => Promise<unknown>;

type ElectronDownloaderPorts = {
  readonly downloader?: Downloader<FetchDownloaderOptions>;
  readonly sleep?: ElectronDownloadSleep;
  readonly warn?: (message: string) => void;
};

type ElectronDownloader = {
  download(url: string, targetFilePath: string, options?: FetchDownloaderOptions): Promise<void>;
};

const transientStatuses: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const maximumAttempts = 3;
const attemptTimeoutMs = 5 * 60 * 1_000;
const maximumRetryAfterMs = 30_000;

function isTransient(error: unknown): boolean {
  if (error instanceof HTTPError) return transientStatuses.has(error.response.status);
  for (let cause = error, depth = 0; cause && depth < 4; depth += 1) {
    if (typeof cause !== "object" && typeof cause !== "function") return false;
    if ("code" in cause && typeof cause.code === "string" && transientCodes.has(cause.code))
      return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

/** Milliseconds to wait, or null when the server asks for longer than the cap. */
function retryDelay(error: unknown, attempt: number): number | null {
  const value = error instanceof HTTPError ? error.response.headers.get("retry-after") : null;
  if (value === null) return 1_000 * 2 ** attempt;
  const seconds = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return 1_000 * 2 ** attempt;
  if (milliseconds > maximumRetryAfterMs) return null;
  return Math.max(0, milliseconds);
}

// Each attempt owns its timer; caller cancellation also ends backoff. Retry only the
// downloader boundary: get retains checksum/cache authority, and signing runs once.
export function createElectronDownloader({
  downloader = new FetchDownloader(),
  sleep = delay,
  warn = console.warn,
}: ElectronDownloaderPorts = {}): ElectronDownloader {
  return {
    async download(url, targetFilePath, options = {}) {
      const callerSignal = options.signal ?? undefined;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        callerSignal?.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new DOMException("Electron download timed out", "TimeoutError")),
          attemptTimeoutMs,
        );
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, timeout.signal])
          : timeout.signal;
        let failure: unknown;
        try {
          return await downloader.download(url, targetFilePath, { ...options, signal });
        } catch (error: unknown) {
          failure = error;
          // FetchDownloader throws before consuming an HTTP error body. A stalled
          // body cancellation must not delay retry or rethrow.
          if (error instanceof HTTPError) void error.response.body?.cancel().catch(() => {});
          if (
            callerSignal?.aborted ||
            attempt + 1 === maximumAttempts ||
            (!timeout.signal.aborted && !isTransient(error))
          )
            throw error;
        } finally {
          clearTimeout(timer);
        }
        const waitMs = retryDelay(failure, attempt);
        if (waitMs === null) throw failure;
        warn(
          `Electron download interrupted; retry ${attempt + 1}/${maximumAttempts - 1} in ${waitMs} ms.`,
        );
        await sleep(waitMs, undefined, { signal: callerSignal });
      }
    },
  };
}
