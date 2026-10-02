import { type FormEvent, useState } from "react";
import type {
  ConfigureDesktopServerResult,
  DesktopConnectionState,
  DesktopSetupPlanInput,
} from "../desktop-runtime";
import { OnboardingFrame } from "./Onboarding";

export function DesktopConnectionScreen({
  canCancel = false,
  connection,
  onCancel,
  onChangePlan,
  onConfigure,
  setupPlan,
}: {
  canCancel?: boolean;
  connection: DesktopConnectionState;
  onCancel?(): void;
  onChangePlan?(): void;
  onConfigure(serverUrl: string): Promise<ConfigureDesktopServerResult>;
  setupPlan?: DesktopSetupPlanInput | undefined;
}) {
  const [serverUrl, setServerUrl] = useState(
    connection.status === "configured" ? connection.serverUrl : "",
  );
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || serverUrl.trim().length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onConfigure(serverUrl);
      if (result.status === "failed") setError(desktopConnectionErrorMessage(result.code));
      if (result.status !== "configured") setSubmitting(false);
    } catch {
      setError("Desktop 暂时无法完成连接，请重试。");
      setSubmitting(false);
    }
  }

  return (
    <OnboardingFrame
      step={1}
      avatar={{ character: "relay", accent: "blue" }}
      title="连接服务电脑"
      description={desktopConnectionCopy(setupPlan)}
      titleId="connection-title"
    >
      {connection.status === "invalid" ? (
        <p className="ob-setup-warning" role="alert">
          已保存的连接配置无效，请重新填写服务地址。
        </p>
      ) : null}
      <form className="ob-setup-form" onSubmit={handleSubmit}>
        <label className="ob-setup-field">
          服务地址
          <input
            id="desktop-server-url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoComplete="url"
            spellCheck={false}
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://openbot.example.com"
          />
        </label>
        <p className="ob-setup-hint">
          远程地址必须是 HTTPS；同一台电脑上可以用
          http://localhost。这里只保存地址，登录凭证另外保存。
        </p>
        {error ? (
          <p className="ob-setup-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="ob-setup-primary"
          type="submit"
          disabled={submitting || !serverUrl.trim()}
        >
          {submitting ? "正在检查…" : "检查并连接"}
        </button>
      </form>
      <div className="ob-setup-row">
        {canCancel ? (
          <button className="ob-setup-link" type="button" onClick={onCancel} disabled={submitting}>
            返回
          </button>
        ) : null}
        {onChangePlan ? (
          <button
            className="ob-setup-link"
            type="button"
            disabled={submitting}
            onClick={onChangePlan}
          >
            换一种方式
          </button>
        ) : null}
      </div>
    </OnboardingFrame>
  );
}

function desktopConnectionCopy(_plan?: DesktopSetupPlanInput): string {
  return "输入服务电脑上 OpenBot 的地址。连接后用同一套 Bot 和工作记录。";
}

export function desktopConnectionErrorMessage(
  code: Extract<ConfigureDesktopServerResult, { status: "failed" }>["code"],
): string {
  switch (code) {
    case "invalid_url":
      return "地址无效：远程服务电脑使用 HTTPS，本机可使用 localhost HTTP。";
    case "server_unreachable":
      return "无法连接该地址，请检查服务电脑、网络和证书。";
    case "server_redirected":
      return "该地址发生了重定向，请填写最终的服务电脑地址。";
    case "not_openbot_server":
      return "该地址没有返回可识别的 OpenBot 服务电脑。";
    case "confirmation_unavailable":
      return "系统确认窗口不可用，请重试。";
    case "storage_unavailable":
      return "无法安全保存连接配置，请检查应用数据目录后重试。";
  }
}
