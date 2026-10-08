import { parseJsonInput } from "./json-input.js";
import type { Readable } from "node:stream";
import { WriteFailure } from "./primary-bot-write.js";

export async function primaryBotJson(
  payload: Readable | undefined,
  contentType: string | undefined,
  contentLength: string | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  // Retain the Python registrar's content-type branch and exact read_json envelope.
  if (!contentType?.startsWith("application/json")) return null;
  return boundedJson(payload, contentType, contentLength, signal, 1024);
}

export async function boundedJson(
  payload: Readable | undefined,
  contentType: string | undefined,
  contentLength: string | undefined,
  signal: AbortSignal,
  maxBytes = 8192,
): Promise<unknown> {
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new WriteFailure(422, { error: "Request requires JSON." });
  const tooLarge = () => new WriteFailure(413, { error: "Request is too large." });
  const invalidLength =
    contentLength !== undefined &&
    (!/^[0-9]+$/.test(contentLength) ||
      contentLength.length > String(maxBytes).length ||
      Number(contentLength) > maxBytes);
  // Closing an early 413 while the client is uploading can reset the socket before it
  // receives the envelope. Discard a near-limit rejected body without retaining/parsing
  // it, under the existing five-second deadline and a fixed 64 KiB excess allowance.
  const discardLimit = maxBytes + 65536;
  if (invalidLength && (!payload || Number(contentLength) > discardLimit)) throw tooLarge();
  if (!payload) throw new WriteFailure(422, { error: "Invalid JSON input." });
  const body = await new Promise<Buffer>((resolve, reject) => {
    let length = 0,
      settled = false,
      rejected = invalidLength;
    const chunks: Buffer[] = [];
    const finish = (failure?: WriteFailure) => {
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
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) {
        rejected = true;
        chunks.length = 0;
      }
      if (length > discardLimit) finish(tooLarge());
      else if (!rejected) chunks.push(chunk);
    };
    const end = () => finish(rejected ? tooLarge() : undefined);
    const error = () => finish(new WriteFailure(422, { error: "Invalid JSON input." }));
    const abort = () =>
      finish(new WriteFailure(503, { error: "Control-plane storage is unavailable." }));
    const timer = setTimeout(
      () => finish(rejected ? tooLarge() : new WriteFailure(408, { error: "Request timed out." })),
      5000,
    );
    timer.unref();
    payload.on("data", data);
    payload.once("end", end);
    payload.once("error", error);
    payload.once("close", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return parseJsonInput(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    throw new WriteFailure(422, { error: "Invalid JSON input." });
  }
}
