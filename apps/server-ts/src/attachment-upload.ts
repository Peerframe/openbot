import type { Readable } from "node:stream";
import { attachmentMaximum } from "./owner-files.js";
import { refuse } from "./owner-transaction.js";
import { WriteFailure } from "./primary-bot-write.js";
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
    return refuse(503, "attachment_unavailable");
  }
  if (!payload) return refuse(413, "attachment_size_limit");
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const finish = (error?: WriteFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      payload.pause();
      payload.off("data", chunk);
      payload.off("end", end);
      payload.off("error", failed);
      payload.off("close", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const chunk = (data: Buffer) => {
      size += data.length;
      if (size > attachmentMaximum)
        finish(new WriteFailure(413, { error: "attachment_size_limit" }));
      else chunks.push(data);
    };
    const end = () => finish(),
      failed = () => finish(new WriteFailure(503, { error: "attachment_unavailable" })),
      aborted = () => finish(new WriteFailure(503, { error: "attachment_unavailable" }));
    const timer = setTimeout(failed, 10000);
    timer.unref();
    payload.on("data", chunk);
    payload.once("end", end);
    payload.once("error", failed);
    payload.once("close", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  return { name, data };
}
