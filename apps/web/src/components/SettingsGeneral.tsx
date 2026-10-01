import type {
  DesktopPlatformPreferences,
  DesktopPlatformState,
  ModelSelection,
  OwnerPreferences,
} from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getOwnerPreferences, saveOwnerPreferences } from "../api";
import { getOpenBotDesktopBridge } from "../desktop-runtime";
import { shortcutLabel } from "../desktop-shortcuts";
import { ModelSelector } from "./ModelSelector";
import { SettingRow, SettingsGroup } from "./SettingsSections";

/** The SettingsGeneral artboard's shortcut (⌘⇧O on macOS, Ctrl+Shift+O elsewhere). */
const GLOBAL_SHORTCUT = "CommandOrControl+Shift+O";

const platformErrors: Record<NonNullable<DesktopPlatformState["code"]>, string> = {
  unsupported: "这台电脑不支持这个设置。",
  shortcut_unavailable: "快捷键已被其他应用占用，没有启用。",
  native_unavailable: "系统暂时拒绝了这个设置，请稍后再试。",
  storage_unavailable: "无法保存桌面设置。",
  rollback_unavailable: "设置没有完全生效，请重新打开 OpenBot 后检查。",
};

/** Desktop main-process preferences (backlog C5). Absent outside the Desktop app. */
function useDesktopPlatform() {
  const bridge = getOpenBotDesktopBridge();
  const [state, setState] = useState<DesktopPlatformState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!bridge?.getPlatformState) return;
    let current = true;
    void bridge
      .getPlatformState()
      .then((value) => {
        if (current) setState(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge]);
  async function update(change: Partial<DesktopPlatformPreferences>) {
    if (!state || !bridge?.setPlatformPreferences) return;
    setError(undefined);
    try {
      // Called inside the switch's click: the preload requires a user gesture.
      const next = await bridge.setPlatformPreferences({ ...state.preferences, ...change });
      setState(next);
      if (next.code) setError(platformErrors[next.code]);
    } catch {
      setError("无法更改这个设置。");
    }
  }
  return { state, error, update };
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ob-switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

/** 通用 → 启动: only the rows this Desktop build supports. The updater is not offered here. */
export function DesktopStartupSettings() {
  const { state, error, update } = useDesktopPlatform();
  if (state?.status !== "ready") return null;
  const { capabilities, preferences } = state;
  return (
    <SettingsGroup title="启动">
      {capabilities.launchAtLogin ? (
        <SettingRow title="开机时启动 OpenBot" description="登录电脑后自动打开，例行任务不会错过">
          <Toggle
            label="开机时启动 OpenBot"
            checked={preferences.launchAtLogin}
            onChange={(launchAtLogin) => void update({ launchAtLogin })}
          />
        </SettingRow>
      ) : null}
      {capabilities.tray ? (
        <SettingRow title="关闭窗口后在后台运行" description="Bot 继续工作，菜单栏保留图标">
          <Toggle
            label="关闭窗口后在后台运行"
            checked={preferences.runInBackground}
            onChange={(runInBackground) => void update({ runInBackground })}
          />
        </SettingRow>
      ) : null}
      <SettingRow
        title={`全局快捷键 ${shortcutLabel("").startsWith("⌘") ? "⌘⇧O" : "Ctrl+Shift+O"}`}
        description="随时唤出 OpenBot"
      >
        <Toggle
          label="全局快捷键"
          checked={preferences.globalShortcut !== ""}
          onChange={(on) => void update({ globalShortcut: on ? GLOBAL_SHORTCUT : "" })}
        />
      </SettingRow>
      {error ? (
        <p className="form-error settings-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

/** 通知 → 程序坞角标 (Desktop with badge support only). */
export function DockBadgeSetting() {
  const { state, error, update } = useDesktopPlatform();
  if (state?.status !== "ready" || !state.capabilities.badge) return null;
  return (
    <SettingsGroup title="通知的样子">
      <SettingRow title="程序坞角标" description="显示待批准和未读的数量">
        <Toggle
          label="程序坞角标"
          checked={state.preferences.showDockBadge}
          onChange={(showDockBadge) => void update({ showDockBadge })}
        />
      </SettingRow>
      {error ? (
        <p className="form-error settings-inline-notice" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function timeZones(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return supported.includes(current) ? supported : [current, ...supported];
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null) {
  return (
    left?.connectionId === right?.connectionId && left?.modelId.trim() === right?.modelId.trim()
  );
}

/**
 * 通用 → Bot (backlog C7): the Owner's time zone and the model new Bots start with. Both are
 * Server settings saved with the expected revision; the time zone saves on change.
 */
export function OwnerPreferenceSettings() {
  const [preferences, setPreferences] = useState<OwnerPreferences>();
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [modelValid, setModelValid] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await getOwnerPreferences(signal);
      if (signal?.aborted) return;
      setPreferences(value);
      setModel(value.defaultModel);
      setLoadError(false);
    } catch {
      if (!signal?.aborted) setLoadError(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(change: { timezone?: string; defaultModel?: ModelSelection | null }) {
    if (!preferences || saving) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await saveOwnerPreferences({
        expectedRevision: preferences.revision,
        timezone: change.timezone ?? preferences.timezone,
        defaultModel:
          change.defaultModel === undefined ? preferences.defaultModel : change.defaultModel,
      });
      setPreferences(next);
      setModel(next.defaultModel);
      setNotice("已保存。");
    } catch (cause) {
      const conflict = cause instanceof ApiError && cause.status === 409;
      setError(conflict ? "设置已在其他位置更新，已重新读取。" : "无法保存，设置没有改变。");
      if (conflict) await load();
    } finally {
      setSaving(false);
    }
  }

  if (loadError)
    return (
      <SettingsGroup title="Bot">
        <SettingRow title="时区与默认模型" description="暂时无法读取。">
          <button className="secondary-button" type="button" onClick={() => void load()}>
            重试
          </button>
        </SettingRow>
      </SettingsGroup>
    );
  if (!preferences) return null;
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const changedModel = !sameModel(model, preferences.defaultModel);
  return (
    <SettingsGroup title="Bot">
      <SettingRow
        title="时区"
        description={
          detected === preferences.timezone
            ? `与这台电脑一致（${detected}）`
            : `这台电脑是 ${detected}`
        }
      >
        <select
          aria-label="时区"
          value={preferences.timezone}
          disabled={saving}
          onChange={(event) => void save({ timezone: event.target.value })}
        >
          {timeZones(preferences.timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="新 Bot 默认模型" description="创建 Bot 时预先选好，之后可以单独改" />
      <div className="settings-default-model">
        <ModelSelector
          value={model}
          onChange={setModel}
          onValidityChange={setModelValid}
          allowDefault
          disabled={saving}
        />
        {changedModel ? (
          <footer>
            <button
              className="ob-pill is-small"
              type="button"
              onClick={() => setModel(preferences.defaultModel)}
            >
              取消
            </button>
            <button
              className="ob-pill is-small is-primary"
              type="button"
              disabled={saving || (model !== null && !modelValid)}
              onClick={() =>
                void save({
                  defaultModel: model ? { ...model, modelId: model.modelId.trim() } : null,
                })
              }
            >
              保存默认模型
            </button>
          </footer>
        ) : null}
      </div>
      {error ? (
        <p className="form-error settings-inline-notice" role="alert">
          {error}
        </p>
      ) : notice ? (
        <p className="settings-success settings-inline-notice" role="status">
          {notice}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
