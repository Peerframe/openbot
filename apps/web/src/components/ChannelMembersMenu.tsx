import type { Bot, Channel } from "@openbot/domain";
import { useEffect, useRef, useState } from "react";
import "./ChannelMembersMenu.css";
import { HashIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";

export function ChannelMembersMenu({
  showTitle = false,
  channel,
  bots,
  onJoin,
  onOpenBot,
  onRemove,
}: {
  showTitle?: boolean;
  channel: Channel;
  bots: Bot[];
  onJoin(botId: string): Promise<void>;
  onOpenBot(botId: string): void;
  onRemove?(botId: string): Promise<void>;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const members = bots.filter((bot) => channel.botIds.includes(bot.id));
  const available = bots.filter((bot) => !channel.botIds.includes(bot.id));
  const [selected, setSelected] = useState(available[0]?.id ?? "");
  const [joining, setJoining] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState<string>();
  const target = available.some((bot) => bot.id === selected) ? selected : (available[0]?.id ?? "");
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !disclosure.current?.contains(event.target) &&
        disclosure.current
      ) {
        disclosure.current.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  return (
    <details
      className="channel-members-menu"
      ref={disclosure}
      onKeyDown={(event) => {
        if (event.key === "Escape" && disclosure.current) {
          disclosure.current.open = false;
          disclosure.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label="频道成员" title={channel.directBotId ? "Bot 档案" : "频道详情与成员"}>
        {showTitle && (
          <span className="channel-heading">
            {!channel.directBotId && <HashIcon />}
            <strong>{channel.name}</strong>
          </span>
        )}
        <span className="channel-avatar-stack" aria-hidden="true">
          {members.slice(0, 4).map((bot) => (
            <RobotAvatar key={bot.id} bot={bot} compact />
          ))}
          {members.length > 4 && <span>+{members.length - 4}</span>}
          {members.length === 0 && <span>添加 Bot</span>}
        </span>
      </summary>
      <div className="channel-members-popover">
        <h2>
          频道成员 <span>{members.length}</span>
        </h2>
        <div className="channel-members-list">
          {members.map((bot) => (
            <div className="channel-member-row" key={bot.id}>
              <button
                type="button"
                className="channel-member-profile"
                aria-label={`打开 ${bot.name} 的员工档案`}
                title={`${bot.name}\n${bot.role}`}
                onClick={() => {
                  if (disclosure.current) disclosure.current.open = false;
                  onOpenBot(bot.id);
                }}
              >
                <RobotAvatar bot={bot} compact />
                <span className="channel-member-identity">
                  <strong className="channel-member-name">{bot.name}</strong>
                  <small className="channel-member-role">{bot.role}</small>
                </span>
              </button>
              {onRemove && !channel.directBotId ? (
                <button
                  type="button"
                  className="channel-member-remove"
                  aria-label={`将 ${bot.name} 移出频道`}
                  title="移出频道并停止该 Bot 的活动任务，保留历史消息"
                  disabled={Boolean(removing) || joining}
                  onClick={() => {
                    if (removing) return;
                    setRemoving(bot.id);
                    setError(undefined);
                    void onRemove(bot.id)
                      .catch((cause: unknown) =>
                        setError(cause instanceof Error ? cause.message : "无法移出频道。"),
                      )
                      .finally(() => setRemoving(undefined));
                  }}
                >
                  {removing === bot.id ? "移除中…" : "移除"}
                </button>
              ) : null}
            </div>
          ))}
          {members.length === 0 ? <p>频道还没有 Bot</p> : null}
        </div>
        {!channel.directBotId && available.length > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (joining || !target) return;
              setJoining(true);
              setError(undefined);
              void onJoin(target)
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : "无法加入频道。"),
                )
                .finally(() => setJoining(false));
            }}
          >
            <label htmlFor={`join-${channel.id}`}>添加 Bot</label>
            <div>
              <select
                id={`join-${channel.id}`}
                value={target}
                disabled={joining}
                onChange={(event) => setSelected(event.target.value)}
              >
                {available.map((bot) => (
                  <option value={bot.id} key={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={joining}>
                {joining ? "添加中…" : "添加"}
              </button>
            </div>
          </form>
        ) : null}
        {error ? (
          <p className="composer-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
