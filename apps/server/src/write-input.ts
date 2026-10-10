/** Implements write input behavior for the Server. */
import { requestBody } from "./request-body.js";
import { parseJsonInput } from "./json-input.js";
import type { Readable } from "node:stream";
import { HttpFailure } from "./http-errors.js";

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
    throw new HttpFailure(422, { error: "Request requires JSON." });
  if (!payload) throw new HttpFailure(422, { error: "Invalid JSON input." });
  // Drain at most 64 KiB beyond a JSON limit so a near-limit upload can receive its 413.
  const body = await requestBody(payload, signal, {
    maximum: maxBytes, timeoutMs: 5000, contentLength, discardBytes: 65536,
    tooLarge: new HttpFailure(413, { error: "Request is too large." }),
  });
  try {
    return parseJsonInput(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    throw new HttpFailure(422, { error: "Invalid JSON input." });
  }
}
