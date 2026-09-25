import type { Bot } from "@openbot/domain";
import type { BrowserAction, BrowserSessionView } from "@openbot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, browserCommand, closeBrowser, openBrowser } from "../api";
import { CloseIcon } from "./Icons";
import { useModalDialog } from "./useModalDialog";
import "./EmployeeBrowser.css";

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
        setError(cause instanceof Error ? cause.message : "浏览器暂时不可用。");
        if (cause instanceof ApiError && cause.status === 404) {
          sessionRef.current = undefined;
          setSession(undefined);
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
        if (!disposed) setError(cause instanceof Error ? cause.message : "无法打开浏览器。");
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
    : session?.control === "other"
      ? "其他窗口正在控制"
      : session?.control === "paused" || session?.control === "mine"
        ? "已暂停，等待接管"
        : "员工浏览器";

  return (
    <dialog ref={dialogRef} className="employee-browser" aria-labelledby="employee-browser-title">
      <header className="browser-header">
        <div>
          <h2 id="employee-browser-title">{bot.name} 的浏览器</h2>
          <p>
            {session?.nodeName ?? "工作主机"} · {controlLabel}
          </p>
        </div>
        <div className="browser-header-actions">
          {session ? (
            <button
              type="button"
              className={mine ? "secondary-button" : "primary-button"}
              disabled={busy || session.control === "other"}
              onClick={() => void send({ kind: mine ? "release" : "take" })}
            >
              {mine ? "交还员工" : "接管浏览器"}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭浏览器"
            onClick={closeDialog}
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      <form
        className="browser-address"
        onSubmit={(event) => {
          event.preventDefault();
          const url = /^https?:\/\//i.test(address) ? address : `https://${address}`;
          void send({ kind: "navigate", url });
        }}
      >
        <label className="sr-only" htmlFor="browser-address-input">
          网页地址
        </label>
        <input
          id="browser-address-input"
          type="text"
          inputMode="url"
          placeholder={
            frame?.url === "about:blank" ? "接管后输入网址" : (frame?.url ?? "https://example.com")
          }
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          disabled={!mine || busy}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="secondary-button"
          type="submit"
          disabled={!mine || busy || !address.trim()}
        >
          前往
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!session || busy}
          onClick={() => void send({ kind: "observe" })}
        >
          刷新画面
        </button>
      </form>
      {error ? (
        <div className="browser-error" role="alert">
          {error}
          {!session && !opening ? (
            <button
              type="button"
              className="secondary-button"
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
                Math.min(frame.width - 1, ((event.clientX - rect.left) * frame.width) / rect.width),
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
              alt={`员工网页：${frame.url}`}
              draggable={false}
            />
          </button>
        ) : (
          <div className="browser-empty">
            <span>◉</span>
            <h3>{opening ? "正在连接员工浏览器…" : "等待浏览器画面"}</h3>
            <p>
              {opening
                ? "浏览器在工作主机上启动，首次连接可能需要稍等。"
                : "启动浏览器运行时和 Node 后，重新连接。"}
            </p>
          </div>
        )}
      </div>
      <footer className="browser-footer">
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
            placeholder="先点击网页字段，再输入或粘贴文本"
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
          <button className="secondary-button" type="submit" disabled={!mine || busy || !text}>
            输入
          </button>
        </form>
        <fieldset className="browser-keys" aria-label="浏览器键盘和滚动">
          {(
            [
              ["Tab", "Tab"],
              ["Enter", "Enter"],
              ["Backspace", "退格"],
              ["ControlOrMeta+A", "全选"],
            ] as const
          ).map(([key, label]) => (
            <button
              className="secondary-button"
              type="button"
              key={key}
              disabled={!mine || busy}
              onClick={() => void send({ kind: "key", key })}
            >
              {label}
            </button>
          ))}
          <button
            className="secondary-button"
            type="button"
            disabled={!mine || busy}
            onClick={() => void send({ kind: "scroll", deltaY: -500 })}
          >
            向上滚动
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!mine || busy}
            onClick={() => void send({ kind: "scroll", deltaY: 500 })}
          >
            向下滚动
          </button>
          <span role="status">
            {busy
              ? "正在操作…"
              : frame
                ? `画面更新于 ${new Date(frame.capturedAt).toLocaleTimeString()}`
                : "尚无画面"}
          </span>
        </fieldset>
        <p className="browser-hint">
          {mine
            ? "关闭窗口会暂停控制。完成操作后，请点击“交还员工”。"
            : "接管后可点击网页、输入文本和滚动。登录状态保留在员工工作主机。"}
        </p>
      </footer>
    </dialog>
  );
}
