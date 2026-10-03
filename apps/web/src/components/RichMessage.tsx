import type { ReactNode } from "react";
import "./RichMessage.css";

type RichBlock =
  | { id: string; type: "paragraph"; text: string }
  | { id: string; type: "heading"; text: string }
  | { id: string; type: "list"; items: string[] }
  | { id: string; type: "table"; headers: string[]; rows: string[][] };

export function RichMessage({ content }: { content: string }) {
  return (
    <div className="rich-message">
      {parseRichMessage(content).map((block) => {
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
        return <p key={block.id}>{renderInline(block.text)}</p>;
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

function renderInline(text: string): ReactNode {
  // Model text stays React text nodes; only `code` and **bold** spans get elements.
  return text.split(/(`[^`\n]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    const key = `${index}:${part}`;
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
      return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    return part;
  });
}
