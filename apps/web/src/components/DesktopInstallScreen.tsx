import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeServerState, OpenBotDesktopBridge } from "../desktop-runtime";
import { LaunchScreen, OnboardingFrame } from "./Onboarding";

const steps = [
  ["checking", "检查安装环境"],
  ["credentials", "读取系统保存的凭据"],
  ["database", "准备本地数据库"],
  ["server", "启动 OpenBot 服务"],
  ["connecting", "完成连接与配置"],
] as const;
export function DesktopInstallScreen({
  bridge,
  onReady,
  onBack,
}: {
  bridge: OpenBotDesktopBridge;
  onReady(serverUrl: string): void;
  onBack(): void;
}) {
  const [state, setState] = useState<NativeServerState>({ status: "idle" });
  const started = useRef(false);
  const active = useRef(true);
  const retained = useRef(false);
  const ready = useRef(onReady);
  ready.current = onReady;
  const install = useCallback(async () => {
    try {
      const existing = await bridge.getNativeServerState?.();
      if (!active.current) return;
      if (existing?.status === "ready") {
        ready.current(existing.serverUrl);
        return;
      }
      retained.current =
        (existing?.status === "idle" && existing.initialized === true) ||
        (existing?.status === "installing" && existing.mode === "resume") ||
        retained.current;
      setState({
        status: "installing",
        step: "checking",
        mode: retained.current ? "resume" : "initialize",
      });
      const result = await bridge.installNativeServer?.();
      if (!active.current) return;
      setState(result ?? { status: "failed", code: "unsupported_platform" });
      if (result?.status === "ready") ready.current(result.serverUrl);
    } catch {
      if (active.current) setState({ status: "failed", code: "installation_failed" });
    }
  }, [bridge]);
  useEffect(() => {
    active.current = true;
    if (!started.current) {
      started.current = true;
      void install();
    }
    const timer = window.setInterval(() => {
      void bridge
        .getNativeServerState?.()
        .then((next) => {
          if (active.current && next.status === "installing") setState(next);
        })
        .catch(() => undefined);
    }, 700);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [bridge, install]);
  const resume = retained.current || (state.status === "installing" && state.mode === "resume");
  const preparing = state.status === "idle";
  const current = state.status === "installing" ? steps.findIndex(([id]) => id === state.step) : -1;
  if (state.status === "failed") {
    return (
      <LaunchScreen
        error={
          state.code === "unsupported_platform"
            ? "此安装包尚不支持本机服务，请使用 Windows 或 macOS 原生安装包，或连接已有服务。"
            : state.code === "credential_unavailable"
              ? "系统未允许读取已保存的凭据。请解锁钥匙串后重试，无需重新输入模型密钥。弹窗里的密码是这台电脑的登录密码；确认是你安装的 OpenBot 后，可以选「始终允许」。"
              : "没能启动本机服务。请确认安装包完整、钥匙串可以访问后重试；已有的 Bot、对话和设置都不会丢。"
        }
        actions={
          <>
            <button className="ob-setup-primary" type="button" onClick={() => void install()}>
              重试
            </button>
            <button className="ob-setup-secondary" type="button" onClick={onBack}>
              更改连接方式
            </button>
          </>
        }
      />
    );
  }
  if (resume || preparing) {
    return (
      <LaunchScreen
        status={
          state.status === "installing" && state.step === "credentials"
            ? "正在读取系统保存的凭据"
            : "正在打开你的工作区"
        }
        keychain={state.status === "installing" && state.step === "credentials"}
      />
    );
  }
  return (
    <OnboardingFrame
      step={1}
      avatar={{ character: "round", accent: "green" }}
      title="正在准备你的 OpenBot"
      description="第一次需要在这台电脑上准备服务和数据库，大约一分钟。"
      width={440}
      offset={96}
      titleId="install-title"
    >
      <ol className="ob-install-steps" aria-label="准备进度" aria-live="polite">
        {steps.map(([id, label], index) => (
          <li
            key={id}
            aria-current={index === current ? "step" : undefined}
            className={
              index === current ? "is-current" : index > current ? "is-waiting" : undefined
            }
          >
            {index < current ? (
              <span className="ob-step-icon is-done" aria-hidden="true">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="5 12 10 17 19 7" />
                </svg>
              </span>
            ) : index === current ? (
              <span className="ob-spinner" aria-hidden="true" />
            ) : (
              <span className="ob-step-icon" aria-hidden="true" />
            )}
            <span className="ob-role-text">
              <span className="ob-install-label">{label}</span>
              {index === current && id === "credentials" ? (
                <small>如果系统弹出钥匙串窗口，请在那里输入电脑登录密码。</small>
              ) : null}
            </span>
            <span className="ob-install-state">
              {index < current ? "已完成" : index === current ? "进行中" : ""}
            </span>
          </li>
        ))}
      </ol>
      <span className="ob-setup-footnote" role="status">
        准备完成后，以后打开会直接回到工作区。
      </span>
    </OnboardingFrame>
  );
}
