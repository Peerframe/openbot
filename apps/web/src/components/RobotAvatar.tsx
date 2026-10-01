import type {
  Bot,
  BotAccessory,
  BotAppearance,
  BotBodyShape,
  BotHeadShape,
  BotMobility,
  BotStatus,
  RunStatus,
} from "@openbot/domain";
import "./RobotAvatar.css";

type RobotStatus = BotStatus | RunStatus;

export const defaultBotAppearance: BotAppearance = {
  head: "round",
  body: "classic",
  mobility: "feet",
  accessory: "none",
  accent: "green",
};

/**
 * Light-surface jaw colours from the owner's avatar system (nft_like/03_avatar_svg v2); red is the
 * fourth accent the stored appearance data allows, drawn in the same family.
 */
const accentColors: Record<BotAppearance["accent"], string> = {
  green: "#91CF4B",
  blue: "#5F7CDE",
  yellow: "#DFAD4F",
  red: "#E0785C",
};
const BODY = "#20251F";
const EYE = "#FAFBF7";

/**
 * Frameless head-only Bot avatar (Avatars artboard). The stored head shape selects the character —
 * round → Round, square → Relay, cat → Scout — and the accent colours the jaw. Body, mobility and
 * accessory stay in the appearance data but are no longer drawn, and status is shown beside the
 * avatar, not inside it. Below 32px a container query swaps in the micro optical size (larger
 * eyes, heavier antenna), as the asset notes advise, so callers only set the rendered size;
 * `compact` sets a 24px default.
 */
export function RobotAvatar({
  bot,
  className,
  compact = false,
  status = bot.status,
}: {
  bot: Bot;
  className?: string;
  compact?: boolean;
  status?: RobotStatus;
}) {
  const appearance = bot.appearance ?? appearanceForBot(bot);
  const visualState = robotVisualState(status);
  const accent = accentColors[appearance.accent] ?? accentColors.green;

  return (
    <span
      className={[
        "robot-avatar",
        className,
        compact ? "compact" : undefined,
        `robot-accent-${appearance.accent}`,
        `robot-state-${visualState}`,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={`${bot.name}，${robotStatusLabel(status)}`}
      data-head={appearance.head}
      data-body={appearance.body}
      data-mobility={appearance.mobility}
      data-accessory={appearance.accessory}
    >
      <svg className="robot-head-art" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
        {appearance.head === "square" ? (
          <RelayHead accent={accent} />
        ) : appearance.head === "cat" ? (
          <ScoutHead accent={accent} />
        ) : (
          <RoundHead accent={accent} />
        )}
      </svg>
    </span>
  );
}

function RoundHead({ accent }: { accent: string }) {
  return (
    <>
      <path
        className="robot-antenna"
        d="m39 30-4-10"
        fill="none"
        stroke={BODY}
        strokeLinecap="round"
      />
      <circle className="robot-antenna-ball" cx="33" cy="16" r="4.3" fill={BODY} />
      <path
        d="M12 61C12 41 27 26 47 26C68 26 83 41 83 61V71C83 83 69 89 48 89C26 89 12 83 12 71Z"
        fill={BODY}
      />
      <path
        className="robot-jaw"
        d="M12 69C29 76 66 76 83 69V72C83 83 69 89 48 89C26 89 12 83 12 72Z"
        fill={accent}
      />
      <g className="robot-eyes is-standard" fill={EYE}>
        <rect x="29" y="44" width="10" height="19" rx="5" />
        <rect x="55" y="43" width="10" height="19" rx="5" />
      </g>
      <g className="robot-eyes is-micro" fill={EYE}>
        <rect x="28" y="43" width="12" height="21" rx="6" />
        <rect x="54" y="43" width="12" height="21" rx="6" />
      </g>
    </>
  );
}

function RelayHead({ accent }: { accent: string }) {
  return (
    <>
      <rect x="6" y="44" width="13" height="25" rx="6.5" fill={BODY} />
      <rect x="77" y="44" width="13" height="25" rx="6.5" fill={BODY} />
      <path d="M11 52v9m74-9v9" stroke={accent} strokeWidth="4" strokeLinecap="round" />
      <path
        d="M17 45C17 33 25 26 38 26H58C71 26 79 33 79 45V72C79 83 69 88 48 88C27 88 17 83 17 72Z"
        fill={BODY}
      />
      <path
        className="robot-jaw"
        d="M17 70C33 74 63 74 79 70V73C79 83 68 88 48 88C28 88 17 83 17 73Z"
        fill={accent}
      />
      <g className="robot-eyes is-standard" fill={EYE}>
        <rect x="31" y="46" width="10" height="16" rx="5" />
        <rect x="55" y="46" width="10" height="16" rx="5" />
      </g>
      <g className="robot-eyes is-micro" fill={EYE}>
        <rect x="30" y="44" width="12" height="20" rx="6" />
        <rect x="54" y="44" width="12" height="20" rx="6" />
      </g>
    </>
  );
}

function ScoutHead({ accent }: { accent: string }) {
  return (
    <>
      <path
        d="M14 61L17 22C17 18 20 17 23 20L36 32C43 30 53 30 60 32L73 20C76 17 79 18 79 22L82 61V72C82 83 68 89 48 89C28 89 14 83 14 72Z"
        fill={BODY}
      />
      <path
        className="robot-jaw"
        d="M14 70C29 76 67 76 82 70V73C82 83 68 89 48 89C28 89 14 83 14 73Z"
        fill={accent}
      />
      <g className="robot-eyes is-standard" fill={EYE}>
        <rect x="29" y="47" width="10" height="18" rx="5" />
        <rect x="55" y="43" width="10" height="19" rx="5" transform="rotate(-9 60 52.5)" />
      </g>
      <g className="robot-eyes is-micro" fill={EYE}>
        <rect x="28" y="46" width="12" height="19" rx="6" />
        <rect x="54" y="42" width="12" height="20" rx="6" />
      </g>
    </>
  );
}

function appearanceForBot(bot: Bot): BotAppearance {
  const seed = Array.from(`${bot.id}:${bot.name}`).reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    7,
  );
  const heads: BotHeadShape[] = ["round", "square", "cat"];
  const bodies: BotBodyShape[] = ["classic", "tall", "cape", "armor", "storage"];
  const mobility: BotMobility[] = ["feet", "single-wheel", "dual-wheel", "hover"];
  const accessories: BotAccessory[] = [
    "none",
    "headphones",
    "backpack",
    "trench",
    "arm",
    "toolbox",
  ];
  const accents: BotAppearance["accent"][] = ["green", "yellow", "red", "blue"];
  return {
    head: heads[seed % heads.length] ?? defaultBotAppearance.head,
    body: bodies[(seed >>> 3) % bodies.length] ?? defaultBotAppearance.body,
    mobility: mobility[(seed >>> 6) % mobility.length] ?? defaultBotAppearance.mobility,
    accessory: accessories[(seed >>> 9) % accessories.length] ?? defaultBotAppearance.accessory,
    accent: accents[(seed >>> 12) % accents.length] ?? defaultBotAppearance.accent,
  };
}

type RobotVisualState =
  | "idle"
  | "queued"
  | "running"
  | "approval"
  | "blocked"
  | "takeover"
  | "offline"
  | "completed"
  | "failed";

export function robotVisualState(status: RobotStatus): RobotVisualState {
  const states: Record<RobotStatus, RobotVisualState> = {
    idle: "idle",
    queued: "queued",
    assigned: "queued",
    running: "running",
    waiting_approval: "approval",
    blocked: "blocked",
    human_takeover: "takeover",
    offline: "offline",
    completed: "completed",
    failed: "failed",
    cancelled: "failed",
  };
  return states[status];
}

function robotStatusLabel(status: RobotStatus): string {
  const labels: Record<RobotStatus, string> = {
    idle: "待命",
    queued: "已接单",
    assigned: "已分配",
    running: "执行中",
    waiting_approval: "待批准",
    blocked: "已阻塞",
    human_takeover: "人工接管中",
    offline: "离线",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status];
}
