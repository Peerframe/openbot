import { describe, expect, it } from "vitest";
import { findSlashQuery, removeSlashQuery } from "./slash-query";

describe("findSlashQuery", () => {
  it("opens on a slash that starts the text or a word", () => {
    expect(findSlashQuery("/", 1)).toEqual({ start: 0, query: "" });
    expect(findSlashQuery("请 /周报", 5)).toEqual({ start: 2, query: "周报" });
  });

  it("ignores paths, URLs and closed commands", () => {
    expect(findSlashQuery("docs/readme", 11)).toBeUndefined();
    expect(findSlashQuery("https://x.test/a", 16)).toBeUndefined();
    expect(findSlashQuery("/周报 然后", 6)).toBeUndefined();
  });

  it("only reads text before the caret", () => {
    expect(findSlashQuery("hi /skill", 2)).toBeUndefined();
  });
});

describe("removeSlashQuery", () => {
  it("drops the command fragment and keeps surrounding text", () => {
    expect(removeSlashQuery("整理 /周报 本周", findSlashQuery("整理 /周报 本周", 6))).toBe(
      "整理 本周",
    );
    expect(removeSlashQuery("/", { start: 0, query: "" })).toBe("");
    expect(removeSlashQuery("unchanged", undefined)).toBe("unchanged");
  });
});
