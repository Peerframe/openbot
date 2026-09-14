import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@openbot/domain";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAttachmentContext } from "./agent-attachments.js";
import { AttachmentProcessingService, parseInWorker } from "./attachment-processing.js";
import { FileChannelAttachmentStorage } from "./channel-attachments.js";
import { type AgentRunStore, executeAgentRun } from "./native-agent.js";

const channel = "00000000-0000-4000-8000-000000000001";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openbot-document-test-"));
  dirs.push(root);
  const storage = new FileChannelAttachmentStorage(root);
  return { root, storage, service: new AttachmentProcessingService({ storage }) };
}
// Locally authored ZIP container. The parser under test is the released upstream implementation.
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}
const docx = () =>
  zip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenBot document evidence</w:t></w:r></w:p></w:body></w:document>',
  });

describe("bounded document processing", () => {
  it("extracts real DOCX bytes and exposes only digest-bound text to the task", async () => {
    const { storage, service } = await fixture();
    const bytes = docx();
    const attachment = await storage.persist(channel, "evidence.docx", bytes);
    const ready = await service.process(channel, attachment.id, { operation: "extract" });
    expect(ready.processing?.characters).toBeGreaterThan(0);
    expect((await storage.read(channel, attachment.id)).bytes).toEqual(bytes);
    const context = await prepareAttachmentContext({
      run: { channelId: channel, instruction: `[OpenBot attachment: ${attachment.id}]` },
      storage,
      provider: "moonshot",
      assertScope: async () => {},
    });
    expect(await context.readText({ attachmentId: attachment.id })).toMatchObject({
      text: expect.stringContaining("OpenBot document evidence"),
      untrusted: true,
    });
    const run: Run = {
      id: "fixture",
      channelId: channel,
      botId: "fixture",
      executionProfile: "none",
      instruction: `[OpenBot attachment: ${attachment.id}]`,
      title: "Read document",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const store: AgentRunStore = {
      queued: async () => [],
      claim: async () => run,
      assertScope: async () => {},
      profile: async () => ({
        name: "Fixture",
        role: "Reader",
        description: "Read evidence",
        revision: 1,
      }),
      context: async () => [],
      tasks: async () => [],
      usage: async () => run,
      progress: async (_run, stage, message) => ({
        id: "progress",
        channelId: channel,
        runId: run.id,
        stage,
        message,
        createdAt: run.createdAt,
      }),
      complete: vi.fn(),
      fail: async () => ({ ...run, status: "failed" }),
    };
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "read",
              toolName: "read_attachment",
              input: JSON.stringify({ attachmentId: attachment.id }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "Read the document." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        },
      ],
    });
    await executeAgentRun({
      run,
      store,
      model,
      attachments: storage,
      modelIdentity: { provider: "moonshot", model: "fixture" },
      signal: new AbortController().signal,
      checkSettings: async () => {},
      publish: () => {},
    });
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain("OpenBot document evidence");
  }, 30000);
  it.each(["xlsx", "pptx", "odt"])(
    "extracts an actual %s container",
    async (extension) => {
      const files =
        extension === "xlsx"
          ? {
              "xl/workbook.xml":
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
              "xl/_rels/workbook.xml.rels":
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
              "xl/worksheets/sheet1.xml":
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OpenBot spreadsheet evidence</t></is></c></row></sheetData></worksheet>',
            }
          : extension === "pptx"
            ? {
                "ppt/presentation.xml":
                  '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
                "ppt/slides/slide1.xml":
                  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>OpenBot slide evidence</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
              }
            : {
                mimetype: "application/vnd.oasis.opendocument.text",
                "content.xml":
                  '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>OpenBot ODF evidence</text:p></office:text></office:body></office:document-content>',
              };
      expect((await parseInWorker(zip(files), extension, { operation: "extract" })).text).toContain(
        "OpenBot",
      );
    },
    30000,
  );
  it("rejects malformed archives and already cancelled jobs", async () => {
    await expect(
      parseInWorker(Buffer.from("PK\x03\x04broken"), "docx", { operation: "extract" }),
    ).rejects.toThrow("parsing failed");
    await expect(
      parseInWorker(docx(), "docx", { operation: "extract" }, AbortSignal.abort()),
    ).rejects.toThrow("cancelled");
  });
  it("runs real offline OCR on a locally generated image", async () => {
    const require = createRequire(import.meta.url);
    const { createCanvas } = require("@napi-rs/canvas");
    const canvas = createCanvas(700, 120);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 700, 120);
    context.fillStyle = "black";
    context.font = "48px sans-serif";
    context.fillText("OPENBOT 12345", 20, 80);
    const { storage, service } = await fixture();
    const attachment = await storage.persist(channel, "ocr.png", canvas.toBuffer("image/png"));
    await service.process(channel, attachment.id, { operation: "ocr" });
    expect((await storage.derived(channel, attachment.id))?.text).toContain("12345");
  }, 70000);
  it("keeps deleted referenced files, supports restore and purges only eligible unreferenced bytes", async () => {
    const { storage, root } = await fixture();
    const attachment = await storage.persist(channel, "old.txt", Buffer.from("retained"));
    await storage.setDeleted(channel, attachment.id, true);
    expect((await storage.read(channel, attachment.id)).bytes.toString()).toBe("retained");
    const future = new Date(Date.now() + 86400000).toISOString();
    expect(await storage.cleanup(channel, future, async () => true)).toEqual({
      removed: 0,
      retained: 1,
    });
    expect((await storage.setDeleted(channel, attachment.id, false)).deletedAt).toBeUndefined();
    await storage.setDeleted(channel, attachment.id, true);
    expect(await storage.cleanup(channel, future, async () => false)).toEqual({
      removed: 1,
      retained: 0,
    });
    await expect(readFile(join(root, `${attachment.id}.bin`))).rejects.toThrow();
  });
  it("does not expose tampered derived text and never uploads media without compatible credentials", async () => {
    const { storage, root } = await fixture();
    const attachment = await storage.persist(channel, "test.docx", docx());
    await storage.saveDerived(channel, attachment.id, {
      sha256: attachment.sha256,
      text: "valid",
      operation: "extract",
      truncated: false,
      processedAt: new Date().toISOString(),
    });
    await writeFile(
      join(root, `${attachment.id}.text.json`),
      JSON.stringify({
        sha256: "0".repeat(64),
        text: "changed",
        operation: "extract",
        truncated: false,
        processedAt: new Date().toISOString(),
      }),
    );
    await expect(storage.derived(channel, attachment.id)).rejects.toThrow("digest");
    const media = await storage.persist(channel, "test.mp3", Buffer.from("ID3media"));
    const fetcher = vi.fn();
    const service = new AttachmentProcessingService({ storage, fetcher });
    await expect(service.process(channel, media.id, { operation: "transcribe" })).rejects.toThrow(
      "OpenAI",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("extracts a locally authored password-protected PDF and refuses an incorrect password", async () => {
  const bytes = await readFile(
    new URL("./__fixtures__/attachments/encrypted.pdf", import.meta.url),
  );
  expect(
    (await parseInWorker(bytes, "pdf", { operation: "extract", password: "openbot-test-password" }))
      .text,
  ).toContain("OpenBot encrypted PDF evidence");
  await expect(
    parseInWorker(bytes, "pdf", { operation: "extract", password: "incorrect" }),
  ).rejects.toThrow("password");
}, 30000);

it("uses only explicitly enabled OpenAI credentials and a bounded transcription request", async () => {
  const { storage } = await fixture();
  const media = await storage.persist(channel, "speech.mp3", Buffer.from("ID3synthetic"));
  const fetcher = vi.fn(async () => Response.json({ text: "Owner requested transcription" }));
  const service = new AttachmentProcessingService({
    storage,
    fetcher,
    settings: async () => ({
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "test-api-key-123456",
      revision: "00000000-0000-4000-8000-000000000003",
      agentEnabled: true,
      agentEnabledAt: "2026-09-10T00:00:00.000Z",
    }),
  });
  expect(fetcher).not.toHaveBeenCalled();
  await service.process(channel, media.id, { operation: "transcribe" });
  expect(fetcher).toHaveBeenCalledWith(
    new URL("https://api.openai.com/v1/audio/transcriptions"),
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: { Authorization: "Bearer test-api-key-123456" },
      body: expect.any(FormData),
      signal: expect.any(AbortSignal),
    }),
  );
  expect((await storage.derived(channel, media.id))?.text).toBe("Owner requested transcription");
});

it("extracts only text from a PDF with an untrusted JavaScript OpenAction", async () => {
  const bytes = await readFile(
    new URL("./__fixtures__/attachments/script-action.pdf", import.meta.url),
  );
  expect(bytes.includes(Buffer.from("JavaScript"))).toBe(true);
  const result = await parseInWorker(bytes, "pdf", { operation: "extract" });
  expect(result.text).toContain("OpenBot action PDF evidence");
  expect(result.text).not.toContain("OPENBOT_PDF_ACTION");
}, 30000);

it("rejects ZIP entry expansion beyond the configured parser bound", async () => {
  const entries: Record<string, string> = {};
  for (let index = 0; index < 2001; index++) entries[`entry-${index}.xml`] = "<data>bounded</data>";
  await expect(parseInWorker(zip(entries), "docx", { operation: "extract" })).rejects.toThrow(
    "parsing failed",
  );
}, 30000);

it("serializes task persistence with deletion and prevents new references after deletion", async () => {
  const { storage } = await fixture();
  const attachment = await storage.persist(channel, "keep.txt", Buffer.from("content"));
  let release: (() => void) | undefined;
  const latch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = vi.fn();
  const persistence = storage.withActiveReferences(channel, [attachment.id], async () => {
    started();
    await latch;
    return "persisted";
  });
  await vi.waitFor(() => expect(started).toHaveBeenCalled());
  let deleted = false;
  const deletion = storage.setDeleted(channel, attachment.id, true).then(() => {
    deleted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(deleted).toBe(false);
  release?.();
  expect(await persistence).toBe("persisted");
  await deletion;
  const nextPersistence = vi.fn();
  await expect(
    storage.withActiveReferences(channel, [attachment.id], nextPersistence),
  ).rejects.toThrow("deleted attachment");
  expect(nextPersistence).not.toHaveBeenCalled();
  expect((await storage.read(channel, attachment.id)).bytes.toString()).toBe("content");
});

it("rejects image-only PDF extraction without marking success or changing the original", async () => {
  const { storage, service } = await fixture();
  const bytes = await readFile(
    new URL("./__fixtures__/attachments/image-only.pdf", import.meta.url),
  );
  const attachment = await storage.persist(channel, "scan.pdf", bytes);
  await expect(
    service.process(channel, attachment.id, { operation: "extract" }),
  ).rejects.toMatchObject({
    message: expect.stringContaining("No readable PDF text"),
    status: 415,
  });
  expect((await storage.metadata(channel, attachment.id)).processing).toBeUndefined();
  expect(await storage.derived(channel, attachment.id)).toBeUndefined();
  expect((await storage.read(channel, attachment.id)).bytes).toEqual(bytes);
  // A failed extraction does not suppress the original on an explicit, compatible attachment.
  const context = await prepareAttachmentContext({
    run: { channelId: channel, instruction: `[OpenBot attachment: ${attachment.id}]` },
    storage,
    provider: "openai",
    assertScope: async () => {},
  });
  expect(context.messages[0]?.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "file", data: bytes })]),
  );
}, 30000);

it("rejects legacy whitespace extraction before inference without sending the binary instead", async () => {
  const { storage } = await fixture();
  const bytes = await readFile(
    new URL("./__fixtures__/attachments/image-only.pdf", import.meta.url),
  );
  const attachment = await storage.persist(channel, "legacy-scan.pdf", bytes);
  await storage.saveDerived(channel, attachment.id, {
    sha256: attachment.sha256,
    text: " \n\t",
    operation: "extract",
    processedAt: new Date().toISOString(),
    truncated: false,
  });
  await expect(
    prepareAttachmentContext({
      run: { channelId: channel, instruction: `[OpenBot attachment: ${attachment.id}]` },
      storage,
      provider: "openai",
      assertScope: async () => {},
    }),
  ).rejects.toThrow("Re-upload the original");
  expect((await storage.read(channel, attachment.id)).bytes).toEqual(bytes);
});
