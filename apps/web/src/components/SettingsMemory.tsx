import type { Bot, EmployeeProfile } from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import { getEmployeeProfile } from "../api";
import { EmployeeMemoryPanel } from "./EmployeeMemoryPanel";

/**
 * Settings → 记忆 (SettingsMemory artboard): one Bot at a time, using the profile's Owner memory
 * controls. Models cannot write here; every change is revision-checked by the Server.
 */
export function SettingsMemory({ bots }: { bots: Bot[] }) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [profile, setProfile] = useState<EmployeeProfile>();
  const [error, setError] = useState(false);
  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    try {
      const next = await getEmployeeProfile(id, signal);
      if (!signal?.aborted) {
        setProfile(next);
        setError(false);
      }
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, []);
  useEffect(() => {
    if (!botId) return;
    const controller = new AbortController();
    setProfile(undefined);
    void load(botId, controller.signal);
    return () => controller.abort();
  }, [botId, load]);

  if (bots.length === 0)
    return <p className="settings-empty">还没有 Bot。创建 Bot 后，它记住的内容会出现在这里。</p>;
  return (
    <>
      <label className="settings-bot-picker">
        <span className="visually-hidden">选择 Bot</span>
        <select value={botId} onChange={(event) => setBotId(event.target.value)}>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="form-error" role="alert">
          无法读取这个 Bot 的记忆，请重试。
        </p>
      ) : profile ? (
        <div className="settings-memory">
          <EmployeeMemoryPanel profile={profile} onProfileChanged={() => load(botId)} />
        </div>
      ) : (
        <p className="settings-empty" role="status">
          正在读取记忆…
        </p>
      )}
    </>
  );
}
