// 进入 OpenBot sign-in screen: the Owner's password, with first-run progress on Desktop.
import { type FormEvent, useState } from "react";
import { ApiError } from "../api";
import { OnboardingFrame } from "./Onboarding";

export function LoginScreen({
  ownerName,
  progress = false,
  onLogin,
}: {
  ownerName?: string;
  /** Show the first-run progress (Desktop); the Web sign-in has no setup steps. */
  progress?: boolean;
  onLogin(password: string): Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || password.length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onLogin(password);
    } catch (cause) {
      setError(loginErrorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <OnboardingFrame
      step={progress ? 2 : undefined}
      avatar={{ character: "round", accent: "green" }}
      title="进入 OpenBot"
      description={`${ownerName ? `${ownerName}，` : ""}输入 Owner 密码。`}
      width={380}
      offset={140}
      titleId="login-title"
    >
      <form className="ob-setup-form" onSubmit={handleSubmit}>
        <label className="ob-setup-field">
          Owner 密码
          <input
            id="owner-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入密码"
          />
        </label>
        {error ? (
          <p className="ob-setup-error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="ob-setup-primary" type="submit" disabled={submitting || !password}>
          {submitting ? "正在验证…" : "登录"}
        </button>
      </form>
      <span className="ob-setup-footnote">密码只发送给你自己的 OpenBot。</span>
    </OnboardingFrame>
  );
}

function loginErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) return "密码不正确，请重试。";
  if (cause instanceof ApiError && cause.status === 429) return "尝试次数过多，请稍后再试。";
  return cause instanceof Error ? cause.message : "暂时无法登录 OpenBot。";
}
