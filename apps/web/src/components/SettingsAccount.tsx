import type { OwnerSessionDevice } from "@openbot/domain";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { ApiError, changeOwnerPassword, listOwnerSessions, revokeOtherOwnerSessions } from "../api";
import { SettingRow, SettingsGroup } from "./SettingsSections";

/** The Server's minimum (packages/protocol/src/owner-security.ts), counted in code points. */
const MIN_PASSWORD = 15;

/**
 * Settings → 账户与安全 (SettingsAccount artboard). Password change and session revocation are
 * Server-owned (backlog C2); passwords are sent once and never kept in client state after use.
 */
export function SettingsAccount({
  ownerName,
  onLogout,
  onShowAudit,
}: {
  ownerName?: string | undefined;
  onLogout?: (() => Promise<void>) | undefined;
  onShowAudit(): void;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [changing, setChanging] = useState(false);
  return (
    <>
      <SettingsGroup title="账户">
        <SettingRow title={ownerName ?? "我"} description="本地 Owner · 管理这台 OpenBot 的账户">
          {onLogout ? (
            <button
              className="secondary-button"
              type="button"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                try {
                  await onLogout();
                } finally {
                  setLoggingOut(false);
                }
              }}
            >
              {loggingOut ? "正在退出…" : "退出登录"}
            </button>
          ) : null}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="安全">
        <SettingRow title="Owner 密码" description="用来登录 OpenBot 和批准敏感操作">
          <button
            className="secondary-button"
            type="button"
            aria-expanded={changing}
            onClick={() => setChanging((open) => !open)}
          >
            修改密码
          </button>
        </SettingRow>
        {changing ? <PasswordForm onCancel={() => setChanging(false)} /> : null}
        <SessionsRow />
        <SettingRow title="审计记录" description="所有批准、敏感操作和配置变更都有记录">
          <button className="secondary-button" type="button" onClick={onShowAudit}>
            查看
          </button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Bot 的权限边界">
        <SettingRow
          title="敏感操作先问我"
          description="删除、安装和改权限永远需要你批准；其他操作按「审批与权限」里的规则。"
        >
          <span className="settings-tag">始终开启</span>
        </SettingRow>
      </SettingsGroup>
      <p className="settings-footnote">凭证只发送给你自己的 OpenBot。</p>
    </>
  );
}

function PasswordForm({ onCancel }: { onCancel(): void }) {
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const length = Array.from(next).length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (length < MIN_PASSWORD) return setError(`新密码至少 ${MIN_PASSWORD} 个字符。`);
    if (next !== confirm) return setError("两次输入的新密码不一致。");
    setSaving(true);
    setError(undefined);
    try {
      await changeOwnerPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      // The Server ended this session; the app returns to the login screen.
      window.dispatchEvent(new Event("openbot:unauthorized"));
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      setError(
        status === 401
          ? "当前密码不正确。"
          : status === 429
            ? "尝试次数过多，请稍后再试。"
            : status === 422
              ? `新密码至少 ${MIN_PASSWORD} 个字符，且不能使用示例密码。`
              : "无法修改密码，请稍后再试。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-password-form" onSubmit={(event) => void submit(event)}>
      <label className="ob-field" htmlFor={`${id}-current`}>
        当前密码
        <input
          id={`${id}-current`}
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </label>
      <label className="ob-field" htmlFor={`${id}-new`}>
        新密码
        <input
          id={`${id}-new`}
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          maxLength={1024}
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </label>
      <label className="ob-field" htmlFor={`${id}-confirm`}>
        再输入一次
        <input
          id={`${id}-confirm`}
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </label>
      <p className="settings-password-hint">
        至少 {MIN_PASSWORD} 个字符。修改后所有设备都要用新密码重新登录。
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <button className="ob-pill is-small" type="button" onClick={onCancel}>
          取消
        </button>
        <button className="ob-pill is-small is-primary" type="submit" disabled={saving}>
          {saving ? "正在修改…" : "修改密码"}
        </button>
      </footer>
    </form>
  );
}

function SessionsRow() {
  const [sessions, setSessions] = useState<OwnerSessionDevice[]>();
  const [error, setError] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await listOwnerSessions(signal);
      if (!signal?.aborted) {
        setSessions(value);
        setError(false);
      }
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const others = sessions?.filter((session) => !session.current).length ?? 0;
  return (
    <>
      <SettingRow
        title="登录的设备"
        description={
          error
            ? "无法读取登录的设备。"
            : sessions === undefined
              ? "正在读取…"
              : others > 0
                ? `本机（当前）· 另外 ${others} 台设备`
                : "只有本机（当前）"
        }
      >
        <button
          className="secondary-button"
          type="button"
          disabled={revoking || others === 0}
          onClick={async () => {
            setRevoking(true);
            try {
              const revoked = await revokeOtherOwnerSessions();
              setNotice(`已退出 ${revoked} 台其他设备。`);
              await load();
            } catch {
              setNotice("无法退出其他设备，请重试。");
            } finally {
              setRevoking(false);
            }
          }}
        >
          退出其他设备
        </button>
      </SettingRow>
      {notice ? (
        <p className="settings-success settings-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}
