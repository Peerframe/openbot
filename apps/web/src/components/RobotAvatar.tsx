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

/** Jaw colours of matched lightness (DESIGN.md › Bot avatars v3); the Server accepts all eight (C10). */
const accentColors: Record<string, string> = {
  green: "#91CF4B",
  blue: "#5F7CDE",
  yellow: "#DFAD4F",
  red: "#E0785C",
  violet: "#9C7FE3",
  teal: "#3FB4A6",
  pink: "#E57BA8",
  slate: "#8C98A8",
};
const BODY = "#20251F";
const EYE = "#FAFBF7";

const ROUND_HEAD =
  "M12 61C12 41 27 26 47 26C68 26 83 41 83 61V71C83 83 69 89 48 89C26 89 12 83 12 71Z";
const RELAY_HEAD =
  "M15 45C15 33 24 26 37 26H59C72 26 81 33 81 45V72C81 83 70 88 48 88C26 88 15 83 15 72Z";
const SCOUT_HEAD =
  "M14 61L17 22C17 18 20 17 23 20L36 32C43 30 53 30 60 32L73 20C76 17 79 18 79 22L82 61V72C82 83 68 89 48 89C28 89 14 83 14 72Z";

/** What the status dot shows; idle and finished states show nothing (DESIGN.md › Bot avatars). */
export type AvatarPresence = "working" | "attention" | "offline" | undefined;

export function avatarPresence(status: RobotStatus): AvatarPresence {
  const state = robotVisualState(status);
  if (state === "running") return "working";
  if (state === "approval" || state === "blocked" || state === "takeover") return "attention";
  if (state === "offline") return "offline";
  return undefined;
}

/**
 * Frameless head-only Bot avatar (Avatars artboard v3). The stored head shape selects the
 * character — round → Round, square → Relay, cat → Scout — and the accent colours the jaw. Body,
 * mobility and accessory stay in the appearance data but are not drawn. Below 32px a container
 * query swaps in the micro drawing, so callers only set the rendered size; `compact` sets a 24px
 * default.
 *
 * Status never changes the head's shape or colour. With `presence="dot"` a status dot sits at the
 * lower right and a working head moves; `presence="motion"` moves without the dot (rail members,
 * which show a label instead). `cutout` knocks the silhouette out of whatever is behind it, using
 * the container's `--avatar-surface`, so overlapping heads in a group stay separate.
 */
export function RobotAvatar({
  bot,
  className,
  compact = false,
  status = bot.status,
  presence,
  cutout = false,
}: {
  bot: Bot;
  className?: string;
  compact?: boolean;
  status?: RobotStatus;
  presence?: "dot" | "motion" | undefined;
  cutout?: boolean;
}) {
  const appearance = bot.appearance ?? appearanceForBot(bot);
  const visualState = robotVisualState(status);
  const accent = accentColors[appearance.accent] ?? accentColors.green ?? "#91CF4B";
  const state = presence ? avatarPresence(status) : undefined;

  return (
    <span
      className={[
        "robot-avatar",
        className,
        compact ? "compact" : undefined,
        `robot-accent-${appearance.accent}`,
        `robot-state-${visualState}`,
        state === "working" ? "is-working" : undefined,
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
        {cutout ? <Cutout head={appearance.head} /> : null}
        <g className="robot-head">
          {appearance.head === "square" ? (
            <RelayHead accent={accent} />
          ) : appearance.head === "cat" ? (
            <ScoutHead accent={accent} />
          ) : (
            <RoundHead accent={accent} />
          )}
        </g>
      </svg>
      {presence === "dot" && state ? <span className={`robot-dot is-${state}`} /> : null}
    </span>
  );
}

function Cutout({ head }: { head: BotAppearance["head"] }) {
  return (
    <g className="robot-cutout">
      {head === "square" ? (
        <>
          <path d={RELAY_HEAD} />
          <rect x="5" y="44" width="12" height="25" rx="6" />
          <rect x="79" y="44" width="12" height="25" rx="6" />
        </>
      ) : head === "cat" ? (
        <path d={SCOUT_HEAD} />
      ) : (
        <>
          <path d={ROUND_HEAD} />
          <path d="m39 30-4-10" />
          <circle cx="33" cy="16" r="5.6" />
        </>
      )}
    </g>
  );
}

function RoundHead({ accent }: { accent: string }) {
  return (
    <>
      <g className="robot-antenna">
        <path
          className="robot-antenna-stem"
          d="m39 30-4-10"
          fill="none"
          stroke={BODY}
          strokeLinecap="round"
        />
        <circle className="robot-ball is-standard" cx="33" cy="16" r="4.3" fill={BODY} />
        <circle className="robot-ball is-micro" cx="33" cy="16" r="5.6" fill={BODY} />
      </g>
      <path d={ROUND_HEAD} fill={BODY} />
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
      <rect x="5" y="44" width="12" height="25" rx="6" fill={BODY} />
      <rect x="79" y="44" width="12" height="25" rx="6" fill={BODY} />
      <path
        className="robot-ear-light"
        d="M11 52v9M85 52v9"
        stroke={accent}
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path d={RELAY_HEAD} fill={BODY} />
      <path
        className="robot-jaw"
        d="M15 70C32 74 64 74 81 70V73C81 83 70 88 48 88C26 88 15 83 15 73Z"
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
    <g className="robot-scout">
      <path className="robot-scout-head" d={SCOUT_HEAD} fill={BODY} stroke={BODY} />
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
    </g>
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
  // Kept at the original four so a Bot without a stored look keeps the colour it always had.
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
    running: "工作中",
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
