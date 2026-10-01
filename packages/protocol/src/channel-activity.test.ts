import { describe, expect, it } from "vitest";
import { channelActivitySchema, channelMessagePreviewSchema } from "./channel-activity.js";

const message = {
  id: "message-1",
  authorType: "bot",
  preview: "😀".repeat(160),
  createdAt: "2026-10-01T01:00:00.000Z",
};

describe("Owner channel activity", () => {
  it("accepts Unicode code points and an empty channel without a preview", () => {
    expect(channelMessagePreviewSchema.parse(message)).toEqual(message);
    expect(channelActivitySchema.parse({ lastActivityAt: message.createdAt })).toEqual({
      lastActivityAt: message.createdAt,
    });
  });
  it.each([
    { ...message, preview: "😀".repeat(161) },
    { ...message, authorType: "worker" },
    { ...message, createdAt: "invalid" },
    { ...message, content: "private complete message" },
  ])("rejects malformed and unbounded projections", (value) => {
    expect(channelMessagePreviewSchema.safeParse(value).success).toBe(false);
  });
});
