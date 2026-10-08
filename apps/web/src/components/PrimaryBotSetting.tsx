import type { WorkspacePrimaryBot } from "@openbot/domain";
import { useEffect, useState } from "react";
import { ApiError, setWorkspacePrimaryBot } from "../api";
import { SettingRow, SettingsGroup, useSettingsWorkspace } from "./SettingsSections";

/**
 * Settings reads its own workspace copy, and the Server sends no realtime event for this setting,
 * so a save tells the workspace behind the dialog to re-read: the sidebar crown moves at once.
 */
export const primaryBotChangedEvent = "openbot:primary-bot-changed";

export function PrimaryBotSetting() {
  const { workspace, error: loadError, retry } = useSettingsWorkspace();
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState<WorkspacePrimaryBot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (workspace) setSelected(workspace.primaryBotId ?? "");
  }, [workspace]);
  const settings = saved ?? workspace;
  const available = typeof settings?.revision === "number" && workspace?.primaryBotId !== undefined;
  function reload() {
    setSaved(undefined);
    setNotice(undefined);
    setError(undefined);
    retry();
  }
  async function save() {
    if (!available || !settings?.revision || busy) return;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const result = await setWorkspacePrimaryBot({
        botId: selected || null,
        expectedRevision: settings.revision,
      });
      setSaved(result);
      setSelected(result.primaryBotId ?? "");
      setNotice("已保存主 Bot。");
      window.dispatchEvent(new Event(primaryBotChangedEvent));
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "主 Bot 已被更新，请重新读取后再选择。"
          : cause instanceof ApiError && cause.status === 404
            ? "这个 Bot 已被删除，请重新读取后再选择。"
            : "无法保存主 Bot，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsGroup
      title="工作区主 Bot"
      description="频道消息没有 @ 时，优先交给频道里的主 Bot。审批、插件和电脑权限仍按每个 Bot 单独设置。"
    >
      {!workspace ? (
        <p role={loadError ? "alert" : "status"}>
          {loadError ? "无法读取主 Bot 设置。" : "正在读取主 Bot 设置…"}
        </p>
      ) : !available ? (
        <p role="status">当前服务暂不支持主 Bot 设置。</p>
      ) : (
        <SettingRow
          title="主 Bot"
          description={
            settings?.primaryBotId === null
              ? "还没有主 Bot，请选择一个。主 Bot 不在频道时，仍使用原有路由。"
              : "明确 @ 和单聊保持原有路由。"
          }
        >
          <select
            aria-label="工作区主 Bot"
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              setNotice(undefined);
            }}
          >
            <option value="">不设主 Bot</option>
            {workspace.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <button
            className="ob-pill"
            type="button"
            disabled={busy || selected === (settings?.primaryBotId ?? "")}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </SettingRow>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loadError || error ? (
        <button className="ob-pill" type="button" disabled={busy} onClick={reload}>
          重新读取
        </button>
      ) : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
