import type { Bot } from "@openbot/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseRichMessage, RichMessage, safeLink } from "./RichMessage";

describe("RichMessage", () => {
  it("parses paragraphs, lists and markdown tables without HTML injection", () => {
    const content = [
      "**结论：** 已完成分析。",
      "",
      "| 标的 | 判断 |",
      "| --- | --- |",
      "| OpenBot | 继续 |",
      "",
      "- 已保存结果",
      "- 等待下一步",
    ].join("\n");

    expect(parseRichMessage(content).map((block) => block.type)).toEqual([
      "paragraph",
      "table",
      "list",
    ]);
    const html = renderToStaticMarkup(
      <RichMessage content={`${content}\n<script>alert(1)</script>`} />,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>结论：</strong>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders inline code as escaped text without touching bold or HTML", () => {
    const html = renderToStaticMarkup(
      <RichMessage content={"读 `weekly/<b>x</b>.md` 后 **汇总**，单个 ` 不算"} />,
    );
    expect(html).toContain("<code>weekly/&lt;b&gt;x&lt;/b&gt;.md</code>");
    expect(html).toContain("<strong>汇总</strong>");
    expect(html).toContain("单个 ` 不算");
  });

  describe("links and Bot names (owner feedback 2026-10-05)", () => {
    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });
    const scout: Bot = {
      id: "b-scout",
      name: "Scout",
      role: "",
      status: "idle",
      computerProfile: "none",
      createdAt: "2026-10-01T00:00:00Z",
      appearance: {
        head: "cat",
        body: "classic",
        mobility: "feet",
        accessory: "none",
        accent: "yellow",
      },
    };

    it("links only https URLs without credentials, and keeps the sentence's punctuation", () => {
      expect(safeLink("https://example.com/a")?.href).toBe("https://example.com/a");
      for (const raw of ["http://example.com", "javascript:alert(1)", "https://u:p@example.com/"])
        expect(safeLink(raw)).toBeUndefined();
      const html = renderToStaticMarkup(
        <RichMessage content="看 https://example.com/x。还有 [说明](https://example.com/doc) 和 javascript:alert(1)" />,
      );
      expect(html).toContain('href="https://example.com/x"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain("说明</a>");
      expect(html).not.toContain('href="javascript');
      expect(html).toContain("。还有");
    });

    it("keeps links readable but inert on Desktop until it can open them", () => {
      (globalThis as { window?: unknown }).window = {
        openbotDesktop: Object.fromEntries(
          [
            "getConnectionState",
            "configureServer",
            "getSetupPlanState",
            "saveSetupPlan",
            "getLocalWorkerState",
            "setupLocalWorker",
            "enableLocalWorker",
            "openLocalWorkerSettings",
          ].map((name) => [name, () => undefined]),
        ),
      };
      const html = renderToStaticMarkup(<RichMessage content="https://example.com/x" />);
      expect(html).not.toContain("<a ");
      expect(html).toContain("rich-link is-inert");
    });

    it("tags the 频道's Bots by name, but not inside a longer Latin word", () => {
      const html = renderToStaticMarkup(
        <RichMessage content="交给 @Scout 和 Scout，不是 Scouting" mentions={[scout]} />,
      );
      expect(html.match(/class="rich-mention"/g)).toHaveLength(2);
      expect(html).toContain("Scouting");
      expect(html).not.toContain("@Scout");
    });
  });
});
