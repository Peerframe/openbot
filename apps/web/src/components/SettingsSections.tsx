// Shared settings building blocks (group, row, workspace loader) and small sections: the approval
// rules summary, the audit log with CSV export, and the 例行任务 entry.
import type { WorkspaceSnapshot } from "@openbot/domain";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type AuditCategory,
  type AuditEvent,
  auditCategories,
  auditExportUrl,
  getWorkspace,
  listAuditEvents,
} from "../api";
import { AutomationsScreen } from "./AutomationsScreen";
import { SettingsHeaderAction } from "./SettingsHeaderAction";
import "./SettingsSections.css";

export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      <div className="settings-group-rows">{children}</div>
    </section>
  );
}

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

/**
 * Read-only summary of the approval rules the Server enforces (docs/PLUGINS.md,
 * docs/CONTROLLED_BROWSER.md, docs/NATIVE_AGENT.md, docs/REVIEWED_SKILLS.md). The client has no
 * authority to loosen them, so nothing here is a control.
 */
export function ApprovalPolicySettings() {
  return (
    <>
      <SettingsGroup title="每次都需要你批准" description="请求会出现在对应频道或任务中。">
        <SettingRow
          title="插件的「每次确认」工具"
          description="写入、发消息等外部改动每次调用前都要批准，60 秒内处理。一次批准只放行一次调用。"
        />
        <SettingRow
          title="受控浏览器操作"
          description="读取页面、点击、输入等每一步都需要单独批准；该功能默认关闭。"
        />
        <SettingRow
          title="工作电脑上的动作"
          description="会改动文件或外部系统的动作在执行前需要批准。拒绝、过期或取消任务后都不会执行。"
        />
      </SettingsGroup>
      <SettingsGroup title="事先授权，不再逐次询问">
        <SettingRow
          title="插件的「只读」工具"
          description="你为某个 Bot 明确授予后，它可以直接调用这类只读工具。可随时在插件页撤销。"
        />
        <SettingRow
          title="公开网页阅读"
          description="阅读公开 HTTPS 网页和搜索结果不需要逐条批准；网页内容始终按不可信资料处理。"
        />
      </SettingsGroup>
      <SettingsGroup title="需要先审核或绑定">
        <SettingRow title="技能" description="导入的技能需要审核后才能被 Bot 使用。" />
        <SettingRow title="工作设备" description="设备完成绑定后，才能接收任务。" />
      </SettingsGroup>
      <p className="settings-footnote">以上规则由 OpenBot 服务执行。批准记录不会在重启后重放。</p>
    </>
  );
}

// Every event type the Server writes (apps/server/src) has a label; an unknown type falls back to
// its category, so the Owner never sees an internal code such as "auth login succeeded".
const auditLabels: Record<string, string> = {
  AUTH_LOGIN_SUCCEEDED: "登录成功",
  AUTH_LOGIN_FAILED: "登录失败",
  AUTH_LOGOUT: "退出登录",
  OWNER_PASSWORD_CHANGED: "修改密码",
  OWNER_SESSIONS_REVOKED: "退出其他设备",
  SETTINGS_OWNER_UPDATED: "更改偏好设置",
  SETTINGS_APPROVAL_UPDATED: "更改审批规则",
  SETTINGS_STORAGE_UPDATED: "更改存储设置",
  SETTINGS_TRASH_AUTO_PURGE_RUN: "自动清空回收站",
  MODEL_CONNECTION_CREATED: "添加模型服务",
  MODEL_CONNECTION_UPDATED: "更新模型服务",
  MODEL_CONNECTION_DELETED: "删除模型服务",
  EMPLOYEE_MODEL_UPDATED: "更改 Bot 模型",
  EMPLOYEE_APPEARANCE_UPDATED: "更新 Bot 头像",
  BOT_GREETING_STARTED: "Bot 开始打招呼",
  BOT_GREETING_FAILED: "Bot 打招呼失败",
  AUTOMATION_CREATED: "创建例行任务",
  AUTOMATION_PAUSED: "暂停例行任务",
  AUTOMATION_RESUMED: "恢复例行任务",
  AUTOMATION_DELETED: "删除例行任务",
  AUTOMATION_OCCURRENCE: "执行例行任务",
  CHANNEL_ATTACHMENT_PURGED: "清理频道附件",
  BROWSER_COMMAND: "浏览器操作",
  BROWSER_CONTROL_STATE: "切换浏览器控制",
  BROWSER_HOST_BOUND: "绑定浏览器主机",
  BROWSER_TRANSPORT_ADMITTED: "允许浏览器连接",
  BROWSER_TRANSPORT_CLAIMED: "接管浏览器连接",
  CHANNEL_CREATED: "创建频道",
  CHANNEL_RENAMED: "重命名频道",
  CHANNEL_DELETED: "删除频道",
  BOT_CREATED: "创建 Bot",
  BOT_IMPORTED: "导入 Bot",
  BOT_RENAMED: "重命名 Bot",
  BOT_DELETED: "删除 Bot",
  BOT_JOINED_CHANNEL: "Bot 加入频道",
  BOT_REMOVED_FROM_CHANNEL: "Bot 移出频道",
  EMPLOYEE_PROFILE_UPDATED: "更新 Bot 档案",
  MESSAGE_CREATED: "发送消息",
  MESSAGE_REACTION_CHANGED: "更改回应",
  RUN_CREATED: "创建任务",
  RUN_STARTED: "开始任务",
  RUN_PROGRESS: "任务进展",
  RUN_COMPLETED: "完成任务",
  RUN_FAILED: "任务失败",
  RUN_CANCELLED: "停止任务",
  RUN_STEERING_SUBMITTED: "补充任务要求",
  RUN_STEERING_APPLIED: "采纳补充要求",
  TASK_DELEGATED: "委派任务",
  KNOWLEDGE_PROPOSED: "提出新知识",
  KNOWLEDGE_PROPOSAL_REVIEWED: "审核新知识",
  KNOWLEDGE_PROPOSAL_SKIPPED: "跳过新知识",
  KNOWLEDGE_READ: "读取知识",
  SKILL_READ: "读取技能",
  MODEL_USAGE_RECORDED: "记录模型用量",
  BROWSER_OPENED: "打开浏览器",
};

function auditTitle(event: AuditEvent) {
  if (event.type === "SETTINGS_PRIMARY_BOT_UPDATED") {
    const previous =
      event.details.previousBotId == null ? "未设置" : (event.details.from ?? "未知 Bot");
    const current =
      event.details.primaryBotId == null ? "未设置" : (event.details.to ?? "未知 Bot");
    return `更改主 Bot：${previous} → ${current}`;
  }
  const label = auditLabels[event.type] ?? `${auditCategoryLabels[event.category ?? "other"]}事件`;
  const from = event.details.from;
  const to = event.details.to;
  if (typeof from === "string" && typeof to === "string") return `${label}：${from} → ${to}`;
  return label;
}

function auditSubject(event: AuditEvent) {
  const parts: string[] = [];
  if (event.channelName)
    parts.push(event.channelDeleted ? `${event.channelName}（已删除的频道）` : event.channelName);
  if (event.botName)
    parts.push(event.botDeleted ? `${event.botName}（已删除的 Bot）` : event.botName);
  return parts.join(" · ");
}

/** Owner audit trail from GET /api/v1/audit; the Server allowlists every projected field. */
/** Labels for the Server's audit categories, in the artboard's chip order. */
const auditCategoryLabels: Record<AuditCategory, string> = {
  approvals: "审批",
  settings: "设置变更",
  authentication: "登录",
  hosts: "主机",
  channels: "频道",
  bots: "Bot",
  runs: "任务",
  plugins: "插件",
  other: "其他",
};

/**
 * Owner audit trail from GET /api/v1/audit; the Server allowlists every projected field and
 * filters by category (backlog C3). CSV export downloads the same filter, up to 1000 events.
 */
export function AuditLogSettings() {
  const [events, setEvents] = useState<AuditEvent[]>();
  const [nextBefore, setNextBefore] = useState<string>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<AuditCategory>();

  const load = useCallback(
    async (before?: string, signal?: AbortSignal) => {
      setLoading(true);
      setError(false);
      try {
        const page = await listAuditEvents({
          ...(before ? { before } : {}),
          ...(category ? { category } : {}),
          ...(signal ? { signal } : {}),
        });
        if (signal?.aborted) return;
        setEvents((current) => (before ? [...(current ?? []), ...page.events] : page.events));
        setNextBefore(page.nextBefore);
      } catch {
        if (!signal?.aborted) setError(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [category],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);

  const filters = (
    <fieldset className="settings-filters" aria-label="按类别筛选">
      {([undefined, ...auditCategories.filter((item) => item !== "other")] as const).map((item) => (
        <button
          type="button"
          key={item ?? "all"}
          className="ob-filter"
          aria-pressed={category === item}
          onClick={() => {
            setCategory(item);
            setEvents(undefined);
          }}
        >
          {item ? auditCategoryLabels[item] : "全部"}
        </button>
      ))}
    </fieldset>
  );
  const exportAction = (
    <SettingsHeaderAction>
      <a className="ob-pill" href={auditExportUrl(category)} download="openbot-audit.csv">
        导出 CSV
      </a>
    </SettingsHeaderAction>
  );

  if (events === undefined)
    return (
      <>
        {exportAction}
        {filters}
        {error ? (
          <div className="settings-load-notice" role="alert">
            <p>无法读取审计记录，请重试。</p>
            <button type="button" className="ob-pill" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : (
          <p className="settings-load-notice" role="status">
            正在读取审计记录…
          </p>
        )}
      </>
    );

  const days = groupByDay(events);
  return (
    <>
      {exportAction}
      {filters}
      {events.length === 0 ? (
        <SettingsGroup title="最近的操作">
          <SettingRow
            title="暂无记录"
            description={
              category
                ? "这个类别还没有记录。"
                : "登录、设置变更、审批、主机和任务处理都会记录在这里。"
            }
          />
        </SettingsGroup>
      ) : (
        days.map((day) => (
          <section className="settings-group" key={day.label}>
            <h3>{day.label}</h3>
            <ol className="settings-group-rows audit-list">
              {day.events.map((event) => (
                <li key={event.id}>
                  <time dateTime={event.createdAt}>
                    {clockFormat.format(new Date(event.createdAt))}
                  </time>
                  <div>
                    <strong>{auditTitle(event)}</strong>
                    {auditSubject(event) ? <p>{auditSubject(event)}</p> : null}
                  </div>
                  {event.category && event.category !== "other" ? (
                    <span className="ob-tag">{auditCategoryLabels[event.category]}</span>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
      {error ? (
        <p className="form-error" role="alert">
          无法读取更多记录，请重试。
        </p>
      ) : null}
      {nextBefore ? (
        <button
          type="button"
          className="ob-pill audit-more"
          disabled={loading}
          onClick={() => void load(nextBefore)}
        >
          {loading ? "正在读取…" : "显示更早的记录"}
        </button>
      ) : null}
      <p className="settings-footnote">
        记录只能查看，不能修改或删除；只包含名称、对象和时间，不含消息正文。
      </p>
    </>
  );
}

const clockFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

function groupByDay(events: AuditEvent[]) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const days: Array<{ label: string; events: AuditEvent[] }> = [];
  for (const event of events) {
    const date = new Date(event.createdAt);
    const label =
      date.toDateString() === today.toDateString()
        ? "今天"
        : date.toDateString() === yesterday.toDateString()
          ? "昨天"
          : `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
    const last = days.at(-1);
    if (last?.label === label) last.events.push(event);
    else days.push({ label, events: [event] });
  }
  return days;
}

/** One bounded workspace read for settings sections that need the Bot and channel lists. */
export function useSettingsWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A user retry must restart the bounded workspace read.
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setWorkspace(undefined);
    void getWorkspace(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
      .then((value) => {
        if (!controller.signal.aborted) setWorkspace(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [revision]);
  return { workspace, error, retry: () => setRevision((value) => value + 1) };
}

/** Loading and failure states shared by workspace-backed settings sections. */
export function SettingsWorkspaceGate({
  label,
  children,
  extra,
}: {
  label: string;
  children(workspace: WorkspaceSnapshot): ReactNode;
  extra?: ReactNode;
}) {
  const { workspace, error, retry } = useSettingsWorkspace();
  if (error)
    return (
      <div className="settings-load-notice" role="alert">
        <p>无法读取工作空间，请重试。</p>
        <button type="button" className="ob-pill" onClick={retry}>
          重试
        </button>
        {extra}
      </div>
    );
  if (!workspace)
    return (
      <p className="settings-load-notice" role="status">
        正在读取{label}…
      </p>
    );
  return <>{children(workspace)}</>;
}

export function SettingsAutomations({ onOpen }: { onOpen?: (() => void) | undefined }) {
  return (
    <SettingsWorkspaceGate
      label="例行任务"
      extra={
        onOpen ? (
          <button type="button" className="ob-pill" onClick={onOpen}>
            打开自动任务
          </button>
        ) : null
      }
    >
      {(workspace) => <AutomationsScreen bots={workspace.bots} channels={workspace.channels} />}
    </SettingsWorkspaceGate>
  );
}
