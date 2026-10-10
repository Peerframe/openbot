/** Implements attachment upload behavior for the Server. */
import { requestBody } from "./request-body.js";
import type { Readable } from "node:stream";
import { attachmentMaximum } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { HttpFailure } from "./http-errors.js";
export async function attachmentUpload(
  payload: Readable | undefined,
  headers: Record<string, unknown>,
  signal: AbortSignal,
) {
  if (headers["content-type"] !== "application/octet-stream")
    return refuse(415, "raw_attachment_required");
  const encoded = headers["x-openbot-filename"];
  if (typeof encoded !== "string" || !encoded || encoded.length > 2048)
    return refuse(400, "attachment_name_required");
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return refuse(400, "invalid_attachment_name");
  }
  if (!payload) return refuse(413, "attachment_size_limit");
  const data = await requestBody(payload, signal, {
    maximum: attachmentMaximum, timeoutMs: 10000,
    contentLength: typeof headers["content-length"] === "string" ? headers["content-length"] : undefined,
    tooLarge: new HttpFailure(413, { error: "attachment_size_limit" }),
  });
  return { name, data };
}
