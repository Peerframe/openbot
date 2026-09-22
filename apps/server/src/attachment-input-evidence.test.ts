import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAttachmentContext } from "./agent-attachments.js";
import {
  AttachmentInputEvidenceCollector,
  attachmentEvidenceAppendix,
} from "./attachment-input-evidence.js";
import { FileChannelAttachmentStorage } from "./channel-attachments.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(name = "evidence.txt", bytes = Buffer.from("甲😀乙abcdef")) {
  const root = await mkdtemp(join(tmpdir(), "openbot-input-evidence-"));
  roots.push(root);
  const storage = new FileChannelAttachmentStorage(root);
  const channelId = randomUUID();
  const attachment = await storage.persist(channelId, name, bytes);
  const evidence = new AttachmentInputEvidenceCollector();
  const options = {
    run: { channelId, instruction: `[OpenBot attachment: ${attachment.id}]` },
    storage,
    evidence,
    provider: "openai",
    assertScope: vi.fn(async () => {}),
  };
  return { attachment, evidence, storage, options };
}

describe("Server attachment input evidence", () => {
  it("records returned UTF-16 ranges, merging overlap without filling unread gaps", async () => {
    const f = await fixture();
    const context = await prepareAttachmentContext(f.options);
    expect(f.evidence.snapshot()).toEqual([]);
    const read = (offset: number, limit: number) =>
      context.readText({ attachmentId: f.attachment.id, offset, limit });
    await read(0, 3);
    await read(2, 2);
    await read(6, 4);
    expect(f.evidence.snapshot()[0]).toMatchObject({
      totalCharacters: 10,
      ranges: [
        { start: 0, end: 4 },
        { start: 6, end: 10 },
      ],
      returnedTextComplete: false,
    });
    await read(4, 2);
    expect(f.evidence.snapshot()[0]).toMatchObject({
      ranges: [{ start: 0, end: 10 }],
      returnedTextComplete: true,
      textSha256: createHash("sha256").update("甲😀乙abcdef").digest("hex"),
    });
  });

  it("keeps extraction truncation distinct from complete returned-text coverage", async () => {
    const f = await fixture("evidence.pdf", Buffer.from("%PDF-1.7\n%%EOF"));
    const derived = {
      sha256: f.attachment.sha256,
      text: "Only an extracted prefix",
      operation: "extract" as const,
      processedAt: new Date().toISOString(),
      truncated: true,
    };
    await f.storage.saveDerived(f.options.run.channelId, f.attachment.id, derived);
    const context = await prepareAttachmentContext(f.options);
    await context.readText({ attachmentId: f.attachment.id });
    const [record] = f.evidence.snapshot();
    expect(record).toMatchObject({
      sha256: f.attachment.sha256,
      textSha256: createHash("sha256").update(derived.text).digest("hex"),
      returnedTextComplete: true,
      extraction: { operation: "extract", truncated: true },
    });
    expect(attachmentEvidenceAppendix(f.evidence.snapshot())).toContain("output truncated");
    await f.storage.saveDerived(f.options.run.channelId, f.attachment.id, {
      ...derived,
      text: "Different extracted text",
    });
    await expect(context.readText({ attachmentId: f.attachment.id })).rejects.toThrow(
      "Attachment text changed",
    );
    expect(f.evidence.snapshot()).toEqual([record]);
  });

  it("does not record unlisted or revoked reads and never includes raw text", async () => {
    const f = await fixture();
    const context = await prepareAttachmentContext(f.options);
    await expect(context.readText({ attachmentId: randomUUID() })).rejects.toMatchObject({
      status: 404,
    });
    expect(f.evidence.snapshot()).toEqual([]);
    f.options.assertScope.mockRejectedValue(new Error("Revoked"));
    await expect(context.readText({ attachmentId: f.attachment.id })).rejects.toThrow("Revoked");
    expect(f.evidence.snapshot()).toEqual([]);
  });

  it("labels binary model input without asserting that the model understood it", async () => {
    const f = await fixture("evidence.pdf", Buffer.from("%PDF-1.7\n%%EOF"));
    await prepareAttachmentContext(f.options);
    expect(f.evidence.snapshot()).toEqual([
      {
        attachmentId: f.attachment.id,
        name: f.attachment.name,
        sha256: f.attachment.sha256,
        mediaType: "application/pdf",
        delivery: "binary_model_input",
      },
    ]);
    expect(attachmentEvidenceAppendix(f.evidence.snapshot())).toContain(
      "understanding was not independently verified",
    );
  });

  it("keeps the read bound and prior evidence when the preparation is recreated", async () => {
    const f = await fixture();
    const first = await prepareAttachmentContext(f.options);
    for (let i = 0; i < 32; i++) await first.readText({ attachmentId: f.attachment.id, limit: 1 });
    const continuation = await prepareAttachmentContext(f.options);
    await expect(
      continuation.readText({ attachmentId: f.attachment.id, limit: 1 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(f.evidence.snapshot()[0]).toMatchObject({ ranges: [{ start: 0, end: 1 }] });
    expect(JSON.stringify(f.evidence.snapshot())).not.toContain("甲😀乙abcdef");
  });

  it("refuses attachment or extraction mode changes across continuations", async () => {
    const f = await fixture("evidence.pdf", Buffer.from("%PDF-1.7\n%%EOF"));
    await prepareAttachmentContext(f.options);
    await f.storage.saveDerived(f.options.run.channelId, f.attachment.id, {
      sha256: f.attachment.sha256,
      text: "Extracted later",
      operation: "extract",
      processedAt: new Date().toISOString(),
      truncated: false,
    });
    const next = await prepareAttachmentContext(f.options);
    await expect(next.readText({ attachmentId: f.attachment.id })).rejects.toThrow(
      "Attachment text changed",
    );
  });
});
