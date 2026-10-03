import type { Bot, BotAppearance } from "@openbot/domain";
import { RobotAvatar } from "../components/RobotAvatar";

/*
 * README banner (docs/design/openbot-readme-banner.png), drawn with the product's own avatar so it
 * follows the avatar system. Capture `?scene=banner` at 2172×724 to regenerate it.
 */

// A 5-column pixel face; rows 0–6 sit on the cap height, 7–8 are the descender of 「p」.
const glyphs: Record<string, string[]> = {
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  p: [".....", ".....", "####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".####"],
  n: [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  t: [".#..", ".#..", "####", ".#..", ".#..", ".#..", "..##"],
};

function Wordmark({ pixel }: { pixel: number }) {
  const cells: Array<[number, number]> = [];
  let column = 0;
  for (const letter of "OpenBot") {
    const rows = glyphs[letter] ?? [];
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) if (row[x] === "#") cells.push([column + x, y]);
    });
    column += (rows[0]?.length ?? 5) + 1;
  }
  const width = (column - 1) * pixel;
  return (
    <svg
      width={width}
      height={9 * pixel}
      viewBox={`0 0 ${width} ${9 * pixel}`}
      role="img"
      aria-label="OpenBot"
    >
      {cells.map(([x, y]) => (
        <rect
          key={`${x}:${y}`}
          x={x * pixel}
          y={y * pixel}
          width={pixel}
          height={pixel}
          fill="#20251F"
        />
      ))}
    </svg>
  );
}

const bot = (id: string, head: BotAppearance["head"], accent: BotAppearance["accent"]): Bot => ({
  id,
  name: "OpenBot",
  role: "",
  status: "idle",
  computerProfile: "none",
  appearance: { head, accent, body: "classic", mobility: "feet", accessory: "none" },
  createdAt: "2026-10-03T00:00:00.000Z",
});

// Faint frameless heads behind the wordmark: every character and all eight accents.
const scattered: Array<[number, number, number, BotAppearance["head"], BotAppearance["accent"]]> = [
  [40, 40, 150, "square", "blue"],
  [60, 520, 120, "cat", "yellow"],
  [610, 30, 110, "round", "violet"],
  [1180, 560, 130, "cat", "teal"],
  [1420, 20, 120, "square", "pink"],
  [1700, 520, 140, "round", "red"],
  [1960, 60, 150, "cat", "slate"],
  [2010, 400, 110, "square", "green"],
  [880, 590, 100, "round", "blue"],
];

export function ReadmeBanner() {
  return (
    <main className="readme-banner">
      {scattered.map(([x, y, size, head, accent]) => (
        <span
          key={`${x}:${y}`}
          className="readme-banner-ghost"
          style={{ left: x, top: y, width: size, height: size }}
        >
          <RobotAvatar bot={bot(`g-${x}`, head, accent)} />
        </span>
      ))}
      <span className="readme-banner-hero">
        <RobotAvatar bot={bot("hero", "round", "green")} />
      </span>
      <span className="readme-banner-mark">
        <Wordmark pixel={30} />
      </span>
    </main>
  );
}
