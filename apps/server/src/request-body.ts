/** Reads bounded request bytes with one deadline/disconnect policy and limited overflow draining. */
import type { Readable } from "node:stream";
import { HttpFailure } from "./http-errors.js";

export async function requestBody(payload: Readable | undefined, signal: AbortSignal, options: {
  maximum: number;
  timeoutMs: number;
  contentLength?: string | undefined;
  discardBytes?: number;
  tooLarge: HttpFailure;
}): Promise<Buffer> {
  const { maximum, timeoutMs, contentLength, tooLarge } = options;
  const discardLimit = maximum + (options.discardBytes ?? 0);
  const invalidLength = contentLength !== undefined &&
    (!/^[0-9]+$/.test(contentLength) || contentLength.length > String(maximum).length || Number(contentLength) > maximum);
  if (invalidLength && (!payload || Number(contentLength) > discardLimit)) throw tooLarge;
  if (!payload) throw new HttpFailure(400, { error: "invalid_request_body" });
  return new Promise<Buffer>((resolve, reject) => {
    let length = 0, settled = false, rejected = invalidLength;
    const chunks: Buffer[] = [];
    const finish = (failure?: HttpFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      payload.pause();
      payload.off("data", data);
      payload.off("end", end);
      payload.off("error", error);
      payload.off("close", error);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(Buffer.concat(chunks));
    };
    const data = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      length += chunk.length;
      if (length > maximum) { rejected = true; chunks.length = 0; }
      if (length > discardLimit) finish(tooLarge);
      else if (!rejected) chunks.push(chunk);
    };
    const end = () => finish(rejected ? tooLarge : undefined);
    const error = () => finish(new HttpFailure(400, { error: "invalid_request_body" }));
    const abort = () => finish(new HttpFailure(400, { error: "request_aborted" }));
    const timer = setTimeout(() => finish(rejected ? tooLarge : new HttpFailure(408, { error: "request_timeout" })), timeoutMs);
    timer.unref();
    payload.on("data", data);
    payload.once("end", end);
    payload.once("error", error);
    payload.once("close", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (payload.destroyed || payload.readableEnded) error();
  });
}
