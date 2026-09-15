import { setTimeout as delay } from "node:timers/promises";
import { FetchDownloader, HTTPError } from "@electron/get";

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
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

function isTransient(error) {
  if (error instanceof HTTPError) return transientStatuses.has(error.response.status);
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
    if (transientCodes.has(cause.code)) return true;
  }
  return false;
}

function retryDelay(error, attempt) {
  const value = error instanceof HTTPError ? error.response.headers.get("retry-after") : null;
  if (value === null) return 1_000 * 2 ** attempt;
  const seconds = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds)) return 1_000 * 2 ** attempt;
  if (milliseconds > maximumRetryAfterMs) return null;
  return Math.max(0, milliseconds);
}

// Retry only the public downloader boundary. get retains checksum/cache authority, and
// Packager hooks, mutations and signing execute once after a verified download succeeds.
export function createElectronDownloader({
  downloader = new FetchDownloader(),
  sleep = delay,
  warn = console.warn,
} = {}) {
  return {
    async download(url, targetFilePath, options = {}) {
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        options.signal?.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new DOMException("Electron download timed out", "TimeoutError")),
          attemptTimeoutMs,
        );
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeout.signal])
          : timeout.signal;
        let failure;
        try {
          return await downloader.download(url, targetFilePath, { ...options, signal });
        } catch (error) {
          failure = error;
          // FetchDownloader throws on HTTP status before consuming the response body.
          if (error instanceof HTTPError) void error.response.body?.cancel().catch(() => {});
          if (
            options.signal?.aborted ||
            attempt + 1 === maximumAttempts ||
            (!timeout.signal.aborted && !isTransient(error))
          ) {
            throw error;
          }
        } finally {
          clearTimeout(timer);
        }
        const waitMs = retryDelay(failure, attempt);
        if (waitMs === null) throw failure;
        warn(
          `Electron download interrupted; retry ${attempt + 1}/${maximumAttempts - 1} in ${waitMs} ms.`,
        );
        await sleep(waitMs, undefined, { signal: options.signal ?? undefined });
      }
    },
  };
}
