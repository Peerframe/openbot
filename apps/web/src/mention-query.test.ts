import { describe, expect, it } from "vitest";
import { findMentionQuery, removeMentionQuery } from "./mention-query";

describe("mention query range", () => {
  it("opens at the caret after a boundary and accepts Chinese names", () => {
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(findMentionQuery("请 @研究", 5)).toEqual({ start: 2, query: "研究" });
    expect(findMentionQuery("Review @Coder carefully", 13)).toEqual({ start: 7, query: "Coder" });
  });
  it("ignores email addresses and completed queries", () => {
    expect(findMentionQuery("team@example", 12)).toBeUndefined();
    expect(findMentionQuery("@研究 帮我", 6)).toBeUndefined();
    expect(findMentionQuery("hello @bot", 3)).toBeUndefined();
  });
  it("removes the selected query without dropping text after the caret", () => {
    const text = "Review @Coder carefully";
    expect(removeMentionQuery(text, findMentionQuery(text, 13))).toBe("Review carefully");
    expect(removeMentionQuery(text, findMentionQuery(text, 10))).toBe("Review carefully");
    expect(removeMentionQuery("@Coder", findMentionQuery("@Coder", 6))).toBe("");
    expect(removeMentionQuery("Review", undefined)).toBe("Review");
  });
});
