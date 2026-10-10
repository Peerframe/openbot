/** Bounds admitted operations while retaining ownership until native work and SQL have settled. */
import { HttpFailure } from "./http-errors.js";

// A rejected request cannot free a slot still occupied by native work or a SQL transaction.
export function boundedAdmission(limit: number, options: {
  waitForSettlement?: boolean;
  committedResult?: boolean;
  timeoutMs?: number;
} = {}) {
  const { waitForSettlement = false, committedResult = false, timeoutMs = 6000 } = options;
  let active = 0;
  return async <T>(
    signal: AbortSignal,
    operation: (check: () => void) => Promise<T>,
  ): Promise<T> => {
    if (active >= limit) throw new HttpFailure(503, { error: "server_busy" });
    if (signal.aborted) throw new HttpFailure(400, { error: "request_aborted" });
    active++;
    const deadline = new AbortController();
    const bounded = AbortSignal.any([signal, deadline.signal]);
    const abortFailure = () => new HttpFailure(signal.aborted ? 400 : 408, {
      error: signal.aborted ? "request_aborted" : "request_timeout",
    });
    const check = () => { if (bounded.aborted) throw abortFailure(); };
    let rejectAbort: (() => void) | undefined;
    const failure = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(abortFailure());
      bounded.addEventListener("abort", rejectAbort, { once: true });
    });
    if (committedResult) void failure.catch(() => undefined);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref();
    const work = Promise.resolve()
      .then(() => {
        check();
        return operation(check);
      })
      .finally(() => {
        active--;
      });
    try {
      const result = await (committedResult ? work : Promise.race([work, failure]));
      if (!committedResult) check();
      return result;
    } catch (error) {
      // File owners cannot release an inode lock or restore bytes while SQL can still commit.
      if (waitForSettlement) await work.catch(() => undefined);
      // Preserve domain refusals until the owning HTTP adapter selects its public envelope.
      throw error;
    } finally {
      clearTimeout(timer);
      if (rejectAbort) bounded.removeEventListener("abort", rejectAbort);
    }
  };
}
