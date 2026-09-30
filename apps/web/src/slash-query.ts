export interface SlashQuery {
  /** Index of the "/" that opened the command menu. */
  start: number;
  query: string;
}

/**
 * Returns the `/command` fragment the caret is inside. The slash must start a word so paths such as
 * `docs/readme` or URLs never open the menu.
 */
export function findSlashQuery(text: string, caret: number): SlashQuery | undefined {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  const query = match?.[1];
  if (query === undefined || query.length > 32) return undefined;
  return { start: before.length - query.length - 1, query };
}

/** Removes the `/command` fragment, keeping the text on both sides. */
export function removeSlashQuery(text: string, slash: SlashQuery | undefined): string {
  if (!slash) return text;
  const queryEnd = slash.start + 1 + slash.query.length;
  const suffixLength = /^[^\s/]*/.exec(text.slice(queryEnd))?.[0].length ?? 0;
  return text.slice(0, slash.start).trimEnd() + text.slice(queryEnd + suffixLength);
}
