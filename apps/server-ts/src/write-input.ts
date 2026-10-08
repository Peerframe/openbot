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
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    throw new WriteFailure(422, { error: "Request requires JSON." });
  if (
    contentLength !== undefined &&
    (!/^[0-9]{1,4}$/.test(contentLength) || Number(contentLength) > 1024)
  )
    throw new WriteFailure(413, { error: "Request is too large." });
  if (!payload) throw new WriteFailure(422, { error: "Invalid JSON input." });
  const body = await new Promise<Buffer>((resolve, reject) => {
    let length = 0,
      settled = false;
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
      if (length > 1024) finish(new WriteFailure(413, { error: "Request is too large." }));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const error = () => finish(new WriteFailure(422, { error: "Invalid JSON input." }));
    const abort = () =>
      finish(new WriteFailure(503, { error: "Control-plane storage is unavailable." }));
    const timer = setTimeout(
      () => finish(new WriteFailure(408, { error: "Request timed out." })),
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    throw new WriteFailure(422, { error: "Invalid JSON input." });
  }
}
