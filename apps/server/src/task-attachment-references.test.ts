import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TaskAttachmentReferences } from "./task-attachment-references.js";

describe("task reference policy without storage", () => {
  it("allows text-only submissions and fails closed before persisting a file reference", async () => {
    const policy = new TaskAttachmentReferences();
    const persist = vi.fn(async () => "saved");
    expect(await policy.withActive("channel", "Text only", persist)).toBe("saved");
    persist.mockClear();
    await expect(
      policy.withActive("channel", `[OpenBot attachment: ${randomUUID()}]`, persist),
    ).rejects.toThrow(/unavailable/);
    expect(persist).not.toHaveBeenCalled();
    await expect(
      policy.withLock((validate) => validate("channel", `[OpenBot attachment: ${randomUUID()}]`)),
    ).rejects.toThrow(/unavailable/);
  });
});
