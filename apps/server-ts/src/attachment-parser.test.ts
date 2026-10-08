import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import {
  boundedAttachmentText,
  boundedImage,
  NodeAttachmentParser,
  textMaximum,
} from "./attachment-parser.js";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const parser = (timeoutMs?: number) =>
  new NodeAttachmentParser(
    join(root, "apps/server-python/src/openbot_server/parser_worker.ts"),
    join(root, "node_modules"),
    timeoutMs,
  );
const signal = () => new AbortController().signal;
const office = (text: string) =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "word/document.xml": strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
          text +
          "</w:t></w:r></w:p></w:body></w:document>",
      ),
    }),
  );
it("preserves scalar truncation and refuses image decompression dimensions", () => {
  expect(boundedAttachmentText("A".repeat(textMaximum - 1) + "😀")).toEqual({
    text: "A".repeat(textMaximum - 1),
    truncated: true,
  });
  const png = Buffer.alloc(24);
  png.writeUInt32BE(16001, 16);
  png.writeUInt32BE(1, 20);
  expect(() => boundedImage(png, "image/png")).toThrow();
});
it("uses the released parser on Office and bounded text without changing original bytes", async () => {
  const original = office("OpenBot document evidence"),
    before = Buffer.from(original);
  expect(
    (await parser().parse(original, "docx", { operation: "extract" }, signal())).text,
  ).toContain("OpenBot document evidence");
  expect(original).toEqual(before);
  const large = await parser().parse(
    office("A".repeat(textMaximum + 1)),
    "docx",
    { operation: "extract" },
    signal(),
  );
  expect(large.text.length).toBe(textMaximum);
  expect(large.truncated).toBe(true);
  await expect(
    parser().parse(Buffer.from("PK\x03\x04broken"), "docx", { operation: "extract" }, signal()),
  ).rejects.toMatchObject({ body: { error: "attachment_parsing_failed" } });
}, 30000);
it("keeps PDF passwords, inert actions and absent text layers distinct", async () => {
  const fixture = join(root, "tests/oracles/legacy-server/src/__fixtures__/attachments");
  const encrypted = readFileSync(join(fixture, "encrypted.pdf"));
  expect(
    (
      await parser().parse(
        encrypted,
        "pdf",
        { operation: "extract", password: "openbot-test-password" },
        signal(),
      )
    ).text,
  ).toContain("OpenBot encrypted PDF evidence");
  await expect(
    parser().parse(encrypted, "pdf", { operation: "extract", password: "incorrect" }, signal()),
  ).rejects.toMatchObject({ body: { error: "pdf_password_required" } });
  expect(
    (
      await parser().parse(
        readFileSync(join(fixture, "script-action.pdf")),
        "pdf",
        { operation: "extract" },
        signal(),
      )
    ).text,
  ).toContain("OpenBot");
  expect(
    (
      await parser().parse(
        readFileSync(join(fixture, "image-only.pdf")),
        "pdf",
        { operation: "extract" },
        signal(),
      )
    ).text.trim(),
  ).toBe("");
}, 30000);
it("kills and reaps active parsers before reporting timeout or cancellation", async () => {
  await expect(
    parser(1).parse(office("bounded"), "docx", { operation: "extract" }, signal()),
  ).rejects.toMatchObject({ body: { error: "attachment_processing_timed_out" } });
  const controller = new AbortController(),
    work = parser().parse(office("cancel"), "docx", { operation: "extract" }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await expect(work).rejects.toMatchObject({ body: { error: "attachment_processing_cancelled" } });
}, 10000);
it("uses only bundled OCR languages in the fixed worker", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(700, 120),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 700, 120);
  context.fillStyle = "black";
  context.font = "48px sans-serif";
  context.fillText("OPENBOT 12345", 20, 80);
  const bytes = canvas.toBuffer("image/png");
  boundedImage(bytes, "image/png");
  expect((await parser().parse(bytes, "png", { operation: "ocr" }, signal())).text).toContain(
    "12345",
  );
}, 60000);
