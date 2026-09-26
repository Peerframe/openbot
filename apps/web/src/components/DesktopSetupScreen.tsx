import { type FormEvent, useState } from "react";
import type {
  DesktopSetupPlanInput,
  DesktopSetupPlanState,
  SaveDesktopSetupPlanResult,
} from "../desktop-runtime";
import { OpenBotMark } from "./OpenBotMark";

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
    <main className="login-screen desktop-setup-screen">
      <section className="login-card desktop-setup-card" aria-labelledby="desktop-setup-title">
        <OpenBotMark className="onboarding-mark" />
        <h1 id="desktop-setup-title">开始使用 OpenBot</h1>
        <p className="login-copy">选择这台电脑的用途，其余配置交给 OpenBot。</p>
        {state.status === "invalid" ? (
          <p role="alert" className="connection-warning">
            已保存的安装计划无效，请重新选择。
          </p>
        ) : null}
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="setup-role-options">
            <legend className="visually-hidden">这台电脑的用途</legend>
            {(
              [
                [
                  "host",
                  "作为服务电脑",
                  "在本机保存数据、运行 OpenBot 服务。自动安装，无需 Docker。",
                ],
                [
                  "client",
                  "连接服务电脑",
                  "连接已经部署的 OpenBot，在这里管理工作区和已授权的工作电脑。",
                ],
              ] as const
            )
              .filter(([value]) => value !== "host" || canHost)
              .map(([value, title, description]) => (
                <label className={`setup-mode ${mode === value ? "selected" : ""}`} key={value}>
                  <input
                    id={`desktop-mode-${value}`}
                    type="radio"
                    name="desktop-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  <span>
                    <strong>
                      {title}
                      {value === "host" ? <em>首次使用</em> : null}
                    </strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
          </fieldset>
          <p className="setup-next-step">
            {mode === "host"
              ? "接下来：安装本地服务 → 配置 Bot 模型 → 开始使用"
              : "接下来：连接服务电脑 → 登录 → 开始使用"}
          </p>
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "正在准备…" : mode === "host" ? "安装并继续" : "继续连接"}
          </button>
          {onCancel ? (
            <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
              返回设置
            </button>
          ) : null}
        </form>
        <p className="login-note">
          {canHost
            ? "模型和工作电脑可以随时在设置中调整。"
            : "本版本在这台电脑上连接远程 Python 服务。本地服务适用于 Apple Silicon Mac；已有本地数据会保留。"}
        </p>
      </section>
    </main>
  );
}
