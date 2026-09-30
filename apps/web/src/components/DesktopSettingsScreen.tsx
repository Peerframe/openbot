import { type ReactNode, useEffect, useState } from "react";
import {
  type DesktopConnectionState,
  type DesktopLocalWorkerState,
  type DesktopSetupPlanInput,
  type DesktopSidebarMaterialState,
  getOpenBotDesktopBridge,
} from "../desktop-runtime";
import { shortcutLabel } from "../desktop-shortcuts";
import {
  type NotificationSupport,
  notificationSupport,
  requestNotificationPermission,
  showSystemNotification,
} from "../system-notifications";
import {
  defaultPreferences,
  updatePreferences,
  useWorkspacePreferences,
} from "../workspace-preferences";
import {
  ApprovalIcon,
  AuditIcon,
  AutomationIcon,
  BellIcon,
  BotIcon,
  CloseIcon,
  NodeIcon,
  SearchIcon,
  SettingsIcon,
} from "./Icons";
import { ModelSettingsScreen } from "./ModelSettingsScreen";
import { OpenBotMark } from "./OpenBotMark";
import {
  ApprovalPolicySettings,
  AuditLogSettings,
  SettingRow,
  SettingsAutomations,
  SettingsGroup,
} from "./SettingsSections";

export type DesktopSettingsSection =
  | "general"
  | "models"
  | "connection"
  | "automations"
  | "notifications"
  | "approvals"
  | "audit"
  | "privacy"
  | "about";
type Section = DesktopSettingsSection;
const sections: Array<{ id: Section; label: string; icon: ReactNode; description: string }> = [
  {
    id: "general",
    label: "常规",
    icon: <SettingsIcon />,
    description: "让 OpenBot 按照你的习惯工作。",
  },
  {
    id: "models",
    label: "模型服务",
    icon: <BotIcon />,
    description: "管理 Bot 使用的默认模型服务。",
  },
  {
    id: "connection",
    label: "工作电脑",
    icon: <NodeIcon />,
    description: "管理这台电脑的角色、连接与工作设备。",
  },
  {
    id: "automations",
    label: "自动任务",
    icon: <AutomationIcon />,
    description: "让 Bot 按计划在频道中完成工作。",
  },
  {
    id: "notifications",
    label: "通知",
    icon: <BellIcon />,
    description: "OpenBot 不在前台时，用系统通知提醒你。",
  },
  {
    id: "approvals",
    label: "审批与权限",
    icon: <ApprovalIcon />,
    description: "哪些操作需要你批准。规则由服务端执行，这里只能查看。",
  },
  {
    id: "audit",
    label: "审计记录",
    icon: <AuditIcon />,
    description: "查看频道、Bot 与任务的关键操作记录。",
  },
  {
    id: "privacy",
    label: "隐私与数据",
    icon: <ApprovalIcon />,
    description: "了解数据保存在哪里，以及操作由谁授权。",
  },
  { id: "about", label: "关于 OpenBot", icon: <OpenBotMark />, description: "你的 Bot 工作空间。" },
];

export function DesktopSettingsScreen({
  error,
  plan,
  connection,
  localWorker,
  material,
  onConnection,
  onRole,
  onWorker,
  onBack,
  initialSection = "general",
  onAutomations,
}: {
  error?: string | undefined;
  /** Absent in the plain Web entry, which has no Desktop plan, material or local worker. */
  plan?: DesktopSetupPlanInput | undefined;
  connection?: DesktopConnectionState | null | undefined;
  localWorker?: DesktopLocalWorkerState | null | undefined;
  material?: DesktopSidebarMaterialState | undefined;
  onConnection?(): void;
  onRole?(): void;
  onWorker?(): void;
  onBack(): void;
  initialSection?: DesktopSettingsSection;
  onAutomations?(): void;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [search, setSearch] = useState("");
  useEffect(() => setSection(initialSection), [initialSection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the section changes.
  useEffect(() => {
    // On phones the section list is a horizontal pill row; keep the current one visible.
    document
      .querySelector(".settings-navigation nav [aria-current='page']")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);
  const { values, saved } = useWorkspacePreferences();
  const [resetNotice, setResetNotice] = useState(false);
  const runtime = getOpenBotDesktopBridge()?.getRuntimeInfo?.();
  const selected = sections.find((item) => item.id === section) ?? sections[0];
  const term = search.trim().toLocaleLowerCase();
  const keywords: Record<Section, string> = {
    general: "外观 字号 透明 密度 聊天 快捷键 动效 时间 侧栏 导航",
    models: "API Kimi DeepSeek OpenAI Anthropic 模型 密钥 服务",
    connection: "连接 设备 绑定 权限 服务地址 工作组件",
    automations: "定时 计划 调度 自动 任务",
    notifications: "通知 提醒 系统 消息 回复 审批",
    approvals: "审批 批准 权限 插件 浏览器 确认 授权",
    audit: "审计 记录 日志 历史 删除 重命名",
    privacy: "隐私 数据 保存 恢复 默认 权限",
    about: "版本 平台 Electron Hermes 关于",
  };
  const desktop = plan !== undefined;
  const matching = sections.filter(
    (item) =>
      (desktop || item.id !== "connection") &&
      `${item.label} ${item.description} ${keywords[item.id]}`.toLocaleLowerCase().includes(term),
  );
  return (
    <div className="desktop-settings-layout settings-refresh">
      <aside className="settings-navigation">
        <button className="settings-back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> 返回应用
        </button>
        <h1 className="settings-nav-title">设置</h1>
        <search className="settings-search" aria-label="搜索设置">
          <SearchIcon />
          <input
            aria-label="搜索设置"
            type="search"
            placeholder="搜索设置…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </search>
        <nav aria-label="设置分类">
          {(
            [
              { label: "应用", ids: ["general", "notifications", "about"] },
              { label: "工作空间", ids: ["models", "connection", "automations"] },
              { label: "安全与记录", ids: ["approvals", "audit", "privacy"] },
            ] as const
          ).map((group) => {
            const items = group.ids.flatMap((id) => matching.filter((item) => item.id === id));
            return items.length > 0 ? (
              <div className="settings-nav-group" key={group.label}>
                <p>{group.label}</p>
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={section === item.id ? "page" : undefined}
                    onClick={() => {
                      setSection(item.id);
                      setSearch("");
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        {matching.length === 0 && (
          <p className="settings-search-empty" role="status">
            没有匹配的设置，试试“模型”或“外观”。
          </p>
        )}
        <div className="settings-brand">
          <span>
            {desktop ? "OpenBot Desktop" : "OpenBot"}
            <small>此设备的设置</small>
          </span>
        </div>
      </aside>
      <section className="settings-content" aria-labelledby="settings-section-title">
        <header className="settings-page-header">
          <div>
            <h2 id="settings-section-title">{selected?.label}</h2>
            <p>{selected?.description}</p>
          </div>
          <button className="icon-button" aria-label="关闭设置" type="button" onClick={onBack}>
            <CloseIcon />
          </button>
        </header>
        <div className="settings-page-body">
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          {!saved && (
            <p className="connection-warning" role="status">
              当前偏好仅在本次打开期间有效，无法保存到此设备。
            </p>
          )}
          {section === "general" && (
            <>
              <SettingsGroup title="外观" description="更少的干扰，刚好的信息。">
                {material ? (
                  <SettingRow
                    title="半透明侧栏"
                    description={
                      material.status === "reduced"
                        ? "系统已启用减少透明度或高对比度，当前使用不透明背景。"
                        : material.status === "unsupported" || material.status === "unavailable"
                          ? "当前运行环境使用不透明背景；macOS 桌面应用支持原生材质。"
                          : "让 macOS 原生材质融入左侧导航。"
                    }
                  >
                    <Switch
                      label="半透明侧栏"
                      checked={
                        values.sidebarTranslucent &&
                        material.status !== "unsupported" &&
                        material.status !== "unavailable"
                      }
                      disabled={
                        material.status === "unsupported" || material.status === "unavailable"
                      }
                      onChange={(checked) => updatePreferences({ sidebarTranslucent: checked })}
                    />
                  </SettingRow>
                ) : null}
                <SettingRow
                  title="显示左侧导航"
                  description="查看频道、Bot 和工作空间入口，也可从顶部工具栏切换。"
                >
                  <Switch
                    label="显示左侧导航"
                    checked={values.leftPanelOpen}
                    onChange={(checked) => updatePreferences({ leftPanelOpen: checked })}
                  />
                </SettingRow>
                <SettingRow
                  title="显示右侧信息栏"
                  description="查看用量、任务状态和待处理事项，也可从顶部工具栏切换。"
                >
                  <Switch
                    label="显示右侧信息栏"
                    checked={values.rightPanelOpen}
                    onChange={(checked) => updatePreferences({ rightPanelOpen: checked })}
                  />
                </SettingRow>
                <SettingRow title="界面密度" description="调整侧栏列表和消息之间的间距。">
                  <select
                    aria-label="界面密度"
                    value={values.density}
                    onChange={(event) =>
                      updatePreferences({
                        density: event.target.value === "compact" ? "compact" : "comfortable",
                      })
                    }
                  >
                    <option value="comfortable">舒适</option>
                    <option value="compact">紧凑</option>
                  </select>
                </SettingRow>
                <SettingRow title="聊天字号" description="调整消息正文和输入区的文字大小。">
                  <select
                    aria-label="聊天字号"
                    value={values.fontSize}
                    onChange={(event) =>
                      updatePreferences({
                        fontSize: event.target.value === "large" ? "large" : "normal",
                      })
                    }
                  >
                    <option value="normal">标准 · 14 px</option>
                    <option value="large">较大 · 16 px</option>
                  </select>
                </SettingRow>
                <SettingRow
                  title="减少动态效果"
                  description="关闭平滑滚动与界面动效。系统的减少动态效果设置始终优先。"
                >
                  <Switch
                    label="减少动态效果"
                    checked={values.reduceMotion}
                    onChange={(checked) => updatePreferences({ reduceMotion: checked })}
                  />
                </SettingRow>
              </SettingsGroup>
              <SettingsGroup title="聊天" description="让输入与阅读符合你的习惯。">
                <SettingRow title="发送消息" description="Shift + Enter 始终换行。">
                  <select
                    aria-label="发送消息快捷键"
                    value={values.sendShortcut}
                    onChange={(event) =>
                      updatePreferences({
                        sendShortcut: event.target.value === "modifier" ? "modifier" : "enter",
                      })
                    }
                  >
                    <option value="enter">Enter 发送</option>
                    <option value="modifier">{shortcutLabel("Enter")} 发送</option>
                  </select>
                </SettingRow>
                <SettingRow title="消息时间格式" description="用于频道消息的时间显示。">
                  <select
                    aria-label="消息时间格式"
                    value={values.hour12 ? "12" : "24"}
                    onChange={(event) => updatePreferences({ hour12: event.target.value === "12" })}
                  >
                    <option value="24">24 小时制</option>
                    <option value="12">12 小时制</option>
                  </select>
                </SettingRow>
              </SettingsGroup>
              <p className="settings-footnote">
                偏好自动保存在这台设备。模型与服务配置由你的服务电脑管理。
              </p>
            </>
          )}
          {section === "models" && <ModelSettingsScreen embedded onDone={() => {}} />}
          {section === "automations" && <SettingsAutomations onOpen={onAutomations} />}
          {section === "notifications" && <NotificationSettings />}
          {section === "approvals" && <ApprovalPolicySettings />}
          {section === "audit" && <AuditLogSettings />}
          {section === "connection" && plan && (
            <>
              <SettingsGroup title="当前连接">
                <SettingRow
                  title="这台电脑的用途"
                  description={
                    plan.mode === "host"
                      ? "服务电脑 · 在本机保存数据并运行 OpenBot 服务"
                      : "本地客户端 · 连接已有 OpenBot 服务"
                  }
                >
                  <button className="secondary-button" type="button" onClick={onRole}>
                    更改用途
                  </button>
                </SettingRow>
                <SettingRow
                  title="服务地址"
                  description={
                    connection?.status === "configured" ? connection.serverUrl : "尚未连接"
                  }
                >
                  {plan.mode !== "host" ? (
                    <button type="button" className="secondary-button" onClick={onConnection}>
                      更改连接
                    </button>
                  ) : (
                    <span className="settings-tag">仅本机</span>
                  )}
                </SettingRow>
                <SettingRow
                  title="服务运行"
                  description={
                    plan.mode === "host"
                      ? "退出 OpenBot 会停止本机服务。重新打开后继续使用已保存的数据；自动任务需要服务保持运行。"
                      : "自动任务在服务电脑上调度，客户端无需一直打开。"
                  }
                />
              </SettingsGroup>
              <SettingsGroup title="工作电脑" description="为 Bot 提供执行任务的设备。">
                <SettingRow
                  title="设备、绑定与权限"
                  description="查看在线设备、绑定状态与待批准的权限。"
                >
                  <button className="secondary-button" type="button" onClick={onWorker}>
                    管理工作电脑
                  </button>
                </SettingRow>
                <SettingRow title="本机工作组件" description={workerDescription(localWorker)} />
              </SettingsGroup>
            </>
          )}
          {section === "privacy" && (
            <>
              <SettingsGroup title="数据保存位置">
                <SettingRow
                  title="模型密钥"
                  description="在服务电脑上加密保存。界面只显示配置状态，不会读取已保存的明文密钥。"
                />
                <SettingRow
                  title="频道、Bot 与任务"
                  description="由你连接的 OpenBot 服务保存和管理。客户端显示当前账户有权访问的数据。"
                />
                <SettingRow
                  title="操作与权限"
                  description="技能需要审核，设备需要绑定；任务仍遵守服务端的路由和审批规则。"
                />
                <SettingRow
                  title="用量统计"
                  description="只有服务端记录的用量才会显示；没有记录时显示暂无数据。"
                />
              </SettingsGroup>
              <SettingsGroup title="此设备的偏好">
                <SettingRow
                  title="恢复界面默认设置"
                  description="恢复侧栏、信息栏、字号、间距和聊天习惯。"
                >
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      updatePreferences(defaultPreferences);
                      setResetNotice(true);
                    }}
                  >
                    恢复默认
                  </button>
                </SettingRow>
                {resetNotice && (
                  <p className="settings-success" role="status">
                    已恢复默认界面偏好。
                  </p>
                )}
              </SettingsGroup>
            </>
          )}
          {section === "about" && (
            <>
              <div className="settings-about">
                <OpenBotMark />
                <h3>{desktop ? "OpenBot Desktop" : "OpenBot"}</h3>
                <p>连接你的 Bot，让工作在频道中展开。</p>
              </div>
              <SettingsGroup title="应用信息">
                <SettingRow
                  title="运行平台"
                  description={
                    runtime?.platform === "darwin" ? "macOS" : (runtime?.platform ?? "浏览器")
                  }
                />
                <SettingRow
                  title="桌面运行时"
                  description={runtime ? `Electron ${runtime.shellVersion}` : "Web"}
                />
                <SettingRow
                  title="模型服务"
                  description="在模型服务中查看支持的提供商与当前连接。"
                />
                <SettingRow
                  title="员工进化"
                  description="员工的持续学习与进化方向受到 Hermes Agent 启发。"
                />
              </SettingsGroup>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
const supportText: Record<NotificationSupport, string> = {
  desktop: "由系统通知中心显示。macOS 未签名的开发版可能无法显示。",
  granted: "浏览器已允许 OpenBot 显示通知。",
  default: "打开任一提醒时，浏览器会询问是否允许通知。",
  denied: "浏览器已阻止通知。请在浏览器的网站设置中允许后再试。",
  unsupported: "当前浏览器不支持系统通知。",
};

function NotificationSettings() {
  const { values } = useWorkspacePreferences();
  const [support, setSupport] = useState<NotificationSupport>(notificationSupport);
  const [testResult, setTestResult] = useState<string>();
  const blocked = support === "denied" || support === "unsupported";

  async function enable(key: "notifyApprovals" | "notifyMessages", checked: boolean) {
    if (checked) {
      // Runs inside the switch click, which is the user gesture browsers require.
      const next = await requestNotificationPermission();
      setSupport(next);
      if (next !== "desktop" && next !== "granted") return;
    }
    updatePreferences({ [key]: checked });
  }

  return (
    <>
      <SettingsGroup title="提醒我" description="只在 OpenBot 窗口不在前台时提醒。">
        <SettingRow title="有操作等待批准" description="Bot 请求你批准一个操作时。">
          <Switch
            label="有操作等待批准"
            checked={values.notifyApprovals && !blocked}
            disabled={blocked}
            onChange={(checked) => void enable("notifyApprovals", checked)}
          />
        </SettingRow>
        <SettingRow title="Bot 发来新消息" description="频道或单独对话出现新的未读回复时。">
          <Switch
            label="Bot 发来新消息"
            checked={values.notifyMessages && !blocked}
            disabled={blocked}
            onChange={(checked) => void enable("notifyMessages", checked)}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="系统通知">
        <SettingRow title="状态" description={supportText[support]}>
          <button
            className="secondary-button"
            type="button"
            disabled={blocked}
            onClick={async () => {
              const next = await requestNotificationPermission();
              setSupport(next);
              const shown = await showSystemNotification(
                { title: "OpenBot 通知测试", body: "通知已可以正常显示。" },
                () => undefined,
              );
              setTestResult(shown ? "已发送测试通知。" : "无法显示通知。");
            }}
          >
            发送测试通知
          </button>
        </SettingRow>
        {testResult && (
          <p className="settings-success" role="status">
            {testResult}
          </p>
        )}
      </SettingsGroup>
      <p className="settings-footnote">
        通知只包含 Bot
        和频道名称，不含消息正文或操作详情，因为它可能出现在锁屏上。偏好保存在这台设备。
      </p>
    </>
  );
}

function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="settings-switch">
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true" />
    </label>
  );
}
function workerDescription(state?: DesktopLocalWorkerState | null) {
  const labels: Record<DesktopLocalWorkerState["status"], string> = {
    "not-selected": "当前安装计划未启用本机工作组件。",
    unavailable: "当前应用中未安装本机工作组件。可在工作电脑管理中连接其他设备。",
    "not-configured": "尚未配置，打开工作电脑管理以完成绑定。",
    disabled: "本机工作组件已停用。",
    "requires-approval": "已配置，等待你在系统中批准所需权限。",
    enabled: "本机工作组件已启用。",
    invalid: "本机工作组件配置需要修复，请在工作电脑管理中检查。",
  };
  return state ? labels[state.status] : "可在工作电脑管理中查看设备状态。";
}
