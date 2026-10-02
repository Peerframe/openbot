import type { Bot, BotAppearance } from "@openbot/domain";

/*
 * 创建新 Bot creates immediately (DESIGN.md › Creating Bots and 频道). These helpers choose the
 * defaults on the client until the Server can allocate them itself (backlog C12).
 */

export const QUICK_BOT_NAME = "新建 Bot";
/** The Server requires a role; this honest placeholder is replaced by the 定分工 card. */
export const QUICK_BOT_ROLE = "还没有分工";

/** 新建 Bot, then 新建 Bot 2, 3 … — names are unique among active Bots on the Server. */
export function nextBotName(bots: readonly Pick<Bot, "name">[], skip = 0): string {
  const taken = new Set(bots.map((bot) => bot.name));
  let index = 1;
  let skipped = 0;
  for (;;) {
    const name = index === 1 ? QUICK_BOT_NAME : `${QUICK_BOT_NAME} ${index}`;
    if (!taken.has(name)) {
      if (skipped >= skip) return name;
      skipped += 1;
    }
    index += 1;
  }
}

const heads: BotAppearance["head"][] = ["round", "square", "cat"];
// Only the four colours the Server accepts today (C10 adds violet, teal, pink and slate).
const accents: BotAppearance["accent"][] = ["green", "blue", "yellow", "red"];

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
  const combos = heads.flatMap((head) => accents.map((accent) => ({ head, accent })));
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
  return bot?.role === QUICK_BOT_ROLE;
}
