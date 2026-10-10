// Safe message text renderer: `code`, **bold**, https links and the 频道's Bot names as tags. Model
// text never becomes markup.
import type { Bot } from "@openbot/domain";
import type { CSSProperties, ReactNode } from "react";
import { getOpenBotDesktopBridge } from "../desktop-runtime";
import { AVATAR_ACCENTS, appearanceForBot, RobotAvatar } from "./RobotAvatar";
import "./RichMessage.css";

/** What inline text may turn into: the 频道's Bots as name tags, and https links. */
interface InlineContext {
  mentions: readonly Bot[];
  mentionPattern: RegExp | undefined;
  /**
   * Web opens a link in a new tab without a referrer. Desktop's main process only opens fixed
   * support pages, so there a link stays readable but inert until it offers a safe opener (C27).
   */
  links: "open" | "inert";
}

type RichBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; text: string }
  | { id: string; type: "list"; items: string[] }
  | { id: string; type: "table"; headers: string[]; rows: string[][] };

export function RichMessage({
  content,
  mentions = [],
  leading,
}: {
  content: string;
  /** Inline content before the text, inside the bubble (the Bots an Owner's message went to). */
  leading?: ReactNode;
  /** Bots of this 频道; their names in the text render as tags (owner feedback 2026-10-05). */
  mentions?: readonly Bot[] | undefined;
}) {
  const context: InlineContext = {
    mentions,
    mentionPattern: mentionPattern(mentions),
    links: getOpenBotDesktopBridge() ? "inert" : "open",
  };
  const renderInline = (text: string) => renderInlineWith(text, context);
  const blocks = parseRichMessage(content);
  const leadsFirst = leading !== undefined && blocks[0]?.type === "paragraph";
  return (
    <div className="rich-message">
      {leading !== undefined && !leadsFirst ? <p>{leading}</p> : null}
      {blocks.map((block, blockIndex) => {
        if (block.type === "heading") return <h3 key={block.id}>{renderInline(block.text)}</h3>;
        if (block.type === "list") {
          return (
            <ul key={block.id}>
              {block.items.map((item) => (
                <li key={item}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "table") {
          return (
            <div className="rich-table-wrap" key={block.id}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header) => (
                      <th key={header}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => (
                    <tr key={row.join("|")}>
                      {block.headers.map((header, cellIndex) => (
                        <td key={`${header}:${row[cellIndex] ?? ""}`}>
                          {renderInline(row[cellIndex] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={block.id}>
            {leadsFirst && blockIndex === 0 ? <>{leading} </> : null}
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

export function parseRichMessage(content: string): RichBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    const blockId = `line-${index}`;
    if (line.length === 0) {
      index += 1;
      continue;
    }

    const next = lines[index + 1]?.trim() ?? "";
    if (isTableRow(line) && isTableDivider(next)) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ id: blockId, type: "table", headers, rows });
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      blocks.push({ id: blockId, type: "heading", text: line.replace(/^#{1,3}\s+/, "") });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]?.trim() ?? "")) {
        items.push((lines[index]?.trim() ?? "").replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ id: blockId, type: "list", items });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index]?.trim() ?? "";
      const after = lines[index + 1]?.trim() ?? "";
      if (
        candidate.length === 0 ||
        /^#{1,3}\s+/.test(candidate) ||
        /^[-*]\s+/.test(candidate) ||
        (isTableRow(candidate) && isTableDivider(after))
      ) {
        break;
      }
      paragraph.push(candidate);
      index += 1;
    }
    blocks.push({ id: blockId, type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function isTableRow(line: string) {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isTableDivider(line: string) {
  return isTableRow(line) && tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableCells(line: string) {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function renderInlineWith(text: string, context: InlineContext): ReactNode {
  // Model text stays React text nodes; only `code`, **bold**, https links and the 频道's Bot names
  // get elements. Nothing from the text becomes markup or an attribute other than a checked URL.
  return text.split(/(`[^`\n]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    const key = `${index}:${part}`;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
      return <strong key={key}>{renderText(part.slice(2, -2), context, key)}</strong>;
    return renderText(part, context, key);
  });
}

const LINK_PATTERN =
  /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]{1,2048})\)|https:\/\/[^\s<>"'`，。、；：！？）】」』]{1,2048}/gu;

/** Only plain https URLs without credentials are links; anything else stays text. */
export function safeLink(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function renderText(text: string, context: InlineContext, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let raw = match[2] ?? match[0];
    let end = start + match[0].length;
    if (!match[2]) {
      // A bare URL does not take the sentence's closing punctuation with it.
      const trimmed = raw.replace(/[.,;:!?)\]]+$/u, "");
      end -= raw.length - trimmed.length;
      raw = trimmed;
    }
    const url = safeLink(raw);
    if (!url) continue;
    nodes.push(...renderMentions(text.slice(last, start), context, `${keyBase}:${last}`));
    const label = match[1] ?? `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    nodes.push(
      <RichLink key={`${keyBase}:link:${start}`} url={url} label={label} mode={context.links} />,
    );
    last = end;
  }
  nodes.push(...renderMentions(text.slice(last), context, `${keyBase}:${last}`));
  return nodes;
}

function RichLink({ url, label, mode }: { url: URL; label: string; mode: InlineContext["links"] }) {
  const shown = label.length > 60 ? `${label.slice(0, 57)}…` : label;
  const globe = (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </svg>
  );
  if (mode === "inert")
    return (
      <span className="rich-link is-inert" title={url.href}>
        {globe}
        {shown}
      </span>
    );
  return (
    <a
      className="rich-link"
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      title={url.href}
    >
      {globe}
      {shown}
    </a>
  );
}

function mentionPattern(bots: readonly Bot[]): RegExp | undefined {
  const names = [...new Set(bots.map((bot) => bot.name.trim()).filter((name) => name.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (names.length === 0) return undefined;
  // A Latin name must not be part of a longer word ("Scout" is not in "Scouting").
  return new RegExp(`(?<![A-Za-z0-9_])@?(${names.join("|")})(?![A-Za-z0-9_])`, "gu");
}

function renderMentions(text: string, context: InlineContext, keyBase: string): ReactNode[] {
  if (!text) return [];
  if (!context.mentionPattern) return [text];
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(context.mentionPattern)) {
    const bot = context.mentions.find((item) => item.name.trim() === match[1]);
    if (!bot) continue;
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(<MentionTag key={`${keyBase}:at:${start}`} bot={bot} />);
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A Bot's name as a tag: its head and its jaw colour (owner feedback 2026-10-05). */
/** CSS variables carrying a Bot's jaw colour (light and dark editions) for its name. */
export function accentStyle(bot: Bot): CSSProperties {
  const accent = AVATAR_ACCENTS.find(
    (item) => item.id === (bot.appearance ?? appearanceForBot(bot)).accent,
  );
  return { "--mention": accent?.light, "--mention-dark": accent?.dark } as CSSProperties;
}

export function MentionTag({ bot }: { bot: Bot }) {
  return (
    <span className="rich-mention" style={accentStyle(bot)}>
      <span aria-hidden="true">
        <RobotAvatar bot={bot} className="rich-mention-avatar" />
      </span>
      {bot.name}
    </span>
  );
}
