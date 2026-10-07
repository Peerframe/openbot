import type { ModelConnection } from "@openbot/domain";
import { useEffect, useState } from "react";
import {
  ApiError,
  getTranscriptionSettings,
  saveTranscriptionSettings,
  type TranscriptionSettings,
} from "../api";
import { SettingRow, SettingsGroup } from "./SettingsSections";

export function TranscriptionConnectionSetting({
  connections,
}: {
  connections: ModelConnection[];
}) {
  const [settings, setSettings] = useState<TranscriptionSettings>();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reloads the Server snapshot.
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    getTranscriptionSettings(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSettings(value);
        setSelected(value.connectionId ?? "");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("无法读取语音转写设置，请重试。");
      });
    return () => controller.abort();
  }, [reload]);
  const eligible = connections.filter(
    (c) =>
      c.enabled &&
      c.presetId === "openai" &&
      c.source === "saved" &&
      c.baseUrl === "https://api.openai.com/v1",
  );
  const unavailable =
    settings?.connectionId && !eligible.some((c) => c.id === settings.connectionId);
  async function save() {
    if (!settings || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const value = await saveTranscriptionSettings({
        expectedRevision: settings.revision,
        connectionId: selected || null,
      });
      setSettings(value);
      setNotice("已保存语音转写连接。");
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "设置已更新，请重新读取后再保存。"
          : "无法保存语音转写连接，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsGroup
      title="语音转写"
      description="只有你选择转写时，才会把音频发送至这个 OpenAI 连接，使用 whisper-1。"
    >
      <SettingRow
        title="OpenAI 连接"
        description={
          unavailable ? "已选连接当前不可用，转写已暂停。" : "使用模型服务中已有的密钥。"
        }
      >
        <select
          aria-label="语音转写连接"
          value={selected}
          disabled={!settings || busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setNotice(undefined);
          }}
        >
          <option value="">未启用</option>
          {unavailable ? <option value={settings.connectionId ?? ""}>已选连接不可用</option> : null}
          {eligible.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="ob-pill"
          type="button"
          disabled={!settings || busy || selected === (settings.connectionId ?? "")}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存"}
        </button>
      </SettingRow>
      {!settings && !error ? <p role="status">正在读取语音转写设置…</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}{" "}
          <button
            className="ob-pill"
            type="button"
            disabled={busy}
            onClick={() => {
              setSettings(undefined);
              setReload((v) => v + 1);
            }}
          >
            重新读取
          </button>
        </p>
      ) : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
