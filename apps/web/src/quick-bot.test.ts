import type { Bot, BotAccent } from "@openbot/domain";
import { expect, it } from "vitest";
import {
  BOT_ACCENTS,
  freshAppearance,
  needsRoleSetup,
  QUICK_BOT_ROLE,
  quickCreateFailure,
} from "./quick-bot";

const withLook = (head: "round" | "square" | "cat", accent: BotAccent) =>
  ({ appearance: { head, accent, body: "classic", mobility: "feet", accessory: "none" } }) as Pick<
    Bot,
    "appearance"
  >;

it("prefers a head and colour the team is not using yet", () => {
  const heads = ["round", "square", "cat"] as const;
  const team = heads.flatMap((head) => BOT_ACCENTS.map((accent) => withLook(head, accent)));
  team.pop();
  expect(freshAppearance(team, () => 0)).toMatchObject({ head: "cat", accent: "slate" });
  expect(freshAppearance([], () => 0.99)).toMatchObject({ head: "cat", accent: "slate" });
});

it("recognises Bots that still need a role", () => {
  expect(needsRoleSetup({ role: QUICK_BOT_ROLE })).toBe(true);
  expect(needsRoleSetup({ role: "还没有分工" })).toBe(true);
  expect(needsRoleSetup({ role: "信息 · 竞品研究" })).toBe(false);
  expect(needsRoleSetup(undefined)).toBe(false);
});

it("explains why 创建新 Bot failed without promising nothing was created", () => {
  expect(quickCreateFailure(new Error("quick_bot_name_exhausted"))).toContain("都被占用");
  expect(quickCreateFailure(new Error("model_connection_disabled"))).toContain("默认模型");
  expect(quickCreateFailure(new TypeError("Failed to fetch"))).toContain("先看看侧栏");
});
