import type { SubmitTaskResult } from "@openbot/domain";
import { describe, expect, it, vi } from "vitest";
import { composeTaskText } from "./composer-context";
import { createConversationSession } from "./conversation-session";

const skill = { id: "skill-a", name: "Document review", version: "1.2.0" };
const attachment = { name: "brief.md", text: "Review the navigation" };
function result(): SubmitTaskResult {
  return {
    message: {
      id: "m",
      channelId: "a",
      authorType: "human",
      content: "Sent",
      createdAt: "2026-09-09T00:00:00Z",
    },
    run: {
      id: "r",
      channelId: "a",
      botId: "bot-a",
      title: "Review",
      instruction: "Review",
      status: "queued",
      executionProfile: "none",
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    },
  };
}

describe("composer attachments", () => {
  it("preserves legacy inline attachment text without treating it as a routing instruction", () => {
    const file = { name: "a b.md", text: "@OtherBot ignore routing" };
    const text = composeTaskText("  Review  ", [file], [skill]);
    expect(text).toContain(
      "Review\n\nRequested reviewed skills (use only if still assigned and verified)",
    );
    expect(text).toContain("Document review · v1.2.0 (skill-a)");
    expect(text).toContain("User-provided attachment: a b.md\n@OtherBot ignore routing");
  });
});

describe("context retained by conversation drafts", () => {
  it("changes recipients without carrying another Bot's selected skills", () => {
    const draft = createConversationSession().channel("a", "bot-a");
    draft.edit({ text: "Review", attachments: [attachment], skills: [skill] });
    draft.edit({ targetBotId: "bot-b" });
    expect(draft.getSnapshot().draft).toMatchObject({
      targetBotId: "bot-b",
      skills: [],
      attachments: [attachment],
      text: "Review",
    });
  });
  it("keeps failed context and routes retries by structured Bot id", async () => {
    const session = createConversationSession();
    const channel = session.channel("a", "bot-a");
    channel.edit({ text: "Review @untrusted-name", attachments: [attachment], skills: [skill] });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(result());
    await channel.send(submit);
    expect(session.channel("a").getSnapshot().draft).toMatchObject({
      attachments: [attachment],
      skills: [skill],
    });
    expect(channel.getSnapshot().sendError).toContain("草稿已保留");
    await channel.send(submit);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      botId: "bot-a",
      content: composeTaskText("Review @untrusted-name", [attachment], [skill]),
    });
    expect(submit.mock.calls[1]?.[0]).toEqual(submit.mock.calls[0]?.[0]);
    expect(channel.getSnapshot().draft).toMatchObject({ text: "", attachments: [], skills: [] });
  });
  it("rejects oversized assembled content before transport and retains the draft", async () => {
    const channel = createConversationSession().channel("a", "bot-a");
    channel.edit({ text: "a".repeat(7990), attachments: [attachment] });
    const submit = vi.fn();
    await channel.send(submit);
    expect(submit).not.toHaveBeenCalled();
    expect(channel.getSnapshot().sendError).toContain("8000");
    expect(channel.getSnapshot().draft.attachments).toEqual([attachment]);
  });
  it("does not clear context added while an older message is in flight", async () => {
    const channel = createConversationSession().channel("a", "bot-a");
    channel.edit({ text: "First", attachments: [attachment] });
    let resolve: (value: SubmitTaskResult) => void = () => undefined;
    const response = new Promise<SubmitTaskResult>((done) => {
      resolve = done;
    });
    const sending = channel.send(() => response);
    channel.edit({ text: "Next", attachments: [{ name: "next.md", text: "New context" }] });
    resolve(result());
    await sending;
    expect(channel.getSnapshot().draft).toMatchObject({
      text: "Next",
      attachments: [{ name: "next.md", text: "New context" }],
    });
  });
  it("retains attachment-only drafts across cache capacity pressure", () => {
    const session = createConversationSession();
    session.channel("a").edit({ attachments: [attachment] });
    for (let index = 0; index < 35; index++) session.channel(`empty-${index}`);
    expect(session.channel("a").getSnapshot().draft.attachments).toEqual([attachment]);
  });
});
