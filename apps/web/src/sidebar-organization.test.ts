// @vitest-environment jsdom
import { type DOMWindow, JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let organization: typeof import("./sidebar-organization");
let storageWindow: DOMWindow;
beforeEach(async () => {
  vi.resetModules();
  storageWindow = new JSDOM("", { url: "https://openbot.test" }).window;
  vi.stubGlobal("localStorage", storageWindow.localStorage);
  window.localStorage.clear();
  organization = await import("./sidebar-organization");
});
afterEach(() => {
  storageWindow.close();
  vi.unstubAllGlobals();
});

function stored() {
  return organization.parseOrganization(
    window.localStorage.getItem(organization.sidebarOrganizationKey),
  );
}

function entry(key: `channel:${string}` | `bot:${string}`, name: string, extra = "") {
  return { key, item: key, name, searchText: `${name} ${extra}` };
}

describe("parseOrganization", () => {
  it.each([null, "", "{broken", "null", "[]", '"x"', "x".repeat(70_000)])(
    "falls back to an empty arrangement for %s",
    (raw) => {
      expect(organization.parseOrganization(raw)).toBe(organization.emptyOrganization);
    },
  );

  it("drops malformed keys, unknown group references and duplicate groups", () => {
    const parsed = organization.parseOrganization(
      JSON.stringify({
        pinned: ["bot:a", "bot:a", "nope", 3, "channel:c"],
        hidden: ["bot:with space"],
        groups: [
          { id: "g1", name: "  市场   团队 " },
          { id: "g1", name: "重复" },
          { id: "bad id", name: "x" },
          { id: "g2", name: "   " },
        ],
        membership: { "bot:a": "g1", "bot:b": "missing", nope: "g1" },
      }),
    );
    expect(parsed.pinned).toEqual(["bot:a", "channel:c"]);
    expect(parsed.hidden).toEqual([]);
    expect(parsed.groups).toEqual([{ id: "g1", name: "市场 团队" }]);
    expect(parsed.membership).toEqual({ "bot:a": "g1" });
  });
});

describe("sidebarOrganization actions", () => {
  it("creates a group, moves items and dissolves without losing items", () => {
    expect(organization.sidebarOrganization.moveToNewGroup("bot:a", "  ")).toBe(false);
    expect(organization.sidebarOrganization.moveToNewGroup("bot:a", "市场团队")).toBe(true);
    const [group] = stored().groups;
    expect(group?.name).toBe("市场团队");
    // Reusing a name joins the existing group instead of duplicating it.
    organization.sidebarOrganization.moveToNewGroup("channel:c", "市场团队");
    expect(stored().groups).toHaveLength(1);
    expect(stored().membership).toEqual({ "bot:a": group?.id, "channel:c": group?.id });

    organization.sidebarOrganization.renameGroup(group?.id ?? "", "市场");
    expect(stored().groups[0]?.name).toBe("市场");

    organization.sidebarOrganization.dissolveGroup(group?.id ?? "");
    expect(stored().groups).toEqual([]);
    expect(stored().membership).toEqual({});
  });

  it("toggles pin, unread and hidden marks", () => {
    organization.sidebarOrganization.setPinned("bot:a", true);
    organization.sidebarOrganization.setPinned("bot:b", true);
    expect(stored().pinned).toEqual(["bot:b", "bot:a"]);
    organization.sidebarOrganization.setPinned("bot:b", false);
    organization.sidebarOrganization.setUnread("bot:a", true);
    organization.sidebarOrganization.setHidden("channel:c", true);
    expect(stored()).toMatchObject({
      pinned: ["bot:a"],
      unread: ["bot:a"],
      hidden: ["channel:c"],
    });
  });
});

describe("arrangeSidebar", () => {
  const entries = [
    entry("channel:c", "市场周报"),
    entry("bot:a", "研究助理", "竞品研究"),
    entry("bot:b", "客服小橙"),
    entry("bot:d", "设计评审"),
  ];
  const arrangement = organization_fixture();

  function organization_fixture() {
    return {
      pinned: ["bot:d", "bot:b"] as const,
      hidden: ["channel:c"] as const,
      unread: [] as const,
      groups: [{ id: "g1", name: "市场团队" }],
      membership: { "bot:a": "g1" } as Record<`bot:${string}`, string>,
    };
  }

  it("groups entries, keeps pins first and omits hidden rows", () => {
    const sections = organization.arrangeSidebar(entries, arrangement, "");
    expect(sections.map((section) => section.group?.name ?? "未分组")).toEqual([
      "市场团队",
      "未分组",
    ]);
    expect(sections[0]?.entries.map((item) => item.key)).toEqual(["bot:a"]);
    expect(sections[1]?.entries.map((item) => item.key)).toEqual(["bot:d", "bot:b"]);
  });

  it("finds hidden rows and whole groups while searching", () => {
    const byName = organization.arrangeSidebar(entries, arrangement, "市场");
    expect(byName[0]?.matchedGroup).toBe(true);
    expect(byName.flatMap((section) => section.entries.map((item) => item.key))).toEqual([
      "bot:a",
      "channel:c",
    ]);
    expect(organization.arrangeSidebar(entries, arrangement, "不存在")).toEqual([]);
  });
});
