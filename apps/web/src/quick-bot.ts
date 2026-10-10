// 创建新 Bot helpers: the quick-created Bot's placeholder role, a fresh random look, and the failure
// notice. The Server allocates the name and opens its 单聊.
import type { Bot, BotAppearance } from "@openbot/domain";

/*
 * 创建新 Bot creates immediately (DESIGN.md › Creating Bots and 频道). The Server allocates the
 * name and role and opens the 单聊 in the same transaction (C12); the client only picks a look.
 */

/** The fixed role of a quick-created Bot; the 定分工 card replaces it. */
export const QUICK_BOT_ROLE = "通用助手";
/** Bots quick-created before C12 carried this client-side placeholder. */
const LEGACY_QUICK_BOT_ROLE = "还没有分工";

const heads: BotAppearance["head"][] = ["round", "square", "cat"];
export const BOT_ACCENTS: BotAppearance["accent"][] = [
  "green",
  "blue",
  "yellow",
  "red",
  "violet",
  "teal",
  "pink",
  "slate",
];

/** A random head and colour, preferring a combination the team is not using yet. */
export function freshAppearance(
  bots: readonly Pick<Bot, "appearance">[],
  random: () => number = Math.random,
): BotAppearance {
  const used = new Map<string, number>();
  for (const bot of bots)
    if (bot.appearance) {
      const key = `${bot.appearance.head}:${bot.appearance.accent}`;
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  const combos = heads.flatMap((head) => BOT_ACCENTS.map((accent) => ({ head, accent })));
  const least = Math.min(...combos.map((combo) => used.get(`${combo.head}:${combo.accent}`) ?? 0));
  const candidates = combos.filter(
    (combo) => (used.get(`${combo.head}:${combo.accent}`) ?? 0) === least,
  );
  const pick = candidates[Math.floor(random() * candidates.length)] ?? candidates[0] ?? combos[0];
  return {
    head: pick?.head ?? "round",
    accent: pick?.accent ?? "green",
    body: "classic",
    mobility: "feet",
    accessory: "none",
  };
}

/** Bot is a quick-created one still waiting for the 定分工 card. */
export function needsRoleSetup(bot: Pick<Bot, "role"> | undefined): boolean {
  return bot?.role === QUICK_BOT_ROLE || bot?.role === LEGACY_QUICK_BOT_ROLE;
}

/**
 * Notice for a failed 创建新 Bot. A lost response may still have created the Bot, so the generic
 * text asks the user to look before trying again instead of promising nothing happened.
 */
export function quickCreateFailure(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  if (code === "quick_bot_name_exhausted")
    return "默认名字「新建 Bot N」都被占用了。先给几个 Bot 改名再创建。";
  if (code === "quick_bot_name_contention")
    return "同时有别的改名在进行，没能创建 Bot。请再试一次。";
  if (
    code === "model_connection_not_found" ||
    code === "model_connection_disabled" ||
    code === "model_endpoint_not_authorized" ||
    code === "model_selection_unavailable"
  )
    return "默认模型现在用不了，没有创建 Bot。到「设置 › 模型服务」换一个默认模型再试。";
  return "没能确认 Bot 是否已创建。先看看侧栏，没有再重试。";
}
