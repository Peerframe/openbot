import { NativeExecutionError } from "./agent-observations.js";

export interface RunOutputSnapshot {
  runId: string;
  channelId: string;
  botId: string;
  sequence: number;
  text: string;
  reset: boolean;
}

/** SDK aggregate promises can remain pending on an interrupted provider body. */
export async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new NativeExecutionError("task_timeout"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Preserve provider SSE incrementality while bounding bytes, duration and cancellation. */
export function boundedEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let bytes = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const part = await abortable(reader.read(), signal);
        if (part.done) {
          await close();
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > 512 * 1024) throw new NativeExecutionError("task_limit");
        controller.enqueue(part.value);
      } catch (error) {
        await close();
        controller.error(
          error instanceof NativeExecutionError
            ? error
            : new NativeExecutionError(signal.aborted ? "task_timeout" : "model_unavailable"),
        );
      }
    },
    cancel: close,
  });
}
