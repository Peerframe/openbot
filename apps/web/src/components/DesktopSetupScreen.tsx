import { type FormEvent, useState } from "react";
import type {
  DesktopSetupPlanInput,
  DesktopSetupPlanState,
  SaveDesktopSetupPlanResult,
} from "../desktop-runtime";
import { SetupAvatar } from "./Onboarding";

export function DesktopSetupScreen({
  state,
  platform,
  arch,
  onSave,
  onCancel,
}: {
  state: DesktopSetupPlanState;
  platform?: string | undefined;
  arch?: string | undefined;
  onSave(plan: DesktopSetupPlanInput): Promise<SaveDesktopSetupPlanResult>;
  onCancel?: (() => void) | undefined;
}) {
  const canHost = platform === "darwin" && arch === "arm64";
  const [mode, setMode] = useState<"host" | "client">(
    canHost && (state.status !== "configured" || state.plan.mode === "host") ? "host" : "client",
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onSave({ mode, localWorker: false, plannedWorkerCount: 0 });
      if (result.status === "failed") {
        setError(
          result.code === "invalid_plan"
            ? "请选择有效的安装方式。"
            : "无法安全保存安装计划，请重试。",
        );
        setBusy(false);
      }
    } catch {
      setError("暂时无法保存，请重试。");
      setBusy(false);
    }
  }
  return (
    <main className="ob-onboarding" aria-labelledby="desktop-setup-title">
      <div className="ob-onboarding-top">
        <ol className="ob-steps" aria-label="设置进度">
          <li className="is-current" aria-current="step">
            1 这台电脑
          </li>
          <li>2 登录</li>
          <li>3 模型</li>
        </ol>
      </div>
      <div
        className="ob-onboarding-body"
        style={{ width: "min(480px, 100%)", marginTop: "min(76px, 6vh)" }}
      >
        <div className="ob-setup-avatars">
          <SetupAvatar character="relay" accent="blue" size={64} />
          <SetupAvatar character="round" accent="green" size={96} />
          <SetupAvatar character="scout" accent="yellow" size={64} />
        </div>
        <div className="ob-onboarding-heading">
          <h1 id="desktop-setup-title">欢迎使用 OpenBot</h1>
          <p>先决定这台电脑的用途，其余交给 OpenBot。</p>
        </div>
        {state.status === "invalid" ? (
          <p role="alert" className="ob-setup-warning">
            已保存的安装计划无效，请重新选择。
          </p>
        ) : null}
        <form className="ob-setup-form" onSubmit={submit}>
          <fieldset disabled={busy} className="ob-roles">
            <legend className="visually-hidden">这台电脑的用途</legend>
            {(
              [
                [
                  "host",
                  "作为服务电脑",
                  "数据保存在这台电脑，OpenBot 服务在这里运行。自动安装，无需 Docker。",
                ],
                ["client", "连接服务电脑", "连接已经部署好的 OpenBot，用同一套 Bot 和工作记录。"],
              ] as const
            )
              .filter(([value]) => value !== "host" || canHost)
              .map(([value, title, description]) => (
                <label className={`ob-role${mode === value ? " is-selected" : ""}`} key={value}>
                  <input
                    id={`desktop-mode-${value}`}
                    type="radio"
                    name="desktop-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  <span className="ob-role-text">
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <span className="ob-radio-dot" aria-hidden="true" />
                </label>
              ))}
          </fieldset>
          {error ? (
            <p className="ob-setup-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="ob-setup-primary" type="submit" disabled={busy}>
            {busy ? "正在准备…" : mode === "host" ? "安装并继续" : "继续连接"}
          </button>
          <span className="ob-setup-footnote">
            {mode === "host"
              ? "接下来：准备本机服务 → 登录 → 选一个模型。都可以随时在设置里改。"
              : "接下来：连接服务电脑 → 登录 → 开始使用。"}
          </span>
          {!canHost ? (
            <span className="ob-setup-footnote">
              这台电脑连接远程 OpenBot 服务；本机服务适用于 Apple Silicon Mac。已有本地数据会保留。
            </span>
          ) : null}
          {onCancel ? (
            <button type="button" className="ob-setup-link" disabled={busy} onClick={onCancel}>
              返回设置
            </button>
          ) : null}
        </form>
      </div>
    </main>
  );
}
