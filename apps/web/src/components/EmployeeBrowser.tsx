import type { Bot } from "@openbot/domain";
import type { BrowserAction, BrowserSessionView } from "@openbot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserCommand, closeBrowser, openBrowser } from "../api";
import { CloseIcon } from "./Icons";
import { RobotAvatar } from "./RobotAvatar";
import { useModalDialog } from "./useModalDialog";
import "./EmployeeBrowser.css";

const endedHostErrors: Record<string, string> = {
  browser_host_identity_changed: "设备身份已变化，无法继续使用原浏览器。登录状态不会自动迁移。",
  browser_host_connection_changed: "浏览器连接已变化，请重新连接。",
  browser_original_host_identity_unverified: "无法确认原浏览器与当前设备的关联，已停止连接。",
  browser_route_changed: "浏览器设备配置已变化，请重新连接。",
};

function browserError(cause: unknown, fallback: string) {
  if (cause instanceof ApiError && endedHostErrors[cause.message])
    return endedHostErrors[cause.message];
  return cause instanceof Error ? cause.message : fallback;
}

export function EmployeeBrowser({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  const [session, setSession] = useState<BrowserSessionView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [address, setAddress] = useState("");
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
  const sessionRef = useRef<BrowserSessionView | undefined>(undefined);
  const inFlight = useRef(false);
  const flightDone = useRef<Promise<void>>(Promise.resolve());
  const manualPending = useRef(false);
  const alive = useRef(true);
  const imageRef = useRef<HTMLImageElement>(null);

  const apply = useCallback((next: BrowserSessionView) => {
    if (!alive.current) return;
    sessionRef.current = next;
    setSession(next);
  }, []);

  const send = useCallback(
    async (action: BrowserAction) => {
      if (action.kind === "observe" && (inFlight.current || manualPending.current)) return;
      if (action.kind !== "observe") {
        if (manualPending.current) return;
        manualPending.current = true;
        setBusy(true);
        // A user action waits for an observation already in flight; it is never silently dropped.
        await flightDone.current;
      }
      const current = sessionRef.current;
      if (!current || !alive.current) {
        manualPending.current = false;
        if (alive.current) setBusy(false);
        return;
      }
      inFlight.current = true;
      let finishFlight: () => void = () => undefined;
      flightDone.current = new Promise<void>((resolve) => {
        finishFlight = resolve;
      });
      try {
        const next = await browserCommand(current.id, action);
        if (sessionRef.current?.id !== current.id) return;
        apply(next);
        setError(undefined);
        if (action.kind === "navigate") setAddress(next.frame?.url ?? "");
      } catch (cause) {
        if (!alive.current) return;
        setError(browserError(cause, "浏览器暂时不可用。"));
        if (
          cause instanceof ApiError &&
          ([401, 403, 404].includes(cause.status) || endedHostErrors[cause.message])
        ) {
          sessionRef.current = undefined;
          setSession(undefined);
          setText("");
          setAddress("");
        } else {
          // A failed request cannot prove that the old frame or input lease is still current.
          // Observation may refresh state, but the uncertain input is never sent again.
          const { controlExpiresAt: _expiry, frame: _frame, ...view } = current;
          apply({ ...view, control: "paused" });
          setText("");
          setAddress("");
        }
      } finally {
        inFlight.current = false;
        finishFlight();
        if (action.kind !== "observe") {
          manualPending.current = false;
          if (alive.current) setBusy(false);
        }
      }
    },
    [apply],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit reconnect replaces the view grant without reloading the employee.
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let id: string | undefined;
    setOpening(true);
    setError(undefined);
    // Defer acquisition until after effect cleanup so Strict Mode never creates a duplicate grant.
    void Promise.resolve()
      .then(() => (disposed ? undefined : openBrowser(bot.id)))
      .then(async (next) => {
        if (!next) return;
        id = next.id;
        if (disposed) {
          await closeBrowser(id).catch(() => undefined);
          return;
        }
        apply(next);
        await send({ kind: "observe" });
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(browserError(cause, "无法打开浏览器。"));
      })
      .finally(() => {
        if (!disposed) setOpening(false);
      });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void send({ kind: "observe" });
    }, 1500);
    return () => {
      disposed = true;
      alive.current = false;
      clearInterval(timer);
      sessionRef.current = undefined;
      if (id) void closeBrowser(id).catch(() => undefined);
    };
  }, [bot.id, attempt, apply, send]);

  const frame = session?.frame;
  const mine =
    session?.control === "mine" && Date.parse(session.controlExpiresAt ?? "") > Date.now();
  const controlLabel = mine
    ? "你正在控制"
    : session?.controlAvailable === false
      ? "仅查看"
      : session?.control === "other"
        ? "其他窗口正在控制"
        : session?.control === "paused" || session?.control === "mine"
          ? "已暂停"
          : "可以接管";
  // 交还 Bot is always offered while the Owner holds control; 接管 only when nobody else does.
  const takeable = mine || (session?.control !== "other" && session?.controlAvailable !== false);
  const keys = [
    ["ControlOrMeta+A", "全选"],
    ["Backspace", "退格"],
    ["Enter", "回车"],
    ["Tab", "Tab"],
  ] as const;
  // EmployeeBrowser artboard: header with the address, the live frame on grey, a typing row,
  // and a footer that says where the browser runs and what it keeps.
  return (
    <dialog ref={dialogRef} className="employee-browser" aria-labelledby="employee-browser-title">
      <header className="browser-header">
        <span className="browser-title">
          <RobotAvatar bot={bot} compact />
          <h2 id="employee-browser-title">{bot.name} 的浏览器</h2>
          {session ? (
            <span className={`browser-control${mine ? " is-mine" : ""}`}>{controlLabel}</span>
          ) : null}
        </span>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            const url = /^https?:\/\//i.test(address) ? address : `https://${address}`;
            void send({ kind: "navigate", url });
          }}
        >
          <label className="sr-only" htmlFor="browser-address-input">
            网址
          </label>
          <input
            id="browser-address-input"
            type="text"
            inputMode="url"
            placeholder={
              frame?.url && frame.url !== "about:blank" ? frame.url : "接管后输入网址，按回车前往"
            }
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={!mine || busy}
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        <span className="browser-header-actions">
          {session ? (
            <button
              type="button"
              className={`ob-pill${mine || takeable ? " is-primary" : ""}`}
              disabled={busy || !takeable}
              onClick={() => void send({ kind: mine ? "release" : "take" })}
            >
              {session.controlAvailable === false ? "仅查看" : mine ? "交还 Bot" : "接管浏览器"}
            </button>
          ) : null}
          <button
            type="button"
            className="browser-close"
            aria-label="关闭浏览器"
            onClick={closeDialog}
          >
            <CloseIcon />
          </button>
        </span>
      </header>
      <div className="browser-body">
        {error ? (
          <div className="browser-error" role="alert">
            <span>{error}</span>
            {!session && !opening ? (
              <button
                type="button"
                className="ob-pill is-small"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重新连接
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="browser-viewport">
          {frame ? (
            <button
              className={`browser-screen ${mine ? "controlling" : ""}`}
              type="button"
              disabled={!mine || busy}
              aria-label="浏览器画面，接管后点击网页"
              onClick={(event) => {
                const rect = imageRef.current?.getBoundingClientRect();
                if (!rect) return;
                const x = Math.max(
                  0,
                  Math.min(
                    frame.width - 1,
                    ((event.clientX - rect.left) * frame.width) / rect.width,
                  ),
                );
                const y = Math.max(
                  0,
                  Math.min(
                    frame.height - 1,
                    ((event.clientY - rect.top) * frame.height) / rect.height,
                  ),
                );
                void send({ kind: "click", x, y });
              }}
            >
              <img
                ref={imageRef}
                src={`data:image/png;base64,${frame.base64}`}
                alt={`网页：${frame.url}`}
                draggable={false}
              />
            </button>
          ) : (
            <div className="browser-empty">
              <strong>{opening ? "正在连接浏览器…" : "还没有画面"}</strong>
              <span>
                {opening
                  ? "浏览器在工作电脑上启动，第一次连接可能要等一会儿。"
                  : "确认工作电脑在线后，点「重新连接」。"}
              </span>
            </div>
          )}
        </div>
        <div className="browser-controls">
          <form
            className="browser-input"
            onSubmit={(event) => {
              event.preventDefault();
              const value = text;
              setText("");
              void send({ kind: "type", text: value });
            }}
          >
            <label className="sr-only" htmlFor="browser-text-input">
              输入到网页当前字段
            </label>
            <input
              id="browser-text-input"
              type={secret ? "password" : "text"}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="先点网页里的输入框，再在这里输入或粘贴，按回车发送"
              autoComplete="off"
              maxLength={4096}
              disabled={!mine || busy}
            />
            <label className="browser-secret">
              <input
                type="checkbox"
                checked={secret}
                onChange={(event) => setSecret(event.target.checked)}
              />
              隐藏
            </label>
          </form>
          <fieldset className="browser-keys" aria-label="浏览器键盘和滚动">
            {keys.map(([key, label]) => (
              <button
                className="ob-pill is-small"
                type="button"
                key={key}
                disabled={!mine || busy}
                onClick={() => void send({ kind: "key", key })}
              >
                {label}
              </button>
            ))}
            <button
              className="ob-pill is-small"
              type="button"
              aria-label="向上滚动"
              disabled={!mine || busy}
              onClick={() => void send({ kind: "scroll", deltaY: -500 })}
            >
              ↑
            </button>
            <button
              className="ob-pill is-small"
              type="button"
              aria-label="向下滚动"
              disabled={!mine || busy}
              onClick={() => void send({ kind: "scroll", deltaY: 500 })}
            >
              ↓
            </button>
            <button
              className="ob-pill is-small"
              type="button"
              aria-label="刷新画面"
              disabled={!session || busy}
              onClick={() => void send({ kind: "observe" })}
            >
              刷新
            </button>
          </fieldset>
        </div>
      </div>
      <footer className="browser-footer">
        <span>
          {/* Wording verified against the 服务电脑 in C20 (#159). */}在{" "}
          {session?.nodeName ?? "工作电脑"} 上运行 · 登录状态保存在这台工作电脑，清除浏览数据会移除
          · 这个窗口的实时画面不保存为文件
          <span className="browser-updated" role="status">
            {busy
              ? " · 正在操作…"
              : frame
                ? ` · 画面更新于 ${new Date(frame.capturedAt).toLocaleTimeString()}`
                : ""}
          </span>
        </span>
        <span>
          {mine
            ? "接管后关闭窗口，Bot 会保持暂停；重新打开并点「交还 Bot」后才会继续"
            : session?.controlAvailable === false
              ? "这个浏览器只能查看，还没有开启接管"
              : "接管后可以点网页、输入文字和滚动"}
        </span>
      </footer>
    </dialog>
  );
}
