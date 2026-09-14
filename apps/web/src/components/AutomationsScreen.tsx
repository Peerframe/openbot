import type { Bot, Channel } from "@openbot/domain";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import {
  type Automation,
  type CreateAutomationInput,
  createAutomation,
  deleteAutomation,
  listAutomations,
  setAutomationEnabled,
} from "../destination-api";
import { PlusIcon, SearchIcon } from "./Icons";
import "./destinations.css";

type LoadState = "loading" | "ready" | "unavailable" | "failed";

export function AutomationsScreen({
  bots,
  channels,
  headerAction,
}: {
  bots: Bot[];
  channels: Channel[];
  headerAction?: ReactNode;
}) {
  const [items, setItems] = useState<Automation[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
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
    setRefreshing(true);
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
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
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
    setRefreshing(false);
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
      setNotice("自动任务已创建，将由服务电脑按计划提交。");
    } finally {
      endMutation();
    }
  }

  async function toggle(item: Automation) {
    if (!beginMutation(item.id)) return;
    try {
      const updated = await setAutomationEnabled(item.id, !item.enabled);
      setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setNotice(updated.enabled ? "自动任务已恢复。" : "自动任务已暂停；已提交的任务会继续执行。");
    } catch {
      setError("无法更新自动任务。请刷新确认当前状态后重试。");
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
      setNotice("自动任务已删除，已有对话和执行记录保留。");
    } catch {
      setError("无法删除自动任务。请刷新确认当前状态后重试。");
    } finally {
      endMutation();
    }
  }

  const term = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) =>
    `${item.name} ${item.prompt}`.toLocaleLowerCase().includes(term),
  );
  const availableTargets = channels.some((channel) =>
    bots.some((bot) => channel.botIds.includes(bot.id)),
  );

  return (
    <main className="workspace-destination" aria-labelledby="automations-title">
      <header className="destination-header">
        <h1 id="automations-title">自动任务</h1>
        <div className="destination-header-actions">{headerAction}</div>
      </header>
      <div className="destination-scroll">
        <section className="destination-intro destination-intro-action">
          <div>
            <h2>把重复的工作安排好</h2>
            <p>选择频道、Bot 和执行频率，结果回到对应的对话。</p>
          </div>
          <button
            className="destination-primary"
            type="button"
            disabled={
              loadState !== "ready" ||
              !availableTargets ||
              items.length >= 50 ||
              busyId !== undefined ||
              showForm
            }
            onClick={() => setShowForm(true)}
          >
            <PlusIcon />
            新建任务
          </button>
        </section>
        {showForm ? (
          <AutomationForm
            bots={bots}
            channels={channels}
            busy={busyId === "create"}
            onCreate={handleCreate}
            onCancel={() => setShowForm(false)}
          />
        ) : null}
        {notice ? (
          <p className="destination-notice success" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="destination-notice" role="alert">
            {error}
          </p>
        ) : null}
        <div className="destination-toolbar">
          <search className="destination-search" aria-label="搜索自动任务">
            <SearchIcon />
            <input
              type="search"
              aria-label="搜索任务名称或指令"
              placeholder="搜索任务名称或指令"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </search>
          <button
            className="destination-secondary"
            disabled={refreshing || busyId !== undefined}
            type="button"
            onClick={() => void refresh()}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        </div>
        {loadState === "loading" ? (
          <p className="destination-empty" role="status">
            正在读取自动任务…
          </p>
        ) : loadState === "unavailable" ? (
          <div className="destination-empty" role="status">
            <h3>服务电脑暂不支持自动任务</h3>
            <p>请更新并启用服务电脑的自动任务服务，然后刷新。</p>
          </div>
        ) : loadState === "failed" ? (
          <div className="destination-empty" role="alert">
            <h3>无法读取自动任务</h3>
            <p>请检查服务电脑的连接，再刷新重试。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="destination-empty">
            <h3>{term ? "没有匹配的任务" : "让下一次工作按时开始"}</h3>
            <p>
              {term
                ? "试试其他关键词。"
                : availableTargets
                  ? "新建一个自动任务，设定首次时间和重复间隔。"
                  : "先创建 Bot，并将它加入一个频道，即可安排任务。"}
            </p>
          </div>
        ) : (
          <div className="destination-automation-list">
            {filtered.map((item) => (
              <article className="destination-automation" key={item.id}>
                <div className="destination-automation-heading">
                  <h3>{item.name}</h3>
                  <span className={`destination-state ${item.enabled ? "verified" : "suspended"}`}>
                    {item.enabled ? "已启用" : "已暂停"}
                  </span>
                </div>
                <p className="destination-automation-prompt">{item.prompt}</p>
                <p className="destination-automation-target">
                  #
                  {channels.find((channel) => channel.id === item.channelId)?.name ??
                    "频道已不可用"}{" "}
                  <span aria-hidden="true">·</span>{" "}
                  {bots.find((bot) => bot.id === item.botId)?.name ?? "Bot 已不可用"}{" "}
                  <span aria-hidden="true">·</span> {intervalLabel(item.intervalMinutes)}
                </p>
                <dl className="destination-automation-times">
                  <div>
                    <dt>下次提交</dt>
                    <dd>{item.enabled ? dateLabel(item.nextRunAt) : "恢复后继续"}</dd>
                  </div>
                  <div>
                    <dt>上次调度</dt>
                    <dd>{item.lastRunAt ? dateLabel(item.lastRunAt) : "尚未执行"}</dd>
                  </div>
                </dl>
                {item.lastOutcome ? (
                  <p
                    className={`destination-outcome ${item.lastOutcome === "submitted" ? "" : "attention"}`}
                  >
                    {outcomeLabel(item.lastOutcome)}
                  </p>
                ) : null}
                <div className="destination-automation-actions">
                  <button
                    className="destination-secondary"
                    type="button"
                    disabled={busyId !== undefined}
                    onClick={() => void toggle(item)}
                  >
                    {busyId === item.id ? "保存中…" : item.enabled ? "暂停" : "恢复"}
                  </button>
                  {deleteId === item.id ? (
                    <>
                      <span>删除此计划？</span>
                      <button
                        className="destination-text-button danger"
                        disabled={busyId !== undefined}
                        type="button"
                        onClick={() => void remove(item)}
                      >
                        确认删除
                      </button>
                      <button
                        className="destination-text-button"
                        disabled={busyId !== undefined}
                        type="button"
                        onClick={() => setDeleteId(undefined)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="destination-text-button"
                      disabled={busyId !== undefined}
                      type="button"
                      onClick={() => setDeleteId(item.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <p className="destination-footnote">
          服务电脑需要保持运行。任务沿用 Bot
          的权限与审批；上次任务仍在进行时，本次会跳过。每个工作空间最多 50 个计划。
        </p>
      </div>
    </main>
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
    <form className="destination-automation-form" aria-label="新建自动任务" onSubmit={submit}>
      <h3>新建自动任务</h3>
      <label>
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
      <div className="destination-form-pair">
        <label>
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
        <label>
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
      <label>
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
      <div className="destination-form-pair">
        <label>
          首次执行
          <input
            type="datetime-local"
            required
            value={firstRun}
            onChange={(event) => setFirstRun(event.target.value)}
            disabled={busy}
          />
        </label>
        <label>
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
      <p className="destination-form-hint">时间按 {zone} 显示，重复间隔按实际经过时间计算。</p>
      <p className="destination-form-hint">创建后，服务电脑会自动向所选 Bot 提交这条指令。</p>
      {error ? (
        <p className="destination-notice" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <button className="destination-secondary" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          className="destination-primary"
          type="submit"
          disabled={busy || eligibleBots.length === 0}
        >
          {busy ? "创建中…" : "创建自动任务"}
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
    return "附件已删除、损坏或不可用，自动任务已暂停。请恢复原附件后重新启用，或删除任务并重新创建。";
  if (outcome === "submitted") return "已提交到频道，执行结果请查看对话。";
  if (outcome === "skipped_active") return "上次任务仍在进行，已跳过本次。";
  return "频道或 Bot 暂不可用，本次未提交。";
}
