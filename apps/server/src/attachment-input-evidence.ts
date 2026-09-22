import { createHash } from "node:crypto";
import {
  AttachmentError,
  type ChannelAttachment,
  type DerivedAttachmentText,
  MAX_TASK_ATTACHMENTS,
} from "./channel-attachments.js";

interface InputIdentity {
  attachmentId: string;
  name: string;
  sha256: string;
  mediaType: ChannelAttachment["mediaType"];
}
export type AttachmentInputEvidence = InputIdentity &
  (
    | { delivery: "binary_model_input" }
    | {
        delivery: "text_tool_result";
        textSha256: string;
        totalCharacters: number;
        ranges: Array<{ start: number; end: number }>;
        returnedTextComplete: boolean;
        extraction?: { operation: DerivedAttachmentText["operation"]; truncated: boolean };
      }
  );

/** Server observations of supplied inputs; this is not a model citation or correctness claim. */
export class AttachmentInputEvidenceCollector {
  readonly #inputs = new Map<string, AttachmentInputEvidence>();
  #reads = 0;

  #identity(attachment: ChannelAttachment): InputIdentity {
    const previous = this.#inputs.get(attachment.id);
    if (
      previous &&
      (previous.sha256 !== attachment.sha256 || previous.mediaType !== attachment.mediaType)
    )
      throw new AttachmentError("Attachment identity changed during the task.", 404);
    if (!previous && this.#inputs.size >= MAX_TASK_ATTACHMENTS)
      throw new AttachmentError("Attachment evidence exceeds the task limit.", 413);
    return {
      attachmentId: attachment.id,
      name: attachment.name,
      sha256: attachment.sha256,
      mediaType: attachment.mediaType,
    };
  }

  binary(attachment: ChannelAttachment): void {
    const identity = this.#identity(attachment);
    const previous = this.#inputs.get(attachment.id);
    if (previous && previous.delivery !== "binary_model_input")
      throw new AttachmentError("Attachment input mode changed during the task.", 404);
    this.#inputs.set(attachment.id, { ...identity, delivery: "binary_model_input" });
  }

  text(
    attachment: ChannelAttachment,
    text: string,
    start: number,
    end: number,
    derived?: DerivedAttachmentText,
  ): void {
    const identity = this.#identity(attachment);
    if (++this.#reads > 32)
      throw new AttachmentError("Attachment evidence reading budget exhausted.", 413);
    const textSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const extraction = derived
      ? { operation: derived.operation, truncated: derived.truncated }
      : undefined;
    const previous = this.#inputs.get(attachment.id);
    if (
      previous &&
      (previous.delivery !== "text_tool_result" ||
        previous.textSha256 !== textSha256 ||
        previous.extraction?.operation !== extraction?.operation ||
        previous.extraction?.truncated !== extraction?.truncated)
    )
      throw new AttachmentError("Attachment text changed during the task.", 404);
    const ranges = [
      ...(previous?.delivery === "text_tool_result" ? previous.ranges : []),
      ...(end > start ? [{ start, end }] : []),
    ].sort((left, right) => left.start - right.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    this.#inputs.set(attachment.id, {
      ...identity,
      delivery: "text_tool_result",
      textSha256,
      totalCharacters: text.length,
      ranges: merged,
      returnedTextComplete:
        text.length === 0 ||
        (merged.length === 1 && merged[0]?.start === 0 && merged[0]?.end === text.length),
      ...(extraction ? { extraction } : {}),
    });
  }

  snapshot(): AttachmentInputEvidence[] {
    return structuredClone([...this.#inputs.values()]);
  }
}

export function attachmentEvidenceAppendix(inputs: AttachmentInputEvidence[]): string {
  if (!inputs.length) return "";
  const rows = inputs.map((input) => {
    const identity = `- ${input.name} (attachment ${input.attachmentId}; SHA-256 ${input.sha256})`;
    if (input.delivery === "binary_model_input")
      return `${identity}: supplied as binary model input; understanding was not independently verified.`;
    const ranges = input.ranges.map(({ start, end }) => `[${start}, ${end})`).join(", ") || "none";
    return (
      `${identity}: text SHA-256 ${input.textSha256}; UTF-16 ranges ${ranges} of ${input.totalCharacters}; ` +
      `returned-text coverage ${input.returnedTextComplete ? "complete" : "partial"}` +
      (input.extraction
        ? `; ${input.extraction.operation} output ${input.extraction.truncated ? "truncated" : "not marked truncated"}`
        : "") +
      "."
    );
  });
  return (
    "\n\n---\n\n## Attachment inputs recorded by OpenBot\n\n" +
    "These Server records describe inputs supplied to this task, not verified conclusions or per-claim citations. " +
    "An attached file absent here was not recorded as supplied. Text coverage refers to the returned text, not the original document.\n\n" +
    rows.join("\n") +
    "\n"
  );
}
