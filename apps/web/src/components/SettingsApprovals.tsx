import type { ApprovalException, ApprovalSettings, Bot, Channel } from "@openbot/domain";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getApprovalSettings, saveApprovalSettings } from "../api";
import { SettingsHeaderAction } from "./SettingsHeaderAction";
import { ApprovalPolicySettings, SettingRow, SettingsGroup } from "./SettingsSections";

type Level = ApprovalSettings["productRead"];
const levelLabels: Record<Level, string> = { inherit: "按默认规则", required: "每次都问" };
const protectedLabels: Record<ApprovalSettings["protectedExceptionCategories"][number], string> = {
  delete: "删除数据",
  install: "安装软件",
  permission_change: "修改权限",
  command: "执行命令",
  browser: "员工浏览器操作",
  plugin: "插件工具",
  unknown: "未知操作",
};
const categoryLabels: Record<ApprovalException["category"], string> = {
  product_read: "读取频道",
  public_web: "阅读网页",
};

/**
 * Settings → 审批与权限 (SettingsApprovals artboard; ADR-0049, backlog C4). The Owner can add a
 * confirmation to product and public-web reads and lift it again for exact Bot/target pairs.
 * Exceptions never lower an adapter's own approval; protected categories cannot be excepted.
 * Every save sends the expected revision, so a change made elsewhere is never overwritten.
 */
export function SettingsApprovals({ bots, channels }: { bots: Bot[]; channels: Channel[] }) {
  const [settings, setSettings] = useState<ApprovalSettings>();
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await getApprovalSettings(signal);
      if (!signal?.aborted) {
        setSettings(value);
        setLoadError(false);
      }
    } catch {
      if (!signal?.aborted) setLoadError(true);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(
    change: Partial<Pick<ApprovalSettings, "productRead" | "publicWeb" | "exceptions">>,
  ) {
    if (!settings || saving) return false;
    setSaving(true);
    setError(undefined);
    try {
      setSettings(
        await saveApprovalSettings({
          expectedRevision: settings.revision,
          productRead: change.productRead ?? settings.productRead,
          publicWeb: change.publicWeb ?? settings.publicWeb,
          exceptions: change.exceptions ?? settings.exceptions,
        }),
      );
      return true;
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      setError(
        status === 409
          ? "规则已在其他位置更新，已重新读取。请再确认一次。"
          : status === 404
            ? "所选 Bot 或目标已不存在。"
            : "无法保存，规则没有改变。",
      );
      if (status === 409) await load();
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (loadError)
    return (
      <div className="settings-load-notice" role="alert">
        <p>无法读取审批规则。在读取成功前，Server 按最严格的规则执行。</p>
        <button type="button" className="secondary-button" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  if (!settings)
    return (
      <p className="settings-load-notice" role="status">
        正在读取审批规则…
      </p>
    );

  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? "已删除的 Bot";
  const targetLabel = (entry: ApprovalException) =>
    entry.target.kind === "channel"
      ? `# ${channels.find((channel) => channel.id === entry.target.value)?.name ?? "已删除的频道"}`
      : entry.target.kind === "attachment"
        ? `附件 ${entry.target.value.slice(0, 8)}`
        : entry.target.value;

  return (
    <>
      <SettingsHeaderAction>
        <button
          type="button"
          className="ob-pill is-primary"
          aria-expanded={adding}
          disabled={bots.length === 0 || settings.exceptions.length >= 64}
          onClick={() => setAdding((open) => !open)}
        >
          添加例外
        </button>
      </SettingsHeaderAction>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <SettingsGroup title="可以多加一层确认">
        <LevelRow
          title="读取频道和附件"
          description="Bot 读取频道消息或附件时"
          value={settings.productRead}
          disabled={saving}
          onChange={(productRead) => void save({ productRead })}
        />
        <LevelRow
          title="阅读公开网页"
          description="打开公开 HTTPS 网页；搜索没有确切目标，不能加例外"
          value={settings.publicWeb}
          disabled={saving}
          onChange={(publicWeb) => void save({ publicWeb })}
        />
      </SettingsGroup>

      {adding ? (
        <ExceptionForm
          bots={bots}
          channels={channels}
          saving={saving}
          onCancel={() => setAdding(false)}
          onAdd={async (entry) => {
            if (await save({ exceptions: [...settings.exceptions, entry] })) setAdding(false);
          }}
        />
      ) : null}

      <section className="settings-group">
        <h3>例外 · 可以不问的目标</h3>
        {settings.exceptions.length === 0 ? (
          <p className="settings-empty">
            还没有例外。只有在上面选了「每次都问」时，例外才会让某个 Bot 读取确切目标时不再问你。
          </p>
        ) : (
          <div className="settings-group-rows">
            {settings.exceptions.map((entry, index) => (
              <div className="settings-item settings-exception" key={JSON.stringify(entry)}>
                <span className="settings-item-text">
                  <strong>{botName(entry.botId)}</strong>
                  <small>
                    {categoryLabels[entry.category]} · {targetLabel(entry)}
                  </small>
                </span>
                <button
                  type="button"
                  className="ob-pill is-small"
                  disabled={saving}
                  aria-label={`移除 ${botName(entry.botId)} 的例外`}
                  onClick={() =>
                    void save({ exceptions: settings.exceptions.filter((_, i) => i !== index) })
                  }
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <SettingsGroup title="不能加例外">
        {settings.protectedExceptionCategories.map((category) => (
          <SettingRow
            key={category}
            title={protectedLabels[category]}
            description="按原有的最低审批与权限规则执行"
          >
            <span className="settings-tag">不可例外</span>
          </SettingRow>
        ))}
      </SettingsGroup>
      <p className="settings-footnote">
        例外只取消你额外加的确认，不会放宽 Bot 本来就需要的审批，也不会扩大它能访问的范围。
      </p>
      <ApprovalPolicySettings />
    </>
  );
}

function LevelRow({
  title,
  description,
  value,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  value: Level;
  disabled: boolean;
  onChange(value: Level): void;
}) {
  return (
    <SettingRow title={title} description={description}>
      <select
        aria-label={title}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "required" ? "required" : "inherit")}
      >
        {(Object.keys(levelLabels) as Level[]).map((level) => (
          <option key={level} value={level}>
            {levelLabels[level]}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

function ExceptionForm({
  bots,
  channels,
  saving,
  onAdd,
  onCancel,
}: {
  bots: Bot[];
  channels: Channel[];
  saving: boolean;
  onAdd(entry: ApprovalException): Promise<void>;
  onCancel(): void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [category, setCategory] = useState<ApprovalException["category"]>("product_read");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [page, setPage] = useState("");
  const [error, setError] = useState<string>();

  function submit() {
    setError(undefined);
    if (category === "product_read") {
      if (!channelId) return setError("先选择一个频道。");
      void onAdd({ botId, category, target: { kind: "channel", value: channelId } });
      return;
    }
    // The Server validates the exact form; this only catches obvious mistakes early.
    let url: URL;
    try {
      url = new URL(page.trim());
    } catch {
      return setError("请输入完整的 https:// 网址。");
    }
    if (url.protocol !== "https:" || url.search || url.hash)
      return setError("只能填写一个确切的 https 网址，不含 ? 或 #。");
    void onAdd({ botId, category, target: { kind: "page", value: url.href } });
  }

  return (
    <section className="settings-group">
      <h3>添加例外</h3>
      <div className="settings-card settings-exception-form">
        <label className="ob-field">
          Bot
          <select value={botId} onChange={(event) => setBotId(event.target.value)}>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ob-field">
          操作
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value === "public_web" ? "public_web" : "product_read")
            }
          >
            <option value="product_read">读取频道</option>
            <option value="public_web">阅读网页</option>
          </select>
        </label>
        {category === "product_read" ? (
          <label className="ob-field">
            频道
            <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
              {channels
                .filter((channel) => !channel.directBotId)
                .map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    # {channel.name}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <label className="ob-field">
            确切网址
            <input
              type="url"
              inputMode="url"
              placeholder="https://example.com/pricing"
              value={page}
              onChange={(event) => setPage(event.target.value)}
            />
          </label>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" className="ob-pill is-small" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ob-pill is-small is-primary"
            disabled={saving || !botId}
            onClick={submit}
          >
            添加
          </button>
        </footer>
      </div>
    </section>
  );
}
