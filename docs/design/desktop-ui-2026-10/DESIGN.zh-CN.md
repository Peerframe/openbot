# OpenBot Desktop 设计规则

[English](DESIGN.md) · [简体中文](DESIGN.zh-CN.md)

这是 Desktop 与 Web 客户端必须遵守的设计依据。源头是所有者的设计画布；本文件旁的 `.dc.html` 是它的只读
快照（见 [README.zh-CN.md](README.zh-CN.md)）。交付计划与分工见 [IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md)。

## 规则

1. **以画布为准。** 代码按画板一比一还原：布局、尺寸、文案、状态和交互。之前的界面、之前的文案以及
   没有画板的行为都不作参考。界面上任何没有画板的东西，先在画布上设计、所有者确认，再实现。
2. **不保留旧样子。** 旧界面是退役，不是换皮。还在渲染旧样式类（见[旧设计清单](#旧设计清单)）的组件
   算未完成。
3. **只有一层令牌。** 颜色、字号、圆角、间距来自 `tokens.css` 里的 `--ob-*` 令牌和 `primitives.css` 里的
   共享基础组件（胶囊按钮、`.ob-seg`、`Dialog` 框架）；组件样式放在组件旁边。
4. **数据要诚实。** 数据或能力还不存在的元素先隐藏，绝不造假。画板画的是完成后的样子；计划里写明哪些
   元素要等对应的后端事项完成才显示。
5. **安全不是设计选项。** 审批、仅 Owner 可做的操作、失败即关闭的检查和审计，画板上没画也必须保留；
   设计只决定它们长什么样。
6. **用同一套说法。** 界面文案按[用语表](#用语表)。
7. **看图验收。** 每一步用 1440×900 下实现界面与画板的并排截图，加上列出的交互来验收。截图来自设计预览
   （`npm run design:preview -w @openbot/web`，模拟数据，只用于开发）。
8. **每个拉取请求** 只要改变了设计、实现或退役状态，就同时更新本文件。

## 用语表

| 用 | 指 | 界面上不用 |
| --- | --- | --- |
| Bot | 长期的数字员工 | 员工（「员工浏览器」除外）、Agent |
| 频道 | 有多个 Bot 的对话 | 群聊、群组、Channel |
| 单聊 | 和一个 Bot 的对话 | DM、私聊 |
| 服务电脑 | OpenBot Server | Server、服务器、服务端 |
| 工作电脑 | 运行 Bot 任务的电脑 | Worker、节点（设置分区可继续叫「工作主机」） |
| 任务 | Bot 的一次工作 | Run |
| 例行任务 | 按计划重复的任务 | 自动化、Automation |
| 产出 | 任务生成的文件 | Artifact、产物 |
| 需要你确认 | 等待 Owner 批准的操作 | Approval |
| 工作中 | Bot 或任务正在工作 | 执行中、Running |

## 基础

| 方面 | 取值 |
| --- | --- |
| 颜色 | 正文 `#1d1d1f`，次要 `#6e6e73`，三级 `#8e8e93`；页面 `#fcfcfc`；填充 `#f0f0f2`；悬停 `#e6e6e8`；分隔 `#e3e3e6`；主色 `#111111`；蓝 `#1f6fd6`（仅未读）；绿 `#34c759`（工作中与在线），文字 `#1c7c3c`；危险 `#b3261e`，底 `#fbe9e7`；提醒 `#b5651d`，底 `#fdf0e1`（令牌 `--ob-*`） |
| 字体 | 系统 UI / PingFang SC；正文 15px，说明 13px，元信息 12px，分区标题 13px/500，页面标题 24–28px/700，对话框标题 22px/700 |
| 圆角 | 胶囊按钮 17px（高 34px）或 20px（高 40px，用于对话框），卡片 16–18px，任务卡 18px，气泡 22px，对话框 22px；Bot 头像没有外框，因此没有圆角 |
| 基础组件 | `.ob-pill`（`is-primary`、`is-outline`、`is-danger`、`is-small`）、`.ob-round`、`.ob-switch`（44×26）、`.ob-filter`、`.ob-tag`、`.ob-field`、`.ob-search`、`.ob-card`、`.ob-menu`、`.ob-menu-item`、`.ob-seg`（分段控件） |

## 窗口外壳

- 三栏：侧栏 300px、主区、右栏 340px（1280/1100px 宽时为 264/300、236/264）。
- **没有通栏工具栏。** 侧栏第一行是 macOS 红绿灯（x 20、y 20）和「+」按钮，同在一条 30px 高的行里，
  下面是搜索。
- 主区有自己的 56px 标题行：标题胶囊居中；右侧是「实时」状态和「分享」。
- **点标题胶囊打开右栏**：频道里是「频道信息」（ChannelInfo），单聊里是「Bot 信息」（BotInfo）；右栏的
  「收起」关闭它。
- 后退、前进和两侧栏开关是快捷键与菜单命令（⌘[ ⌘] ⌘B ⌘⇧B）。侧栏隐藏时，标题行给红绿灯留出位置，
  并显示一个重新打开侧栏的按钮。
- 手机布局暂不考虑；窄窗口保持可用，但不做新设计。

## 新建 Bot 与频道

- **「+」打开「新建聊天」**（New）：「收件人」输入框和一个列表。前两行是操作——「创建新 Bot ⌘1」和
  「创建频道 ⌘2」——后面接着列已有 Bot，编号排到 ⌘9。
- **选一个 Bot 是单聊，选多个是频道。** 选中的 Bot 变成标签，列表里只剩其余的；选了多个时出现「命名频道」
  提示，发出第一条消息时建成频道（NewGroup）。
- **「创建新 Bot」立即创建，没有对话框**（NewBotChat）。新 Bot 名叫「新建 Bot」（重名时自动编号），随机选
  一个团队里还没用过的头型和颜色，不绑定电脑，用默认模型；随后打开它的单聊并展开右栏。
- 对话里出现 **「你最想让我先帮你做什么？」**：三个分工选项加一个自由回答。选择后把它设为 Bot 的标签和
  职责，并作为 Owner 的第一条消息发出。上面那句 Bot 自己的开场白，只有后端能生成时才显示（C11）。
- **Bot 信息右栏**：88px 头像带铅笔按钮，名字可以直接改，「添加标签」，然后是「详情 / 资料库 / 电脑」。
  铅笔打开 **「编辑头像」**：头型、下颌色、「随机」和「重置」，改动立即生效（需要 C9）。不做上传和
  AI 生成（所有者 2026-10-02 决定）。
- **给已有频道加 Bot**（AddMember）：「成员」→「添加成员」弹出带「搜索 Bot」的列表，只列还不在频道里的
  Bot；鼠标移到成员上出现浅红色「移除」。

## Bot 头像（v3）

- 三种头型来自所有者的头像方案（`nft_like/03_avatar_svg` v2），96 单位网格：**Round**（天线）、
  **Relay**（耳罩）、**Scout**（猫耳）。保存的头型 round → Round、square → Relay、cat → Scout。v3 把
  Relay 的脸宽从 62 调到 66。
- **下颌色**，八种明度对齐的颜色：绿 `#91CF4B`、蓝 `#5F7CDE`、琥珀 `#DFAD4F`、珊瑚 `#E0785C`、紫
  `#9C7FE3`、青 `#3FB4A6`、粉 `#E57BA8`、灰 `#8C98A8`。后四种需要 C10，在那之前只提供前四种。
- **没有外框。** 任何地方的头像后面都不加底板、描边、边框或背景。
- 尺寸：档案 96，右栏 88，启动 72，侧栏行与成员 40，消息 32，标题胶囊 24，菜单与提及 16–20。32px 以下
  用小尺寸稿：眼睛和天线球加大、猫耳圆钝、去掉耳罩彩条。
- **状态圆点与动作。** 右下角一个带背景色圈的圆点：绿色呼吸 = 工作中，橙色 = 需要你确认，灰圈 = 离线；
  待命不显示。工作中头像还会动：轻轻上下浮动、眼睛左右看，圆顶天线摆动、耳罩灯闪、猫耳抖动。开启「减少
  动态效果」时只留静态圆点。圆点出现在侧栏和 Bot 档案；右栏成员在状态文字旁显示动作。形状和颜色永远
  不随状态变化，颜色也不代表任何含义。
- 已有深色界面版（暖白头），留给以后的深色模式。

## 群组头像

- 频道最多画三个头。**第一位成员在前**，顺序不随状态变化。
- 前面的头沿自己的轮廓挖出约 2px 的背景色缝隙，叠在一起的深色头也分得开。
- 0 个 Bot：灰色方块加 #。1 个：头像加一个小 # 角标，频道永远不会像单聊。2 个：对角叠放，各 66%。
  3 个：两个在后，一个在前。4 个及以上：只画前两个头，加黑色计数圆标（+N）。
- 整个频道一个状态圆点（有成员在工作或在等你），在右下；# 或 +N 角标占了右下时放右上。
- 无障碍名称：「市场周报，3 名 Bot：研究助理、客服小橙、发布助手」。

## 对话里的任务

- **一个任务一张卡，原地更新**（TaskCards）：排队 → 执行中 → 需要你确认 → 完成或失败，结束后收成一行
  摘要。白底、1px `#ececee` 描边、圆角 18，放在 Bot 头像列下方，宽度不超过消息列的 76%。卡片放在
  Bot 关于这个任务的最新一条消息之后，没有则放在发起它的消息之后。Bot 已经回复过的已完成任务不再
  显示卡片：回复本身带着产出和「任务详情」（Main）。被委派的任务显示在主任务卡里。
- 颜色只标状态：绿 = 工作中，橙 = 等你，红 = 失败；完成用中性的黑色对勾。
- 执行中显示服务电脑报告的步数（「已完成 3 步」）和当前步骤，绝不编造总步数；有电脑画面时显示画面，
  另有「补充指令」和「停止」。
- 审批直接在卡上完成；右栏里同一条审批同步更新。
- 失败显示服务电脑给出的用户可读原因；「任务详情」再补充错误代码。服务电脑的原始报错从不显示，
  因为里面可能引用上游的原文。
- **「任务详情」** 是从右侧滑出的 460px 面板（TaskInspector）：状态、电脑画面、分工、进度、任务信息
  （模型和用量），以及「补充指令 / 停止任务」。

## 对话框

- 所有对话框共用一个框架：背后是 `rgba(0,0,0,0.34)` 遮罩，`#fdfdfd` 面板、圆角 22、内边距 30/32/24，
  右上角关闭按钮，22px/700 标题加 14px 说明，操作按钮在右下（灰色「取消」，然后是黑色主按钮或红色危险
  按钮）。
- 已设计：分享、分享 Bot 模板、导入 Bot 模板、删除确认（Bot 与频道）、配对工作电脑、连接模型服务。
  新建 Bot 和新建频道**没有对话框**（见上文）。
- 画板之外的两处安全细节：「分享 Bot 模板」和「导入 Bot 模板」把确切内容放在不显眼的「查看将分享的内容」/
  「查看模板内容」折叠区里；「配对工作电脑」在屏幕上遮住配对令牌，「复制启动配置」复制完整内容。

## 画板与代码对应

**已实现** = 与画板一致；**第 N 步** = 见 [IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md) 的计划。

| 画板 | 实现位置 | 状态 |
| --- | --- | --- |
| Components | `tokens.css`、`primitives.css`、`Dialog.tsx` | 已实现 |
| Sidebar、Search、Menu、ContextMenu | `Sidebar.tsx`、`SidebarItemMenu.tsx` | 已实现（含群组头像与状态圆点） |
| Main | `App.tsx`、`WorkspaceHeader.tsx`、`ChannelWorkspace.tsx`、`TaskCard.tsx` | 已实现 |
| ChannelInfo、AddMember | `ContextRail.tsx`、`AddMemberPopover.tsx` | 已完成 |
| BotInfo | `BotInfoRail.tsx`（单聊和 Bot 档案） | 已完成；编辑头像等 C9 |
| Profile | `EmployeeProfileView.tsx` | 头部与概览已实现；其他分页待设计（第 22 步） |
| New、NewGroup、NewBotChat | `NewChatScreen.tsx`、`NewBotSetupCard.tsx` | 已完成；开场白等 C11 |
| Slash | `ChannelWorkspace.tsx` 输入框菜单 | 已实现 |
| Settings、SettingsNav、Settings* | `DesktopSettingsScreen.tsx`、`Settings*.tsx` | 已实现 |
| Plugins | `PluginsDialog.tsx`、`PluginManagerPanel.tsx` | 已实现 |
| Avatar、Avatars、GroupAvatar、GroupAvatars | `RobotAvatar.tsx`、`GroupAvatar.tsx` | 已实现；紫、青、粉、灰等 C10 |
| Launch、LaunchMotion、Welcome、Install、Connect、Login、ModelSetup、WorkerSetup | `Onboarding.tsx` 与各设置页面 | 已实现 |
| TaskCards、TaskInspector | `TaskCard.tsx`、`TaskSheet.tsx` | 已完成；步数等 C13 |
| Dialog* | `Dialog.tsx` 框架；分享、分享 Bot 模板、导入、删除、配对工作电脑、连接模型服务 | 已完成；连接模型服务在 C17 之前保留列表和编辑区 |
| WorkSupervision、EmptyWorkspace | `WorkTasksScreen.tsx`、新的 `EmptyWorkspace.tsx` | 第 21 步 |

## 尚未设计

这些先在画布上设计（第 22 步）再重做；在那之前保持现有功能。

| 方面 | 现在的代码 |
| --- | --- |
| 消息悬停操作、表情回应、引用回复 | `MessageActionBar`、`MessageReactions` |
| 消息与输入框里的附件、语音输入 | `MessageAttachments`、`AttachmentPreview`、`ComposerAttachmentPicker`、`VoiceRecorder` |
| 「补充指令」输入框与技能选择 | `TaskActions.tsx` 里的 `SteerForm`、输入框技能菜单 |
| 频道文件管理（回收站），并入「资料库」 | `AttachmentsManager` |
| Bot 档案分页：进化档案（受 Hermes Agent 启发）、技能图谱、运行中、记忆、工作记录、配置 | `EmployeeEvolutionArchive`、`EmployeeSkillReview`、`KnowledgeReviewPanel`、`EmployeeModelEditor` |
| 员工浏览器实时画面 | `EmployeeBrowser` |
| 提示、浮动通知、离线横幅 | `App.tsx` 中的提示 |
| 应用图标与 README 图片 | `apps/desktop/resources`、`docs/design/*.png` |

## 旧设计清单

必须消失的旧样式类：`primary-button`、`secondary-button`、`icon-button`、`onboarding-mark`、
`destination-*`、`workspace-toolbar`/`toolbar-*`、`channel-members-*`、`workspace-welcome`。已删除：
`create-dialog`、`dialog-header`、`dialog-backdrop`（第 20 步），`channel-work-item`、`run-inspector`、
`native-run-controls`（第 19 步），`bot-identity-builder`、`appearance-grid`（第 16 步）。

旧样式表：`styles.css` 的大部分、`workspace-shell.css`、`desktop-workspace.css`、`desktop-ui-refresh.css`、
`settings-plugin-refresh.css`、`workspace-preferences.css`、`components/destinations.css`。

第 16 步已删除 `CreateBotDialog` 和 `CreateChannelDialog`；第 17 步删除 `EmployeeProfileRail`；第 19 步删除
`RunInspector`、`RunProgressPanel`、`NativeRunControls` 和 `RunSteering`。计划中退役的界面：独立的「例行任务」和「技能库」页面 `AutomationsScreen`、`SkillLibraryScreen`（由「设置 › 例行任务」和「设置 › 技能」取代）；
以及旧的位图标志 `OpenBotMark`。

已完成：窗口外壳与右栏、启动与首次设置。其余按计划逐步进行，每一步在同一个拉取请求里删除它所替换的旧规则。
