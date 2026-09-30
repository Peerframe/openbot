export interface MentionQuery {
  start: number;
  query: string;
}

export function findMentionQuery(text: string, caret: number): MentionQuery | undefined {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  return { start: before.length - match[1]!.length - 1, query: match[1]! };
}

export function removeMentionQuery(text: string, mention: MentionQuery | undefined): string {
  if (!mention) return text;
  const queryEnd = mention.start + 1 + mention.query.length;
  const suffixLength = /^[^\s@]*/.exec(text.slice(queryEnd))?.[0].length ?? 0;
  return text.slice(0, mention.start).trimEnd() + text.slice(queryEnd + suffixLength);
}
