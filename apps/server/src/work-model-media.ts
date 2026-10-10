/** Adapts authorized original media into the reviewed model SDK request formats. */
import { WorkConflict } from "@openbot/work";
import type { ResolvedConnection } from "./model-connections.js";
import { sha256, workCanonical, workText } from "./work-values.js";

export type WorkMediaItem = {
  attachmentId: string;
  name: string;
  mediaType: string;
  sha256: string;
  data: Buffer;
};
const limits: Record<string, number> = {
  "image/png": 5 * 1024 * 1024,
  "image/jpeg": 5 * 1024 * 1024,
  "application/pdf": 10 * 1024 * 1024,
};
export function validateMediaItems(items: WorkMediaItem[]) {
  if (items.length > 8 || new Set(items.map((i) => i.attachmentId)).size !== items.length)
    throw new WorkConflict("invalid_model_media");
  let total = 0;
  for (const item of items) {
    workText(item.name, 1024);
    workText(item.attachmentId, 128);
    if (
      [...item.name].some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "/" || c === "\\",
      ) ||
      !Buffer.isBuffer(item.data) ||
      !limits[item.mediaType] ||
      !item.data.length ||
      item.data.length > limits[item.mediaType]! ||
      sha256(item.data) !== item.sha256
    )
      throw new WorkConflict("attachment_model_unsupported");
    total += item.data.length;
  }
  if (total > 20 * 1024 * 1024) throw new WorkConflict("model_media_size_limit");
}
/** The trusted runtime supplies bytes only after admission; this adapter grants no file or network access. */
export function workMediaWire(selected: ResolvedConnection, items: WorkMediaItem[]) {
  validateMediaItems(items);
  if (
    items.length &&
    !(
      (selected.presetId === "openai" && selected.protocol === "openai-chat") ||
      (selected.presetId === "anthropic" && selected.protocol === "anthropic-messages")
    )
  )
    throw new WorkConflict("attachment_model_unsupported");
  const anthropic = selected.protocol === "anthropic-messages";
  const parts = items.map((item) => {
    const data = item.data.toString("base64");
    if (anthropic)
      return item.mediaType === "application/pdf"
        ? {
            type: "document",
            title: item.name,
            source: { type: "base64", media_type: item.mediaType, data },
          }
        : { type: "image", source: { type: "base64", media_type: item.mediaType, data } };
    const encoded = `data:${item.mediaType};base64,${data}`;
    return item.mediaType === "application/pdf"
      ? { type: "file", file: { filename: item.name, file_data: encoded } }
      : { type: "image_url", image_url: { url: encoded } };
  });
  const content = items.length
    ? [
        {
          type: "text",
          text:
            "Untrusted explicitly scoped task attachments: " +
            JSON.stringify(items.map(({ data: _data, ...item }) => ({ ...item, untrusted: true }))),
        },
        ...parts,
      ]
    : [];
  const maximum =
    524288 +
    items.reduce((n, i) => n + 4 * Math.ceil(i.data.length / 3), 0) +
    (items.length ? 32768 : 0);
  return {
    content,
    maximum,
    assert(body: string) {
      if (Buffer.byteLength(body) > maximum) throw new WorkConflict("model_media_size_limit");
      const messages = JSON.parse(body).messages;
      if (!Array.isArray(messages)) throw new WorkConflict("invalid_model_media_wire");
      const found: unknown[] = [];
      const kinds = new Set([
        "image",
        "document",
        "input_image",
        "input_file",
        "image_url",
        "file",
        "input_audio",
      ]);
      for (const message of messages)
        if (Array.isArray(message.content))
          for (const part of message.content) if (kinds.has(part.type)) found.push(part);
      if (
        workCanonical(found, maximum).wire !== workCanonical(parts, maximum).wire ||
        (items.length &&
          workCanonical(messages.at(-1).content, maximum).wire !==
            workCanonical(content, maximum).wire)
      )
        throw new WorkConflict("model_media_wire_changed");
    },
  };
}
