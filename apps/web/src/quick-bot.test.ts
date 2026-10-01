import type { Bot } from "@openbot/domain";
import { expect, it } from "vitest";
import { freshAppearance, needsRoleSetup, nextBotName, QUICK_BOT_ROLE } from "./quick-bot";

const withLook = (head: "round" | "square" | "cat", accent: "green" | "blue" | "yellow" | "red") =>
  ({ appearance: { head, accent, body: "classic", mobility: "feet", accessory: "none" } }) as Pick<
    Bot,
    "appearance"
  >;

it("numbers the default name past the taken ones", () => {
  expect(nextBotName([])).toBe("新建 Bot");
  expect(nextBotName([{ name: "新建 Bot" }, { name: "新建 Bot 2" }])).toBe("新建 Bot 3");
  expect(nextBotName([{ name: "新建 Bot" }], 1)).toBe("新建 Bot 3");
});

it("prefers a head and colour the team is not using yet", () => {
  const team = [
    withLook("round", "green"),
    withLook("round", "blue"),
    withLook("round", "yellow"),
    withLook("round", "red"),
    withLook("square", "green"),
    withLook("square", "blue"),
    withLook("square", "yellow"),
    withLook("square", "red"),
    withLook("cat", "green"),
    withLook("cat", "blue"),
    withLook("cat", "yellow"),
  ];
  expect(freshAppearance(team, () => 0)).toMatchObject({ head: "cat", accent: "red" });
  expect(freshAppearance([], () => 0.99)).toMatchObject({ head: "cat", accent: "red" });
});

it("recognises Bots that still need a role", () => {
  expect(needsRoleSetup({ role: QUICK_BOT_ROLE })).toBe(true);
  expect(needsRoleSetup({ role: "信息 · 竞品研究" })).toBe(false);
  expect(needsRoleSetup(undefined)).toBe(false);
});
