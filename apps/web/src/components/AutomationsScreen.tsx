// Settings → 例行任务 (SettingsRoutines artboard): lists, creates, pauses and deletes the Server's
// scheduled routines for the workspace's Bots.
import type { Bot, Channel } from "@openbot/domain";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  type Automation,
  type CreateAutomationInput,
  createAutomation,
  deleteAutomation,
  listAutomations,
  setAutomationEnabled,
} from "../destination-api";
import { RobotAvatar } from "./RobotAvatar";
import { SettingsHeaderAction } from "./SettingsHeaderAction";
import { SettingsSearch, useSettingsSearch } from "./SettingsSearch";
import "./AutomationsScreen.css";

type LoadState = "loading" | "ready" | "unavailable" | "failed";

/** Settings → 例行任务 (SettingsRoutines artboard): the Server's schedules for the workspace. */
export function AutomationsScreen({ bots, channels }: { bots: Bot[]; channels: Channel[] }) {
  const [items, setItems] = useState<Automation[]>([]);
  const search = useSettingsSearch(items.length);
  const shownItems = items.filter((item) =>
    search.matches(
      `${item.name} ${bots.find((bot) => bot.id === item.botId)?.name ?? ""} ${channels.find((channel) => channel.id === item.channelId)?.name ?? ""}`,
    ),
  );
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const mutationRef = useRef(false);

  const refresh = useCallback(async () => {
    if (mutationRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const result = await listAutomations(
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      );
      if (controller.signal.aborted) return;
      setItems(result);
      setLoadState("ready");
      setError(undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setLoadState(
        cause instanceof ApiError && [404, 503].includes(cause.status) ? "unavailable" : "failed",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  function beginMutation(id: string): boolean {
    if (mutationRef.current) return false;
    mutationRef.current = true;
    requestRef.current?.abort();
    setBusyId(id);
    setError(undefined);
    setNotice("");
    return true;
  }

  function endMutation() {
    mutationRef.current = false;
    setBusyId(undefined);
  }

  async function handleCreate(input: CreateAutomationInput) {
    if (!beginMutation("create")) return;
    try {
      const created = await createAutomation(input);
      setItems((current) => [created, ...current]);
      setShowForm(false);
      setNotice("例行任务已创建，将由服务电脑按计划提交。");
    } finally {
      endMutation();
    }
  }

  async function toggle(item: Automation) {
    if (!beginMutation(item.id)) return;
    try {
      const updated = await setAutomationEnabled(item.id, !item.enabled);
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setNotice(updated.enabled ? "例行任务已恢复。" : "例行任务已暂停；已提交的任务会继续执行。");
    } catch {
      setError("无法更新例行任务。请刷新确认当前状态后重试。");
    } finally {
      endMutation();
    }
  }

  async function remove(item: Automation) {
    if (!beginMutation(item.id)) return;
    try {
      await deleteAutomation(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setDeleteId(undefined);
      setNotice("例行任务已删除，已有对话和执行记录保留。");
    } catch {
      setError("无法删除例行任务。请刷新确认当前状态后重试。");
    } finally {
      endMutation();
    }
  }

  const availableTargets = channels.some((channel) =>
    bots.some((bot) => channel.botIds.includes(bot.id)),
  );

  const canCreate =
    loadState === "ready" &&
    availableTargets &&
    items.length < 50 &&
    busyId === undefined &&
    !showForm;

  return (
    <>
      <SettingsHeaderAction>
        <button
          className="ob-pill is-primary"
          type="button"
          disabled={!canCreate}
          onClick={() => setShowForm(true)}
        >
          新建例行任务
        </button>
      </SettingsHeaderAction>
      {showForm ? (
        <section className="settings-group">
          <h3>新建时填写</h3>
          <div className="settings-card settings-routine-form">
            <AutomationForm
              bots={bots}
              channels={channels}
              busy={busyId === "create"}
              onCreate={handleCreate}
              onCancel={() => setShowForm(false)}
            />
          </div>
        </section>
      ) : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loadState === "loading" ? (
        <p className="settings-empty" role="status">
          正在读取例行任务…
        </p>
      ) : loadState === "unavailable" ? (
        <p className="settings-empty" role="status">
          服务电脑暂不支持例行任务。请更新并启用服务电脑的例行任务服务。
        </p>
      ) : loadState === "failed" ? (
        <div className="settings-load-notice" role="alert">
          <p>无法读取例行任务，请检查服务电脑的连接。</p>
          <button type="button" className="ob-pill" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <p className="settings-empty">
          {availableTargets
            ? "还没有例行任务。点「新建例行任务」，设定首次时间和重复间隔。"
            : "先创建 Bot，并将它加入一个频道，即可安排任务。"}
        </p>
      ) : (
        <div className="settings-group-rows settings-routines">
          <SettingsSearch search={search} count={items.length} noun="例行任务" />
          {shownItems.length === 0 ? <p className="settings-empty">没有匹配的例行任务。</p> : null}
          {shownItems.map((item) => {
            const bot = bots.find((entry) => entry.id === item.botId);
            const channel = channels.find((entry) => entry.id === item.channelId);
            return (
              <div
                className={`settings-item settings-routine${item.enabled ? "" : " is-paused"}`}
                key={item.id}
              >
                <span className="settings-tile settings-routine-avatar" aria-hidden="true">
                  {bot ? <RobotAvatar bot={bot} compact /> : "?"}
                </span>
                <span className="settings-item-text">
                  <strong>{item.name}</strong>
                  <small>
                    {bot?.name ?? "Bot 已不可用"} · 发到 # {channel?.name ?? "频道已不可用"} ·{" "}
                    {intervalLabel(item.intervalMinutes)}
                  </small>
                  {item.lastOutcome && item.lastOutcome !== "submitted" ? (
                    <small className="settings-routine-reason is-attention">
                      {outcomeLabel(item.lastOutcome)}
                    </small>
                  ) : null}
                </span>
                <span className="settings-routine-when">
                  {item.enabled ? `下次：${dateLabel(item.nextRunAt)}` : "已暂停"}
                  <small
                    className={
                      item.lastOutcome && item.lastOutcome !== "submitted"
                        ? "is-attention"
                        : undefined
                    }
                    title={item.lastOutcome ? outcomeLabel(item.lastOutcome) : undefined}
                  >
                    {item.lastRunAt
                      ? `上次：${item.lastOutcome === "submitted" || !item.lastOutcome ? "已提交" : "未提交"} · ${dateLabel(item.lastRunAt)}`
                      : "尚未执行"}
                  </small>
                </span>
                <button
                  type="button"
                  role="switch"
                  className="ob-switch"
                  aria-checked={item.enabled}
                  aria-label={`启用 ${item.name}`}
                  disabled={busyId !== undefined}
                  onClick={() => void toggle(item)}
                />
                {deleteId === item.id ? (
                  <span className="settings-routine-delete">
                    <button
                      type="button"
                      className="ob-pill is-small is-danger"
                      disabled={busyId !== undefined}
                      onClick={() => void remove(item)}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="ob-pill is-small"
                      disabled={busyId !== undefined}
                      onClick={() => setDeleteId(undefined)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="settings-routine-remove"
                    aria-label={`删除 ${item.name}`}
                    disabled={busyId !== undefined}
                    onClick={() => setDeleteId(item.id)}
                  >
                    删除
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="settings-footnote">
        服务电脑需要保持运行。例行任务沿用 Bot
        的权限与审批；上次任务仍在进行时，本次会跳过。每个工作空间最多 50 个。
      </p>
    </>
  );
}

function AutomationForm({
  bots,
  channels,
  busy,
  onCreate,
  onCancel,
}: {
  bots: Bot[];
  channels: Channel[];
  busy: boolean;
  onCreate(input: CreateAutomationInput): Promise<void>;
  onCancel(): void;
}) {
  const [channelId, setChannelId] = useState(
    () => channels.find((channel) => bots.some((bot) => channel.botIds.includes(bot.id)))?.id ?? "",
  );
  const eligibleBots = bots.filter((bot) =>
    channels.find((channel) => channel.id === channelId)?.botIds.includes(bot.id),
  );
  const [botId, setBotId] = useState(() => eligibleBots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [firstRun, setFirstRun] = useState(() => localDateInput(new Date(Date.now() + 3_600_000)));
  const [error, setError] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    const time = new Date(firstRun).getTime();
    if (!name.trim() || !prompt.trim() || !eligibleBots.some((bot) => bot.id === botId)) {
      setError("请填写名称、任务指令，并选择频道中的 Bot。");
      return;
    }
    if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 366 * 86_400_000) {
      setError("首次执行时间应在未来一年内。");
      return;
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10080) {
      setError("重复间隔应为 15 到 10080 分钟。");
      return;
    }
    try {
      await onCreate({
        name: name.trim(),
        prompt: prompt.trim(),
        channelId,
        botId,
        intervalMinutes,
        firstRunAt: new Date(time).toISOString(),
      });
    } catch {
      setError("未能确认任务已创建。请先刷新列表确认，再尝试提交。");
    }
  }

  return (
    <form className="routine-form" aria-label="新建例行任务" onSubmit={submit}>
      <h3>新建例行任务</h3>
      <label className="ob-field">
        任务名称
        <input
          ref={nameInput}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          placeholder="例如 每日站点检查"
          disabled={busy}
        />
      </label>
      <div className="routine-form-pair">
        <label className="ob-field">
          发送到频道
          <select
            value={channelId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setChannelId(id);
              setBotId(
                bots.find((bot) =>
                  channels.find((channel) => channel.id === id)?.botIds.includes(bot.id),
                )?.id ?? "",
              );
            }}
          >
            {channels.map((channel) => (
              <option value={channel.id} key={channel.id}>
                {channel.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ob-field">
          执行 Bot
          <select
            required
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
            disabled={busy || eligibleBots.length === 0}
          >
            {eligibleBots.length === 0 ? (
              <option value="">这个频道没有 Bot</option>
            ) : (
              eligibleBots.map((bot) => (
                <option value={bot.id} key={bot.id}>
                  {bot.name}
                </option>
              ))
            )}
          </select>
        </label>
      </div>
      <label className="ob-field">
        任务指令
        <textarea
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          required
          maxLength={8000}
          disabled={busy}
          placeholder="描述希望 Bot 定期完成的工作…"
        />
      </label>
      <div className="routine-form-pair">
        <label className="ob-field">
          首次执行
          <input
            type="datetime-local"
            required
            value={firstRun}
            onChange={(event) => setFirstRun(event.target.value)}
            disabled={busy}
          />
        </label>
        <label className="ob-field">
          重复间隔
          <select
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            disabled={busy}
          >
            <option value={60}>每 1 小时</option>
            <option value={1440}>每 24 小时</option>
            <option value={10080}>每 7 天</option>
          </select>
        </label>
      </div>
      <p className="routine-form-hint">时间按 {zone} 显示，重复间隔按实际经过时间计算。</p>
      <p className="routine-form-hint">创建后，服务电脑会自动向所选 Bot 提交这条指令。</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <button className="ob-pill" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          className="ob-pill is-primary"
          type="submit"
          disabled={busy || eligibleBots.length === 0}
        >
          {busy ? "正在创建…" : "创建例行任务"}
        </button>
      </footer>
    </form>
  );
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "时间不可用";
}
function localDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${minutes} 分钟`;
}
function outcomeLabel(outcome: NonNullable<Automation["lastOutcome"]>): string {
  if (outcome === "attachment_unavailable")
    return "附件已删除、损坏或不可用，例行任务已暂停。请恢复原附件后重新启用，或删除任务并重新创建。";
  if (outcome === "submitted") return "已提交到频道，执行结果请查看对话。";
  if (outcome === "skipped_active") return "上次任务仍在进行，已跳过本次。";
  return "频道或 Bot 暂不可用，本次未提交。";
}
