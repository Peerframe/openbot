// Composer recipient selection: add, remove or select everyone, up to six Bots per message.
export const MAX_MESSAGE_RECIPIENTS = 6;

export interface RecipientSelection {
  targetBotId: string;
  targetBotIds?: string[];
}

function validateIds(ids: string[]): string[] {
  if (ids.length > MAX_MESSAGE_RECIPIENTS)
    throw new Error(`每条消息最多选择 ${MAX_MESSAGE_RECIPIENTS} 个 Bot。`);
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
    throw new Error("接收 Bot 不能为空或重复。");
  return [...ids];
}

/** This selection is presentation state; Server membership checks still authorize every recipient. */
export function selectedRecipientIds(draft: RecipientSelection): string[] {
  return validateIds(draft.targetBotIds ?? (draft.targetBotId ? [draft.targetBotId] : []));
}

function selection(ids: string[]): RecipientSelection {
  const targetBotIds = validateIds(ids);
  return { targetBotId: targetBotIds[0] ?? "", targetBotIds };
}

export function addRecipient(
  draft: RecipientSelection,
  botId: string,
  memberIds: readonly string[],
): RecipientSelection {
  const current = selectedRecipientIds(draft);
  if (![...current, botId].every((id) => memberIds.includes(id)))
    throw new Error("只能选择当前频道的 Bot，请重新选择接收者。");
  return selection(current.includes(botId) ? current : [...current, botId]);
}

export function removeRecipient(draft: RecipientSelection, botId: string): RecipientSelection {
  return selection(selectedRecipientIds(draft).filter((id) => id !== botId));
}

export function selectEveryone(memberIds: readonly string[]): RecipientSelection {
  return selection([...memberIds]);
}
