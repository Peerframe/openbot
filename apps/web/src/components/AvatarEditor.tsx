import type { Bot, BotAppearance, EmployeeProfile } from "@openbot/domain";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ApiError, updateBotAppearance } from "../api";
import { freshAppearance } from "../quick-bot";
import { AVATAR_ACCENTS, appearanceForBot, RobotAvatar } from "./RobotAvatar";

const HEADS: { id: BotAppearance["head"]; label: string }[] = [
  { id: "round", label: "圆顶" },
  { id: "square", label: "耳罩" },
  { id: "cat", label: "猫耳" },
];

/**
 * 编辑头像 (BotInfo artboard): the rail's 88px avatar with a pencil, opening a popover with 随机,
 * 重置, the three heads and the eight jaw colours. Each choice is saved at once at the profile
 * revision (C9) — appearance is cosmetic and grants nothing. A stale revision re-reads the profile
 * and keeps the look the 服务电脑 has; 重置 returns to the look the popover opened with.
 */
export function AvatarEditor({
  bot,
  bots,
  profile,
  onChanged,
  onConflict,
}: {
  bot: Bot;
  bots: readonly Bot[];
  profile: EmployeeProfile | undefined;
  onChanged(bot: Bot): void;
  onConflict(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // The revision moves with each saved change, before the profile is read again.
  const [revision, setRevision] = useState(profile?.details.revision);
  const [initial, setInitial] = useState<BotAppearance>();
  const root = useRef<HTMLDivElement>(null);
  const current = bot.appearance ?? appearanceForBot(bot);

  useEffect(() => setRevision(profile?.details.revision), [profile?.details.revision]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function apply(next: BotAppearance) {
    if (saving || revision === undefined) return;
    if (next.head === current.head && next.accent === current.accent) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await updateBotAppearance(bot.id, {
        expectedRevision: revision,
        appearance: { ...current, head: next.head, accent: next.accent },
      });
      setRevision(result.revision);
      onChanged(result.bot);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError("头像刚在别处改过，已换成最新的样子。");
        await onConflict();
      } else setError("没能保存头像，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bi-avatar-editor" ref={root}>
      <button
        type="button"
        className="bi-avatar-button"
        aria-label="编辑头像"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={revision === undefined}
        onClick={() => {
          if (!open) setInitial(current);
          setError(undefined);
          setOpen(!open);
        }}
      >
        <RobotAvatar bot={bot} className="bi-avatar" />
        <span className="bi-avatar-pencil" aria-hidden="true">
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="bi-avatar-popover" role="dialog" aria-label="编辑头像" aria-busy={saving}>
          <div className="bi-avatar-head">
            <strong>编辑头像</strong>
            <span>
              <button
                type="button"
                className="ob-pill is-small"
                disabled={saving}
                onClick={() =>
                  void apply(freshAppearance(bots.filter((other) => other.id !== bot.id)))
                }
              >
                随机
              </button>
              <button
                type="button"
                className="bi-avatar-reset"
                disabled={
                  saving ||
                  !initial ||
                  (initial.head === current.head && initial.accent === current.accent)
                }
                onClick={() => initial && void apply(initial)}
              >
                重置
              </button>
            </span>
          </div>
          <fieldset className="bi-avatar-heads" aria-label="头型">
            {HEADS.map((head) => (
              <button
                key={head.id}
                type="button"
                aria-pressed={current.head === head.id}
                disabled={saving}
                onClick={() => void apply({ ...current, head: head.id })}
              >
                <RobotAvatar
                  bot={{ ...bot, appearance: { ...current, head: head.id } }}
                  className="bi-avatar-option"
                />
                {head.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="bi-avatar-accents" aria-label="下颌色">
            {AVATAR_ACCENTS.map((accent) => (
              <button
                key={accent.id}
                type="button"
                aria-pressed={current.accent === accent.id}
                aria-label={accent.label}
                disabled={saving}
                style={
                  {
                    "--swatch": accent.light,
                    "--swatch-dark": accent.dark,
                  } as CSSProperties
                }
                onClick={() => void apply({ ...current, accent: accent.id })}
              />
            ))}
          </fieldset>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : (
            <span className="bi-avatar-note">改动立即生效，名字旁的头像同步更新。</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
