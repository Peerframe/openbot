import { expect, it } from "vitest";
import type { Attachment } from "./owner-files.js";
import { pageWorkAttachment } from "./work-resources.js";

const item = { id: "fixture", name: "Evidence.txt", sha256: "a".repeat(64) } as Attachment;
it("pages attachment text in UTF-16 units without rewriting scalars or exceeding wire bounds", () => {
  expect(
    pageWorkAttachment(item, "a😀b", false, { attachmentId: item.id, offset: 0, limit: 2 }),
  ).toMatchObject({ text: "a", nextOffset: 1, totalCharacters: 4, truncated: true });
  expect(
    pageWorkAttachment(item, "a😀b", false, { attachmentId: item.id, offset: 1, limit: 2 }),
  ).toMatchObject({ text: "😀", nextOffset: 3 });
  expect(() =>
    pageWorkAttachment(item, "a😀b", false, { attachmentId: item.id, offset: 2, limit: 2 }),
  ).toThrow(/splits_character/);
  expect(() =>
    pageWorkAttachment(item, "😀", false, { attachmentId: item.id, offset: 0, limit: 1 }),
  ).toThrow(/splits_character/);
  expect(() =>
    pageWorkAttachment(item, "x", false, { attachmentId: item.id, offset: 2, limit: 1 }),
  ).toThrow();
  const value = pageWorkAttachment(item, "中".repeat(16000), false, {
    attachmentId: item.id,
    offset: 0,
    limit: 16000,
  });
  expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(8192);
  expect(value.nextOffset).toBe(value.text.length);
});
