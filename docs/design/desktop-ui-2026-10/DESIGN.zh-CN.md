# OpenBot Desktop 设计规则

[English](DESIGN.md) · [简体中文](DESIGN.zh-CN.md)

这是 Desktop 与 Web 客户端必须遵守的设计参考。来源是 Owner 的设计画布；本文件旁边的
`.dc.html` 是它的只读快照（见 [README.zh-CN.md](README.zh-CN.md)）。交付计划见
[IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md)。

## 规则

1. **界面上的每个元素都能对应到画板。** 代码复现画布，不自创布局。没有画板的界面、对话框、
   卡片或状态，先在画布上设计并经 Owner 确认，再实现。
2. **旧设计不保留。** 之前的界面是退役，不是换皮。还在渲染旧样式类（见[旧设计清单](#旧设计清单)）
   的组件属于未完成的工作，不是可接受的变体。新代码不得使用这些类。
3. **只有一层设计令牌。** 颜色、字号、圆角和间距来自 `--ob-*` 令牌和
   `apps/web/src/styles.css` 中的共享基础组件。组件样式放在组件旁边。
4. **数据如实。** 数据或能力还不存在的设计元素隐藏或只读，绝不伪造。
5. **每个 PR 都更新本文件**：设计、实现或退役的范围有变化时同步修改。

## 基础

| 方面 | 取值 |
| --- | --- |
| 颜色 | 正文 `#1d1d1f`，次要 `#6e6e73`，三级 `#8e8e93`；页面 `#fcfcfc`；填充 `#f0f0f2`；悬停 `#e6e6e8`；分隔 `#e3e3e6`；主色 `#111111`；蓝 `#1f6fd6`；在线 `#34c759`；危险 `#b3261e`（令牌 `--ob-*`） |
| 字体 | 系统 UI / PingFang SC；正文 15px，说明 13px，元信息 12px，分区标题 13px/500，页面标题 24–28px/700 |
| 圆角 | 胶囊按钮 17px（高 34px），卡片 16–18px，气泡 22px，头像 12px（方）或 50%（圆），对话框 20–22px |
| 基础组件 | `.ob-pill`（`is-primary`、`is-outline`、`is-danger`、`is-small`）、`.ob-round`（`is-send`、`is-close`）、`.ob-switch`（44×26）、`.ob-filter`、`.ob-tag`、`.ob-field`、`.ob-search`、`.ob-card`、`.ob-menu`、`.ob-menu-item` |

## 窗口外壳

- 三栏：侧栏 300px、主区、右栏 340px（1280/1100px 宽时为 264/300、236/264）。
- **没有通栏工具栏。** 侧栏第一行放 macOS 红绿灯（桌面端位于 x 20、y 20）和「新建」按钮，二者在同一条
  30px 高的行内居中对齐，下面是搜索。
- 主区有自己的 56px 标题行：左侧是对话标题胶囊；右侧是「实时」状态和「分享」。
- **点击标题胶囊打开右栏**（频道信息 / Bot 信息），与 Main 画板一致；右栏的「收起」关闭它。成员的
  添加与移除在右栏完成，不再用弹窗。
- 后退、前进和两侧栏的开关是快捷键与菜单命令（⌘[ ⌘] ⌘B ⌘⇧B），不是工具栏按钮。侧栏隐藏时，
  主区标题行给红绿灯留出位置，并显示一个重新打开侧栏的按钮。

## 画板与代码对应

| 画板 | 实现位置 |
| --- | --- |
| Sidebar、Search、Menu、ContextMenu | `Sidebar.tsx`、`SidebarItemMenu.tsx` |
| Main | `App.tsx`（外壳标题行）、`ChannelWorkspace.tsx`、`ChannelMessagePresentation.css`、`ContextRail.tsx` |
| Profile | `EmployeeProfileView.tsx`、`EmployeeProfileRail.tsx` |
| New | `NewChatScreen.tsx` |
| Slash | `ChannelWorkspace.tsx`（输入框菜单） |
| Settings、SettingsNav、Settings* | `DesktopSettingsScreen.tsx`、`Settings*.tsx`、`SettingsDialog.css` |
| Plugins | `PluginsDialog.tsx`、`PluginManagerPanel.tsx`（catalog 变体） |
| Components | `styles.css` 中的令牌与基础组件 |

## 尚未设计

以下内容需要先有画板再重做；在此之前保持现有行为。

| 方面 | 现在的代码 | 备注 |
| --- | --- | --- |
| 启动、登录与首次设置，以及开场动画 | `DesktopInstallScreen`、`LoginScreen`、`DesktopSetupScreen`、`DesktopConnectionScreen`、`DesktopLocalWorkerScreen`、`ModelSettingsScreen`（引导） | Owner 正在重新设计 |
| Bot 头像 | `RobotAvatar` | Owner 提供之前的头像方案 |
| 对话中的任务卡、协作与失败状态；任务详情 | `NativeRunControls`、`RunCollaboration`、`RunInspector` | |
| 对话框：新建 Bot、新建频道、分享、删除、导入导出、主机配对、模型连接 | `CreateBotDialog`、`CreateChannelDialog`、`ShareConversationDialog`、`DeleteIdentityDialog`、`Import/ExportEmployeeDialog`、`NodeManagerDialog`、`ModelConnectionsDialog` | |
| 任务监督 | `WorkTasksScreen` | |
| 手机布局 | `MobileNavigation` | |
| 档案分页内容（进化、技能图谱、记忆、记录） | `EmployeeEvolutionArchive`、`EmployeeSkillReview`、`KnowledgeReviewPanel` | |

## 旧设计清单

必须消失的旧样式类：`primary-button`、`secondary-button`、`icon-button`、`create-dialog`、
`dialog-header`、`dialog-backdrop`、`login-card`、`onboarding-mark`、`loading-screen`、
`destination-*`、`workspace-toolbar`/`toolbar-*`、`channel-members-*`、`usage-rail-*`。旧样式表：
`styles.css` 的大部分、`workspace-shell.css`、`desktop-workspace.css`、`workspace-preferences.css`、
`components/destinations.css`。

退役顺序：(1) 窗口外壳与频道右栏；(2) 对话中的任务卡；(3) 对话框；(4) 启动、登录与设置，以及新头像；
(5) 任务监督与手机布局；(6) 删除旧样式表与旧样式类。每一步在同一个 PR 中删除它所替换的旧规则。
