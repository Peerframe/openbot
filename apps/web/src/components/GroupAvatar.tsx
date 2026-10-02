import type { Bot, BotStatus, RunStatus } from "@openbot/domain";
import type { CSSProperties } from "react";
import { avatarPresence, RobotAvatar } from "./RobotAvatar";
import "./GroupAvatar.css";

type MemberStatus = BotStatus | RunStatus;

/**
 * A 频道's avatar (GroupAvatars artboard). At most three heads; the first member is in front and the
 * order never follows status. 0 Bots: a # tile. 1: the head plus a # badge, so a 频道 never looks
 * like a 单聊. 2: a diagonal pair. 3: two behind, one in front. 4+: two heads and a +N badge. Front
 * heads are cut out along their silhouette in the container's `--avatar-surface`. One status dot
 * covers the whole 频道: green while any member works, orange while one waits for the Owner.
 */
export function GroupAvatar({
  name,
  members,
  size,
  statusOf,
  className,
}: {
  name: string;
  members: readonly Bot[];
  size: number;
  /** Current task status per Bot, when known; otherwise the Bot's own status is used. */
  statusOf?: (bot: Bot) => MemberStatus;
  className?: string;
}) {
  const count = members.length;
  const [first, second, third] = members;
  const statuses = members.map((bot) => statusOf?.(bot) ?? bot.status);
  const presences = statuses.map(avatarPresence);
  const presence = presences.includes("working")
    ? "working"
    : presences.includes("attention")
      ? "attention"
      : undefined;
  const label =
    count === 0
      ? `${name}，还没有 Bot`
      : `${name}，${count} 名 Bot：${members.map((bot) => bot.name).join("、")}`;
  const px = (fraction: number) => Math.round(size * fraction * 10) / 10;
  const place = (left: number, top: number, width: number): CSSProperties => ({
    left: px(left),
    top: px(top),
    width: px(width),
    height: px(width),
  });
  const hasBadge = count === 1 || count >= 4;

  return (
    <span
      className={["group-avatar", `has-${Math.min(count, 4)}`, className].filter(Boolean).join(" ")}
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      {count === 0 ? (
        <span className="group-avatar-tile" style={{ fontSize: px(0.45) }}>
          #
        </span>
      ) : null}
      {count === 1 && first ? (
        <>
          <Head bot={first} style={place(0, 0, 0.74)} status={statuses[0]} />
          <span
            className="group-avatar-badge is-hash"
            style={{ ...place(0.58, 0.58, 0.42), fontSize: px(0.42 * 0.56) }}
          >
            #
          </span>
        </>
      ) : null}
      {count === 2 && first && second ? (
        <>
          <Head bot={second} style={place(0, 0, 0.66)} status={statuses[1]} />
          <Head bot={first} style={place(0.34, 0.34, 0.66)} status={statuses[0]} cutout />
        </>
      ) : null}
      {count === 3 && first && second && third ? (
        <>
          <Head bot={second} style={place(0, 0.02, 0.56)} status={statuses[1]} />
          <Head bot={third} style={place(0.44, 0, 0.56)} status={statuses[2]} cutout />
          <Head bot={first} style={place(0.19, 0.38, 0.62)} status={statuses[0]} cutout />
        </>
      ) : null}
      {count >= 4 && first && second ? (
        <>
          <Head bot={second} style={place(0.36, 0, 0.64)} status={statuses[1]} />
          <Head bot={first} style={place(0, 0.36, 0.64)} status={statuses[0]} cutout />
          <span
            className="group-avatar-badge is-count"
            style={{
              ...place(0.54, 0.54, 0.46),
              fontSize: px(0.46 * (count - 2 > 9 ? 0.4 : 0.48)),
            }}
          >
            +{count - 2}
          </span>
        </>
      ) : null}
      {presence && count > 0 ? (
        <span
          className={`group-avatar-dot is-${presence}${hasBadge ? " is-top" : ""}`}
          style={{ width: Math.max(8, Math.round(size * 0.28)) }}
        />
      ) : null}
    </span>
  );
}

function Head({
  bot,
  style,
  cutout = false,
  status,
}: {
  bot: Bot;
  style: CSSProperties;
  cutout?: boolean;
  status: MemberStatus | undefined;
}) {
  return (
    <span className="group-avatar-head" style={style} aria-hidden="true">
      {/* A head moves only while that Bot itself is working; the 频道 dot carries the summary. */}
      <RobotAvatar bot={bot} cutout={cutout} status={status ?? bot.status} presence="motion" />
    </span>
  );
}
