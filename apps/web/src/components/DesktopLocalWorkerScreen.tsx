import { type FormEvent, useState } from "react";
import type {
  DesktopLocalWorkerOperationResult,
  DesktopLocalWorkerState,
} from "../desktop-runtime";
import { OnboardingFrame } from "./Onboarding";

export function DesktopLocalWorkerScreen({
  onContinue,
  onEnable,
  onOpenSettings,
  onRefresh,
  onSetup,
  state,
}: {
  onContinue(): void;
  onEnable(): Promise<DesktopLocalWorkerOperationResult>;
  onOpenSettings(): Promise<DesktopLocalWorkerOperationResult>;
  onRefresh(): Promise<DesktopLocalWorkerState>;
  onSetup(nodeId: string): Promise<DesktopLocalWorkerOperationResult>;
  state: DesktopLocalWorkerState;
}) {
  const [nodeId, setNodeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(operation: () => Promise<DesktopLocalWorkerOperationResult>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation();
      if (result.status === "failed") setError(localWorkerErrorMessage(result.code));
    } catch {
      setError("Desktop 暂时无法完成本机 Worker 配置，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nodeId.trim()) return;
    await run(() => onSetup(nodeId.trim()));
  }

  return (
    <OnboardingFrame
      label="可选步骤"
      avatar={{ character: "relay", accent: "blue" }}
      title="让这台电脑也能干活"
      description="设为工作电脑后，Bot 可以在这里执行任务。每一步改动仍按审批规则先问你。"
      width={440}
      offset={110}
      titleId="desktop-worker-title"
    >
      <WorkerStateSummary state={state} />

      {state.status === "not-configured" ? (
        <form className="ob-setup-form" onSubmit={submit}>
          <label className="ob-setup-field">
            电脑名称
            <input
              id="desktop-worker-node-id"
              autoCapitalize="none"
              autoComplete="off"
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
              placeholder="mac-studio-1"
              spellCheck={false}
              value={nodeId}
              onChange={(event) => setNodeId(event.target.value)}
            />
          </label>
          <p className="ob-setup-hint">
            服务会签发一次性绑定凭证；凭证不会出现在页面、文件、命令参数或日志里。
          </p>
          <button className="ob-setup-primary" disabled={busy || !nodeId.trim()} type="submit">
            {busy ? "正在配置…" : "配置并启用"}
          </button>
        </form>
      ) : null}

      {state.status === "disabled" ? (
        <button
          className="ob-setup-primary"
          disabled={busy}
          type="button"
          onClick={() => run(onEnable)}
        >
          {busy ? "正在启用…" : "启用这台工作电脑"}
        </button>
      ) : null}

      {state.status === "requires-approval" ? (
        <div className="ob-setup-row">
          <button
            className="ob-setup-primary"
            disabled={busy}
            type="button"
            onClick={() => run(onOpenSettings)}
          >
            打开「登录项」设置
          </button>
          <button
            className="ob-setup-secondary"
            disabled={busy}
            type="button"
            onClick={() => run(async () => ({ status: "succeeded", state: await onRefresh() }))}
          >
            刷新状态
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="ob-setup-error" role="alert">
          {error}
        </p>
      ) : null}

      <button className="ob-setup-link" disabled={busy} type="button" onClick={onContinue}>
        先跳过，以后在设置 › 工作主机里配置
      </button>
    </OnboardingFrame>
  );
}

function WorkerStateSummary({ state }: { state: DesktopLocalWorkerState }) {
  const content = {
    disabled: ["已绑定，尚未启用", "本机身份有效；启用后台项目后才能接收任务。"],
    enabled: ["已启用", "这台电脑已经可以作为 OpenBot 工作电脑。"],
    invalid: ["这台电脑的工作状态无效", "组件、配置或系统凭证未通过校验；不会自动放宽安全检查。"],
    "not-configured": ["等待配置", "给这台电脑起个名字，OpenBot 会通过已登录的服务完成绑定。"],
    "not-selected": ["当前计划未选择这一步", "你可以返回安装计划后重新选择。"],
    "requires-approval": [
      "等待 macOS 批准",
      "在「系统设置 › 通用 › 登录项与扩展」里允许 OpenBot 在后台运行。",
    ],
    unavailable: [
      "这个安装包不能配置工作电脑",
      "本平台的适配器或经过授权的组件不在这个安装包里；OpenBot 仍可正常使用。",
    ],
  }[state.status];
  const waiting = state.status === "requires-approval";
  return (
    <section className={`ob-worker-status is-${state.status}`} aria-live="polite">
      {waiting ? (
        <span className="ob-spinner" aria-hidden="true" />
      ) : (
        <span className="ob-step-icon" aria-hidden="true" />
      )}
      <span>
        <strong>{content[0]}</strong>
        <small>{content[1]}</small>
      </span>
    </section>
  );
}

export function localWorkerErrorMessage(
  code: Extract<DesktopLocalWorkerOperationResult, { status: "failed" }>["code"],
): string {
  switch (code) {
    case "invalid_node_id":
      return "电脑名称只能使用字母、数字、点、下划线、冒号和连字符。";
    case "not_selected":
      return "当前安装计划没有选择本机 Worker。";
    case "unavailable":
      return "当前平台或安装包没有可用的本机 Worker 组件。";
    case "authentication_required":
      return "登录会话已失效，请重新登录后再配置。";
    case "server_unavailable":
      return "Server 暂时无法签发一次性绑定凭证。";
    case "already_configured":
      return "本机已经存在 Worker 身份；请刷新后启用，避免静默覆盖。";
    case "busy":
      return "另一项本机 Worker 操作仍在进行。";
    case "native_failed":
      return "原生组件未通过校验或系统操作失败，未授予新的执行权限。";
  }
}
