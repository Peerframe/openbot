import type { WorkspaceSnapshot } from "@openbot/domain";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type AuditEvent, getWorkspace, listAuditEvents } from "../api";
import { AutomationsScreen } from "./AutomationsScreen";

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
      <p className="settings-footnote">
        这些规则由 OpenBot 服务执行，此处仅供查看。批准记录不会在重启后重放。
      </p>
    </>
  );
}

const auditLabels: Record<string, string> = {
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
  const label = auditLabels[event.type] ?? event.type.replaceAll("_", " ").toLocaleLowerCase();
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

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Owner audit trail from GET /api/v1/audit; the Server allowlists every projected field. */
export function AuditLogSettings() {
  const [events, setEvents] = useState<AuditEvent[]>();
  const [nextBefore, setNextBefore] = useState<string>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (before?: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    try {
      const page = await listAuditEvents({
        ...(before ? { before } : {}),
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);

  if (events === undefined)
    return error ? (
      <div className="settings-load-notice" role="alert">
        <p>无法读取审计记录，请重试。</p>
        <button type="button" className="secondary-button" onClick={() => void load()}>
          重试
        </button>
      </div>
    ) : (
      <p className="settings-load-notice" role="status">
        正在读取审计记录…
      </p>
    );

  return (
    <>
      <SettingsGroup
        title="最近的操作"
        description="按时间倒序显示，只包含名称、对象和时间，不含消息正文。"
      >
        {events.length === 0 ? (
          <SettingRow title="暂无记录" description="创建、重命名、删除和任务处理都会记录在这里。" />
        ) : (
          <ol className="audit-list">
            {events.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{auditTitle(event)}</strong>
                  {auditSubject(event) ? <p>{auditSubject(event)}</p> : null}
                </div>
                <time dateTime={event.createdAt}>
                  {timeFormat.format(new Date(event.createdAt))}
                </time>
              </li>
            ))}
          </ol>
        )}
      </SettingsGroup>
      {error ? (
        <p className="form-error" role="alert">
          无法读取更多记录，请重试。
        </p>
      ) : null}
      {nextBefore ? (
        <button
          type="button"
          className="secondary-button audit-more"
          disabled={loading}
          onClick={() => void load(nextBefore)}
        >
          {loading ? "正在读取…" : "显示更早的记录"}
        </button>
      ) : null}
    </>
  );
}

export function SettingsAutomations({ onOpen }: { onOpen?: (() => void) | undefined }) {
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
  if (error)
    return (
      <div className="settings-load-notice" role="alert">
        <p>无法读取工作空间，请重试。</p>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setRevision((value) => value + 1)}
        >
          重试
        </button>
        {onOpen && (
          <button type="button" className="secondary-button" onClick={onOpen}>
            打开自动任务
          </button>
        )}
      </div>
    );
  if (!workspace)
    return (
      <p className="settings-load-notice" role="status">
        正在读取自动任务…
      </p>
    );
  return (
    <div className="settings-automations">
      <AutomationsScreen bots={workspace.bots} channels={workspace.channels} />
    </div>
  );
}
