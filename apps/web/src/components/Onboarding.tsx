// Launch screen and the shared first-run frame (Launch, Welcome, Install, Connect, Login,
// ModelSetup and WorkerSetup artboards) used by every start-up step.
import type { Bot, BotAppearance } from "@openbot/domain";
import { type ReactNode, useEffect, useState } from "react";
import { RobotAvatar } from "./RobotAvatar";
import "./Onboarding.css";

/*
 * Launch and first-run setup (Launch, LaunchMotion, Welcome, Install, Connect, Login, ModelSetup and
 * WorkerSetup artboards). These screens only present state owned by App and the Desktop bridge;
 * they never decide identity, routing or setup outcomes themselves.
 */

// The opening animation plays once per page session; later launch states start settled so
// moving between loading steps never replays it.
let introPlayed = false;
// Set while a launch screen is visible so the workspace can fade it out once (LaunchMotion).
let launchVisible = false;

export type SetupCharacter = "round" | "relay" | "scout";
const heads: Record<SetupCharacter, BotAppearance["head"]> = {
  round: "round",
  relay: "square",
  scout: "cat",
};

/** A decorative head from the avatar system; the screen's heading names the step. */
export function SetupAvatar({
  character,
  accent,
  size,
}: {
  character: SetupCharacter;
  accent: BotAppearance["accent"];
  size: number;
}) {
  const bot: Bot = {
    id: `setup-${character}`,
    name: "OpenBot",
    role: "",
    status: "idle",
    computerProfile: "none",
    appearance: {
      head: heads[character],
      body: "classic",
      mobility: "feet",
      accessory: "none",
      accent,
    },
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  return (
    <span className="ob-setup-avatar" aria-hidden="true" style={{ width: size, height: size }}>
      <RobotAvatar bot={bot} />
    </span>
  );
}

/**
 * The opening mark: the Round head wakes up over 900 ms, then blinks and sways its antenna while
 * waiting. Reduced motion (system or OpenBot setting) keeps only a 200 ms fade.
 */
export function LaunchMark() {
  return (
    <svg className="ob-launch-mark" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <g className="lm-head">
        <g className="lm-antenna">
          <path
            className="lm-stem"
            d="m39 30-4-10"
            fill="none"
            stroke="#20251F"
            strokeWidth="4"
            strokeLinecap="round"
            pathLength={1}
          />
          <circle className="lm-ball" cx="33" cy="16" r="4.3" fill="#20251F" />
        </g>
        <path
          className="lm-body"
          d="M12 61C12 41 27 26 47 26C68 26 83 41 83 61V71C83 83 69 89 48 89C26 89 12 83 12 71Z"
          fill="#20251F"
        />
        <path
          className="lm-jaw"
          d="M12 69C29 76 66 76 83 69V72C83 83 69 89 48 89C26 89 12 83 12 72Z"
          fill="#91CF4B"
        />
        <g className="lm-eye lm-eye-left">
          <rect className="lm-blink" x="29" y="44" width="10" height="19" rx="5" fill="#FAFBF7" />
        </g>
        <g className="lm-eye lm-eye-right">
          <rect className="lm-blink" x="55" y="43" width="10" height="19" rx="5" fill="#FAFBF7" />
        </g>
      </g>
    </svg>
  );
}

/** Launch artboard: opening, keychain and error states. */
export function LaunchScreen({
  title = "OpenBot",
  status,
  keychain = false,
  error,
  actions,
  footnote = "模型设置与已有对话会自动恢复",
}: {
  title?: string;
  status?: string | undefined;
  keychain?: boolean;
  error?: string | undefined;
  actions?: ReactNode;
  footnote?: string | null | undefined;
}) {
  const [settled] = useState(() => introPlayed);
  useEffect(() => {
    introPlayed = true;
    launchVisible = true;
  }, []);
  return (
    <main className={`ob-launch${settled ? " is-settled" : ""}${error ? " is-error" : ""}`}>
      <div className="ob-launch-body">
        <LaunchMark />
        <div className="ob-launch-copy">
          <h1>{error ? "启动需要处理" : title}</h1>
          {error ? (
            <p role="alert">{error}</p>
          ) : status ? (
            <p className="ob-launch-status" role="status">
              <span className="ob-launch-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {status}
            </p>
          ) : null}
        </div>
        {keychain && !error ? (
          <div className="ob-launch-note">
            <strong>系统可能会请求钥匙串密码</strong>
            <span>
              那是这台电脑的登录密码，不是 OpenBot 密码。确认是你安装的 OpenBot
              后，可以选「始终允许」，以后打开就不会再问。
            </span>
          </div>
        ) : null}
        {actions ? <div className="ob-launch-actions">{actions}</div> : null}
      </div>
      {footnote && !error ? <small className="ob-launch-footnote">{footnote}</small> : null}
    </main>
  );
}

/**
 * Fades the last launch screen out over the workspace once (LaunchMotion: 200 ms, no fly-in).
 * A timer, not animationend, removes it so reduced motion (no animation) still clears it.
 */
export function LaunchExit() {
  const [visible, setVisible] = useState(() => launchVisible);
  useEffect(() => {
    launchVisible = false;
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), 220);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!visible) return null;
  return (
    <div className="ob-launch ob-launch-exit is-settled" aria-hidden="true">
      <div className="ob-launch-body">
        <LaunchMark />
        <div className="ob-launch-copy">
          <h1>OpenBot</h1>
        </div>
      </div>
    </div>
  );
}

export type SetupStep = 1 | 2 | 3;
const stepLabels = ["这台电脑", "登录", "模型"] as const;

/**
 * Shared first-run frame: a 56 px row with the step progress (or a plain label for optional
 * steps), then a centred column with the avatar, heading and the step's content.
 */
export function OnboardingFrame({
  step,
  label,
  avatar,
  title,
  description,
  width = 420,
  offset = 120,
  titleId,
  children,
}: {
  step?: SetupStep | undefined;
  label?: string | undefined;
  avatar: { character: SetupCharacter; accent: BotAppearance["accent"]; size?: number };
  title: string;
  description?: ReactNode;
  width?: number;
  offset?: number;
  titleId: string;
  children: ReactNode;
}) {
  return (
    <main className="ob-onboarding" aria-labelledby={titleId}>
      <div className="ob-onboarding-top">
        {step ? (
          <ol className="ob-steps" aria-label="设置进度">
            {stepLabels.map((name, index) => (
              <li
                key={name}
                aria-current={index + 1 === step ? "step" : undefined}
                className={index + 1 === step ? "is-current" : undefined}
              >
                {index + 1} {name}
              </li>
            ))}
          </ol>
        ) : label ? (
          <span>{label}</span>
        ) : null}
      </div>
      <div
        className="ob-onboarding-body"
        style={{ width: `min(${width}px, 100%)`, marginTop: `min(${offset}px, 8vh)` }}
      >
        <SetupAvatar character={avatar.character} accent={avatar.accent} size={avatar.size ?? 80} />
        <div className="ob-onboarding-heading">
          <h1 id={titleId}>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {children}
      </div>
    </main>
  );
}
