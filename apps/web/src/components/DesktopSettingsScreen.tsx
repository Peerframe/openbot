import { useEffect, useState } from "react";
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
import { CloseIcon, SearchIcon } from "./Icons";
import "./SettingsDialog.css";
import { OpenBotMark } from "./OpenBotMark";
import { PluginManager } from "./PluginManagerPanel";
import { SettingsAccount } from "./SettingsAccount";
import { SettingsApprovals } from "./SettingsApprovals";
import { SettingsBrowser } from "./SettingsBrowser";
import {
  DesktopStartupSettings,
  DockBadgeSetting,
  OwnerPreferenceSettings,
} from "./SettingsGeneral";
import { SettingsActionSlot } from "./SettingsHeaderAction";
import { SettingsHosts } from "./SettingsHosts";
import { SettingsMemory } from "./SettingsMemory";
import { SettingsModelServices } from "./SettingsModelServices";
import {
  AuditLogSettings,
  SettingRow,
  SettingsAutomations,
  SettingsGroup,
  SettingsWorkspaceGate,
} from "./SettingsSections";
import { SettingsSkills } from "./SettingsSkills";
import { SettingsTransfer } from "./SettingsTransfer";
import { useModalDialog } from "./useModalDialog";

export type DesktopSettingsSection =
  | "general"
  | "notify"
  | "model"
  | "skills"
  | "plugins"
  | "routines"
  | "memory"
  | "hosts"
  | "approvals"
  | "browser"
  | "audit"
  | "account"
  | "transfer"
  | "about";
type Section = DesktopSettingsSection;

/** SettingsNav artboard icons (17px, 1.7 stroke). */
const iconPaths: Record<Section, string> = {
  general:
    "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  notify: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  skills: "M13 2L4 14h7l-1 8 9-12h-7z",
  plugins: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  routines: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2",
  memory: "M4 19V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM18 19v2H6",
  hosts: "M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8M12 16v4",
  approvals: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  browser:
    "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM2 12h20M12 2a15 15 0 0 1 4 10a15 15 0 0 1-4 10a15 15 0 0 1-4-10a15 15 0 0 1 4-10z",
  audit: "M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01",
  account: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6",
  transfer: "M7 10l5-5 5 5M12 5v10M5 19h14",
  about: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v5M12 8h.01",
};

const sections: Record<Section, { label: string; description: string; keywords: string }> = {
  general: {
    label: "通用",
    description: "让 OpenBot 按照你的习惯工作。",
    keywords: "外观 字号 透明 密度 聊天 快捷键 动效 时间 侧栏 导航 恢复 默认 时区 模型 启动 后台",
  },
  notify: {
    label: "通知",
    description: "OpenBot 不在前台时，用系统通知提醒你。",
    keywords: "通知 提醒 系统 消息 回复 审批",
  },
  model: {
    label: "模型服务",
    description: "连接常用厂商和 API 平台，再为每个 Bot 选择模型。",
    keywords: "API Kimi DeepSeek OpenAI Anthropic 模型 密钥 服务",
  },
  skills: {
    label: "技能",
    description: "Bot 会做的事。新技能要通过测试或你审核后才能用。",
    keywords: "技能 审核 安装 验证 候选",
  },
  plugins: {
    label: "插件",
    description: "连接外部应用，并决定哪些 Bot 可以用。",
    keywords: "插件 MCP 工具 授权 应用",
  },
  memory: {
    label: "记忆",
    description: "Bot 长期记住的东西。由你查看和维护，模型不能直接写入。",
    keywords: "记忆 知识 经历 做法",
  },
  account: {
    label: "账户与安全",
    description: "你的 Owner 账户和 Bot 的权限边界。",
    keywords: "账户 密码 登录 退出 安全 Owner",
  },
  transfer: {
    label: "导入与导出",
    description: "把 Bot 做成员工模板带到另一台 OpenBot，或者导入别人分享的模板。",
    keywords: "导入 导出 模板 迁移 员工",
  },
  routines: {
    label: "例行任务",
    description: "让 Bot 按时间表自动做事，结果发到指定频道。",
    keywords: "定时 计划 调度 自动 任务 例行",
  },
  hosts: {
    label: "工作主机",
    description: "连接其他电脑，让 Bot 在专用环境里执行任务。",
    keywords: "连接 设备 绑定 权限 服务地址 工作组件 电脑 主机",
  },
  approvals: {
    label: "审批与权限",
    description: "Bot 做哪些事之前要先问你。规则由服务电脑执行，过期的请求不会执行。",
    keywords: "审批 批准 权限 插件 浏览器 确认 授权",
  },
  browser: {
    label: "员工浏览器",
    description: "Bot 上网用的独立浏览器，跑在隔离的容器里，和你自己的浏览器互不影响。",
    keywords: "浏览器 重启 清除 Cookie 登录 容器",
  },
  audit: {
    label: "审计记录",
    description: "谁在什么时候做了什么。记录只能查看，不能修改或删除。",
    keywords: "审计 记录 日志 历史 删除 重命名",
  },
  about: {
    label: "关于 OpenBot",
    description: "你的 Bot 工作空间。",
    keywords: "版本 平台 Electron Hermes 关于 隐私 数据 保存",
  },
};

/** 关于 resources (SettingsAbout artboard); the same public repository as 帮助与反馈. */
const repository = "https://github.com/yxflc11/openbot";
const aboutLinks = [
  { title: "更新日志", description: "每个版本改了什么", href: `${repository}/releases` },
  { title: "源代码", description: "OpenBot 是开源项目", href: repository },
  {
    title: "开源许可与致谢",
    description: "使用到的开源组件和它们的许可证",
    href: `${repository}/blob/main/THIRD_PARTY_NOTICES.zh-CN.md`,
  },
  {
    title: "安全说明",
    description: "各平台实际支持到什么程度",
    href: `${repository}/blob/main/docs/CROSS_PLATFORM.zh-CN.md`,
  },
];

/** SettingsNav artboard groups, in the artboard's order. */
const groups: ReadonlyArray<{ title: string; items: readonly Section[] }> = [
  { title: "", items: ["general", "notify"] },
  { title: "Bot 能力", items: ["model", "skills", "plugins", "routines", "memory"] },
  { title: "执行与安全", items: ["hosts", "approvals", "browser"] },
  { title: "账户", items: ["account", "audit", "transfer", "about"] },
];

export function DesktopSettingsScreen({
  error,
  plan,
  connection,
  localWorker,
  material,
  onConnection,
  onRole,
  onBack,
  initialSection = "general",
  onAutomations,
  counts,
  ownerName,
  onLogout,
}: {
  error?: string | undefined;
  /** Absent in the plain Web entry, which has no Desktop plan, material or local worker. */
  plan?: DesktopSetupPlanInput | undefined;
  connection?: DesktopConnectionState | null | undefined;
  localWorker?: DesktopLocalWorkerState | null | undefined;
  material?: DesktopSidebarMaterialState | undefined;
  onConnection?(): void;
  onRole?(): void;
  onBack(): void;
  initialSection?: DesktopSettingsSection;
  onAutomations?(): void;
  /** Navigation badges, read by the owner from the Server; a missing count shows no badge. */
  counts?: Partial<Record<Section, number>> | undefined;
  ownerName?: string | undefined;
  onLogout?: (() => Promise<void>) | undefined;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const [search, setSearch] = useState("");
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const { dialogRef, closeDialog } = useModalDialog(onBack);
  useEffect(() => setSection(initialSection), [initialSection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the section changes.
  useEffect(() => {
    // On phones the section list is a horizontal row; keep the current one visible.
    dialogRef.current
      ?.querySelector(".settings-dialog-nav [aria-current='page']")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);
  const { values, saved } = useWorkspacePreferences();
  const [resetNotice, setResetNotice] = useState(false);
  const runtime = getOpenBotDesktopBridge()?.getRuntimeInfo?.();
  const selected = sections[section];
  const term = search.trim().toLocaleLowerCase();
  const desktop = plan !== undefined;
  const available = (id: Section) =>
    `${sections[id].label} ${sections[id].description} ${sections[id].keywords}`
      .toLocaleLowerCase()
      .includes(term);
  const anyMatch = groups.some((group) => group.items.some(available));
  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      aria-labelledby="settings-section-title"
      onMouseDown={(event) => {
        // A press on the dimmed backdrop (the dialog element itself) closes settings.
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="settings-dialog-frame">
        <nav className="settings-dialog-nav" aria-label="设置分区">
          <label className="settings-dialog-search">
            <SearchIcon />
            <input
              aria-label="搜索设置"
              type="search"
              placeholder="搜索设置"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {groups.map((group) => {
            const items = group.items.filter(available);
            return items.length > 0 ? (
              <div className="settings-nav-group" key={group.title || "app"}>
                {group.title ? <p>{group.title}</p> : null}
                {items.map((id) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={section === id ? "page" : undefined}
                    onClick={() => {
                      setSection(id);
                      setSearch("");
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={iconPaths[id]} />
                    </svg>
                    <span>{sections[id].label}</span>
                    {counts?.[id] !== undefined ? <small>{counts[id]}</small> : null}
                  </button>
                ))}
              </div>
            ) : null;
          })}
          {!anyMatch && (
            <p className="settings-search-empty" role="status">
              没有匹配的设置，试试“模型”或“字号”。
            </p>
          )}
        </nav>
        <section className="settings-dialog-content" aria-labelledby="settings-section-title">
          <button
            className="settings-dialog-close"
            aria-label="关闭设置"
            type="button"
            onClick={closeDialog}
          >
            <CloseIcon />
          </button>
          <header className="settings-dialog-header">
            <div>
              <h1 id="settings-section-title">{selected.label}</h1>
              <p>{selected.description}</p>
            </div>
            <div className="settings-dialog-action" ref={setActionSlot} />
          </header>
          <SettingsActionSlot.Provider value={actionSlot}>
            <div className="settings-dialog-body">
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
                  <DesktopStartupSettings />
                  <OwnerPreferenceSettings />
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
                        onChange={(event) =>
                          updatePreferences({ hour12: event.target.value === "12" })
                        }
                      >
                        <option value="24">24 小时制</option>
                        <option value="12">12 小时制</option>
                      </select>
                    </SettingRow>
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
                  <p className="settings-footnote">
                    外观和聊天偏好保存在这台设备；时区、默认模型和模型服务保存在你的 OpenBot。
                  </p>
                </>
              )}
              {section === "model" && <SettingsModelServices />}
              {section === "routines" && <SettingsAutomations onOpen={onAutomations} />}
              {section === "skills" && (
                <SettingsWorkspaceGate label="技能">
                  {(workspace) => <SettingsSkills bots={workspace.bots} />}
                </SettingsWorkspaceGate>
              )}
              {section === "plugins" && (
                <SettingsWorkspaceGate label="插件">
                  {(workspace) => <PluginManager bots={workspace.bots} variant="settings" />}
                </SettingsWorkspaceGate>
              )}
              {section === "memory" && (
                <SettingsWorkspaceGate label="记忆">
                  {(workspace) => <SettingsMemory bots={workspace.bots} />}
                </SettingsWorkspaceGate>
              )}
              {section === "transfer" && (
                <SettingsWorkspaceGate label="Bot">
                  {(workspace) => <SettingsTransfer bots={workspace.bots} />}
                </SettingsWorkspaceGate>
              )}
              {section === "notify" && (
                <>
                  <NotificationSettings />
                  <DockBadgeSetting />
                </>
              )}
              {section === "approvals" && (
                <SettingsWorkspaceGate label="审批规则">
                  {(workspace) => (
                    <SettingsApprovals bots={workspace.bots} channels={workspace.channels} />
                  )}
                </SettingsWorkspaceGate>
              )}
              {section === "audit" && <AuditLogSettings />}
              {section === "browser" && (
                <SettingsWorkspaceGate label="员工浏览器">
                  {(workspace) => <SettingsBrowser bots={workspace.bots} />}
                </SettingsWorkspaceGate>
              )}
              {section === "hosts" && (
                <SettingsHosts>
                  {plan ? (
                    <SettingsGroup title="这台电脑">
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
                      <SettingRow
                        title="本机工作组件"
                        description={workerDescription(localWorker)}
                      />
                    </SettingsGroup>
                  ) : null}
                </SettingsHosts>
              )}
              {section === "account" && (
                <SettingsAccount
                  ownerName={ownerName}
                  onLogout={onLogout}
                  onShowAudit={() => setSection("audit")}
                />
              )}
              {section === "about" && (
                <>
                  <div className="settings-about">
                    <OpenBotMark />
                    <h3>{desktop ? "OpenBot Desktop" : "OpenBot"}</h3>
                    <p>
                      {runtime
                        ? `${runtime.platform === "darwin" ? "macOS" : runtime.platform} · Electron ${runtime.shellVersion}`
                        : "Web"}
                    </p>
                  </div>
                  <SettingsGroup title="资料">
                    {aboutLinks.map((link) => (
                      <SettingRow
                        key={link.title}
                        title={link.title}
                        description={link.description}
                      >
                        <a
                          className="secondary-button"
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`打开${link.title}`}
                        >
                          打开 ↗
                        </a>
                      </SettingRow>
                    ))}
                  </SettingsGroup>
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
                      description="技能需要审核，设备需要绑定；任务仍遵守服务电脑的路由和审批规则。"
                    />
                    <SettingRow
                      title="用量统计"
                      description="只有服务电脑记录的用量才会显示；没有记录时显示暂无数据。"
                    />
                  </SettingsGroup>
                  <p className="settings-footnote">Bot 的成长与学习方向受 Hermes Agent 启发。</p>
                </>
              )}
            </div>
          </SettingsActionSlot.Provider>
        </section>
      </div>
    </dialog>
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
      <SettingsGroup title="什么时候通知你" description="只在 OpenBot 窗口不在前台时提醒。">
        <SettingRow title="需要你批准" description="Bot 请求你批准一个操作时。">
          <Switch
            label="需要你批准"
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
    unavailable: "当前应用中未安装本机工作组件。可以在上方配对其他主机。",
    "not-configured": "尚未配置，在上方配对后完成绑定。",
    disabled: "本机工作组件已停用。",
    "requires-approval": "已配置，等待你在系统中批准所需权限。",
    enabled: "本机工作组件已启用。",
    invalid: "本机工作组件配置需要修复。",
  };
  return state ? labels[state.status] : "可在工作电脑管理中查看设备状态。";
}
