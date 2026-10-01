import type { Bot, BrowserMaintenanceResult } from "@openbot/domain";
import { useState } from "react";
import { ApiError, maintainEmployeeBrowser } from "../api";
import { EmployeeBrowser } from "./EmployeeBrowser";
import { RobotAvatar } from "./RobotAvatar";
import { SettingRow, SettingsGroup } from "./SettingsSections";

type Operation = "status" | "restart" | "clear";

function failure(cause: unknown): string {
  const status = cause instanceof ApiError ? cause.status : 0;
  if (status === 503) return "浏览器主机暂时不可用，或还不支持维护操作。";
  if (status === 409) return "浏览器正忙，或主机已经变化。请稍后再试。";
  if (status === 404) return "这个 Bot 已不存在。";
  if (status === 403) return "这个 Bot 现在不使用员工浏览器。";
  return "操作没有完成，浏览器状态未确认。";
}

/**
 * Settings → 员工浏览器 (SettingsBrowser artboard; backlog C6). Each Docker Bot has its own
 * browser on its bound host. Reading status opens a short Owner session, so it runs only on
 * request; restart and clear pause the browser, and clear asks for confirmation first.
 * Download and screenshot retention is deferred and not shown.
 */
export function SettingsBrowser({ bots }: { bots: Bot[] }) {
  const browserBots = bots.filter((bot) => bot.computerProfile === "docker-linux");
  const [results, setResults] = useState<Record<string, BrowserMaintenanceResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [confirmClear, setConfirmClear] = useState<string>();
  const [viewing, setViewing] = useState<Bot>();

  async function run(bot: Bot, operation: Operation) {
    if (busy) return;
    setBusy(`${bot.id}:${operation}`);
    setErrors(({ [bot.id]: _cleared, ...rest }) => rest);
    try {
      const result = await maintainEmployeeBrowser(bot.id, operation);
      setResults((current) => ({ ...current, [bot.id]: result }));
      if (operation === "clear") setConfirmClear(undefined);
    } catch (cause) {
      setErrors((current) => ({ ...current, [bot.id]: failure(cause) }));
    } finally {
      setBusy(undefined);
    }
  }

  if (browserBots.length === 0)
    return (
      <>
        <p className="settings-empty">
          还没有使用员工浏览器的 Bot。创建 Bot 时把执行方式选为「员工浏览器 · Docker」即可。
        </p>
        <BrowserFacts />
      </>
    );

  return (
    <>
      <section className="settings-group">
        <h3>使用浏览器的 Bot</h3>
        <div className="settings-group-rows">
          {browserBots.map((bot) => {
            const result = results[bot.id];
            const state = result
              ? `${result.paused ? "已暂停" : result.running ? "运行中" : "未运行"} · 主机 ${result.nodeId}`
              : "点「检查状态」查看";
            const working = busy?.startsWith(`${bot.id}:`) ?? false;
            return (
              <div className="settings-browser-bot" key={bot.id}>
                <div className="settings-item settings-browser-row">
                  <span className="settings-tile settings-routine-avatar" aria-hidden="true">
                    <RobotAvatar bot={bot} compact />
                  </span>
                  <span className="settings-item-text">
                    <strong>{bot.name}</strong>
                    <small>{working ? "正在处理…" : state}</small>
                  </span>
                  <span className="settings-browser-actions">
                    <button
                      type="button"
                      className="ob-pill is-small"
                      disabled={busy !== undefined}
                      onClick={() => void run(bot, "status")}
                    >
                      检查状态
                    </button>
                    <button
                      type="button"
                      className="ob-pill is-small"
                      onClick={() => setViewing(bot)}
                    >
                      打开查看
                    </button>
                    <button
                      type="button"
                      className="ob-pill is-small"
                      disabled={busy !== undefined}
                      aria-label={`重启 ${bot.name} 的浏览器`}
                      onClick={() => void run(bot, "restart")}
                    >
                      重启
                    </button>
                  </span>
                </div>
                {errors[bot.id] ? (
                  <p className="form-error settings-inline-notice" role="alert">
                    {errors[bot.id]}
                  </p>
                ) : null}
                {confirmClear === bot.id ? (
                  <div
                    className="settings-browser-confirm"
                    role="alertdialog"
                    aria-label="清除浏览数据"
                  >
                    <p>会删除 {bot.name} 的登录状态、Cookie 和缓存，无法恢复。浏览器会先暂停。</p>
                    <span className="settings-browser-confirm-actions">
                      <button
                        type="button"
                        className="ob-pill is-small"
                        onClick={() => setConfirmClear(undefined)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="ob-pill is-small is-danger"
                        disabled={busy !== undefined}
                        onClick={() => void run(bot, "clear")}
                      >
                        清除
                      </button>
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="settings-browser-clear"
                    disabled={busy !== undefined}
                    onClick={() => setConfirmClear(bot.id)}
                  >
                    清除浏览数据…
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <BrowserFacts />
      {viewing ? <EmployeeBrowser bot={viewing} onClose={() => setViewing(undefined)} /> : null}
    </>
  );
}

function BrowserFacts() {
  return (
    <>
      <SettingsGroup title="隔离">
        <SettingRow
          title="跑在工作主机的容器里"
          description="和你自己的浏览器互不影响；Bot 的每一步网页操作仍按审批规则执行"
        />
      </SettingsGroup>
      <p className="settings-footnote">下载文件和任务截图的保留时间暂不可设置。</p>
    </>
  );
}
