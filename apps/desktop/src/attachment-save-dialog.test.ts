import { describe, expect, it } from "vitest";
import { originalAttachmentSaveDialog } from "./attachment-save-dialog.js";

describe("original attachment save dialog copy", () => {
  it("uses Chinese title and overwrite-preserving labels", () => {
    expect(originalAttachmentSaveDialog("scan.pdf")).toEqual({
      title: "保存原始附件",
      buttonLabel: "保存",
      defaultPath: "scan.pdf",
      message: "已有文件不会被覆盖。",
      showsTagField: false,
    });
    expect(originalAttachmentSaveDialog("scan.pdf").title).not.toBe("Save original attachment");
  });
});
