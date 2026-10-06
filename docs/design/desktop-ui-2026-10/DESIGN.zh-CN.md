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
| 缩放 | 画板按 1440×900 绘制。桌面版默认打开 1200×780 的窗口，并把界面缩放到 90%（2026-10-03 按你的反馈调整）；「视图 › 实际大小 / 放大 / 缩小」可以改，红绿灯位置按 90% 的布局摆放 |
| 动效（`motion.css`） | 节奏参照你提供的参考录屏：快而轻。按下和悬停：颜色在 100ms 内过渡，胶囊按钮按下时缩到 97%。对话框打开时 140ms 内淡入并上移 4px，关闭时淡出，背景遮罩同步。菜单和 @、/ 列表从锚点处 100ms 内展开。侧栏和右栏开合时滑动（160ms），内容保持完整宽度。**对话区参照 Telegram：** 对话打开期间新到的消息从各自一侧浮起（180ms；历史和往前加载的消息不动）；切换对话或页面时新内容淡入（120ms）；「回到最新」和点引用跳转都平滑滚动，跳到的那条消息闪一下高亮；悬停操作栏淡入；输入框高度平滑变化。系统设置了减少动态效果，或打开「通用 › 减少动态效果」时，以上全部关闭 |
| 外观 | 「通用 › 主题」：跟随系统（默认）、浅色或深色。深色把每个颜色 token 换成深色值（DarkTokens 画板），布局、字号、圆角和动效不变；主色反转（白底黑字）；头像用暖白版并换亮一档的下颌色。浅色保持原有颜色不变：零散的旧颜色写成 `light-dark(<浅色>, var(<token>))`，只在深色时换成 token。桌面应用由主进程保存选择，并设置窗口底色和侧栏材质（C25），页面跟随它的 `prefers-color-scheme` |
| 滚动条 | 没有轨道；区域滚动时出现 6px 的滑块，停下 1 秒后淡出，鼠标移上去变成 10px（LongLists）。由一个全局监听给正在滚动的元素加标记（`overlay-scrollbars.ts`） |

## 窗口外壳

- 三栏：侧栏 300px、主区、右栏 340px（1280/1100px 宽时为 264/300、236/264）。
- **没有通栏工具栏。** 侧栏第一行是 macOS 红绿灯（x 20、y 20）和「+」按钮，同在一条 30px 高的行里，
  下面是搜索。
- 主区有自己的 56px 标题行：标题胶囊居中；右侧是「实时」状态和「分享」。
- 输入框是一行 44px（「+」和发送按钮 34px），接近参考聊天应用的密度（2026-10-03 按你的反馈调整）。它离窗口底边
  18px，和侧栏底部那一行（「我」「插件」，按钮同为 44px）在同一条线上（2026-10-05 按你的反馈调整）。新建聊天的输入框
  用同样的一行。
- 新建聊天页没有标题胶囊，页面最上方就是收件人一栏（2026-10-03 按你的反馈调整）。
- 侧栏的「插件」按钮在文字后面显示最多三个已启用插件的小方块（Sidebar 画板）。
- **真实图标**（所有者 2026-10-05 要求）：模型服务商和常见插件服务（Gmail、Google Drive、Google 日历、GitHub、
  Slack、Notion、Linear、Discord、Figma、X）在原来显示首字母的地方都换成真实图标：「设置 › 模型服务」、模型
  对话框、插件面板和设置、@ 列表、侧栏。单色图标跟随文字颜色；其他服务仍显示首字母。来源见
  [调研记录](../../research/brand-logos.zh-CN.md)。
- 「设置 › 模型服务」里每个服务商只出现一次（作为连接）。下面旧版的单一设置「语音转写与旧版 Bot 的模型」只用一个
  精简的下拉选择，并说明为什么要单独设置（所有者 2026-10-05 反馈）；C28 完成后它会去掉。
- **点标题胶囊打开右栏**：频道里是「频道信息」（ChannelInfo），单聊里是「Bot 信息」（BotInfo）；右栏的
  「收起」关闭它。
- 后退、前进和两侧栏开关是快捷键与菜单命令（⌘[ ⌘] ⌘B ⌘⇧B）。侧栏隐藏时，标题行给红绿灯留出位置，
  并显示一个重新打开侧栏的按钮。
- 不做手机布局（所有者 2026-10-03 决定）。窗口宽到 800px 都保持桌面布局，再窄就横向滚动。

## 像跟下属交流一样设置 Bot（计划中，C29）

- 所有者 2026-10-06 决定：参照 Grok Bot，但有限制。你用大白话说要什么，Bot 自己改名字、标签、介绍、记忆、
  例行任务、你教它的技能，以及开始用已安装的插件，然后告诉你它做了什么（ChatSetup 画板）。
- 每项改动是居中的一行，例如「已重命名为 v7 · 撤销」「记下了 B 公司定价页需要登录（来自 b.com）· 撤销」，并记入审计。
- 只有来自外部（比如网页）的长期指令会先用一张卡片问你。
- 工作电脑、凭证、审批规则、连接新插件和别的 Bot 永远不在聊天里改，Bot 会告诉你去哪里改。
- 约定见[调研记录](../../research/chat-driven-bot-setup.zh-CN.md)。

## 新建 Bot 与频道

- **「+」打开「新建聊天」**（New）：「收件人」输入框和一个下拉列表。前两行是操作——「创建新 Bot ⌘1」和
  「创建频道 ⌘2」——后面接着列已有 Bot，编号排到 ⌘9。
- 列表按所有者的参考录屏（2026-10-03）：从输入框左边缘垂下，宽 460px，每行 36px，含 22px 头像、名字和
  分工标签。快捷键只在高亮的那一行显示，但每一行都能用。点列表以外的地方会收起，再点输入框重新打开。
- **选一个 Bot 是单聊，选多个是频道。** 选中的 Bot 变成标签，列表里只剩其余的；选了多个时出现「命名频道」
  提示，发出第一条消息时建成频道（NewGroup）。
- **「创建新 Bot」立即创建，没有对话框**（NewBotChat）。新 Bot 名叫「新建 Bot」（重名时自动编号），随机选
  一个团队里还没用过的头型和颜色，不绑定电脑，用默认模型；随后打开它的单聊并展开右栏。
- 对话里出现 **「你最想让我先帮你做什么？」**：三个分工选项加一个自由回答。选择后把它设为 Bot 的标签和
  职责，并作为 Owner 的第一条消息发出。配置了模型时，卡片上方会有一句 Bot 自己的开场白（C11），
  在 Owner 发言之前卡片一直保留。
- **Bot 信息右栏**：88px 头像带铅笔按钮，名字可以直接改，「添加标签」，然后是「详情 / 资料库 / 电脑」。
  铅笔打开 **「编辑头像」**：头型、下颌色、「随机」和「重置」（回到打开时的样子）。每次改动立即按档案版本
  保存（C9），这个 Bot 的所有头像同步更新；如果别处先改过，会重新读取档案。不做上传和 AI 生成（所有者
  2026-10-02 决定）。
- **给已有频道加 Bot**（AddMember）：「成员」→「添加成员」弹出带「搜索 Bot」的列表，只列还不在频道里的
  Bot；鼠标移到成员上出现浅红色「移除」。

## Bot 头像（v3）

- 三种头型来自所有者的头像方案（`nft_like/03_avatar_svg` v2），96 单位网格：**Round**（天线）、
  **Relay**（耳罩）、**Scout**（猫耳）。保存的头型 round → Round、square → Relay、cat → Scout。v3 把
  Relay 的脸宽从 62 调到 66。
- **下颌色**，八种明度对齐的颜色：绿 `#91CF4B`、蓝 `#5F7CDE`、琥珀 `#DFAD4F`、珊瑚 `#E0785C`、紫
  `#9C7FE3`、青 `#3FB4A6`、粉 `#E57BA8`、灰 `#8C98A8`。服务电脑接受全部八种（C10）；一键新建的 Bot 从八种里挑。
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

## 对话（所有者 2026-10-05 反馈）

来自你的第二段参考录屏，排版参照 Telegram。

- **同一个 Bot 连续的几条消息**：第一条上方写名字，用这个 Bot 的下颌色（浅色模式下加深以保证对比度）；头像放在
  最后一条的下方。
- **Bot 名字显示成标签**：消息里提到频道里的 Bot 时，显示成小头像加彩色名字。你在频道里发的消息，开头是它发给了
  哪些 Bot 的标签。输入框里选中的 Bot 也是同样的标签，放在这一行开头，鼠标移上去才显示 ×。
- **「XX 正在工作…」**：某个 Bot 正在处理这里的任务、还没开始写回复时，对话末尾有一行轻提示，带它会动的头像
  （文字有微光，减少动态效果时关闭）。如果这个任务自己的卡片已经是对话最后一项，就不再显示这一行。
- **单聊**里不在消息上方重复 Bot 的名字，标题已经写明。
- **「新」**：标出第一条没看过的回复——打开频道时它的未读回复，或者窗口不在前台时新到的第一条。离开对话前一直保留。
- **链接**：消息里只有不带账号密码的 https 链接可以点开，前面有地球图标，在新标签页打开、不带来源信息。桌面应用先
  显示但不能点，等主进程能安全打开（C27）。
- **输入框为空时**只显示麦克风；输入第一个字后出现发送按钮。
- **你的气泡**：浅色是黑底白字，深色是深灰（`#3a3a3c`）（所有者 2026-10-05 决定）。
- **任务监督**按画板：一个「附件」栏，显示数量、「刷新附件列表」和「添加附件」按钮（不露出系统文件选择框）；文件行
  只写简短的类型和大小；所有额外权限收进「更多权限（默认不授权）」。

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
| BotInfo | `BotInfoRail.tsx`、`AvatarEditor.tsx`（单聊和 Bot 档案） | 已完成 |
| Profile、ProfileEvolution、ProfileSkills、ProfileMemory、ProfileWork、ProfileConfig | `EmployeeProfileView.tsx` 及其分页 | 已完成（23a） |
| New、NewGroup、NewBotChat | `NewChatScreen.tsx`、`NewBotSetupCard.tsx` | 已完成 |
| Slash | `ChannelWorkspace.tsx` 输入框菜单 | 已实现。@ 和 / 列表在光标处弹出。@ 列出 Bot 和已启用的插件，每项一行，右侧标明类型；插件标明「已连接」或「需要授权」。选择已连接的插件会写入「@名称」提示 Bot 使用；选择未授权的插件会打开插件面板，所以 @ 不会授予任何权限。点其他地方或打开 @、/ 时，「+」菜单会自动收起 |
| Settings、SettingsNav、Settings* | `DesktopSettingsScreen.tsx`、`Settings*.tsx` | 已实现 |
| Plugins | `PluginsDialog.tsx`、`PluginManagerPanel.tsx` | 已实现 |
| Avatar、Avatars、GroupAvatar、GroupAvatars | `RobotAvatar.tsx`、`GroupAvatar.tsx` | 已实现；八种颜色 |
| Launch、LaunchMotion、Welcome、Install、Connect、Login、ModelSetup、WorkerSetup | `Onboarding.tsx` 与各设置页面 | 已实现 |
| TaskCards、TaskInspector | `TaskCard.tsx`、`TaskSheet.tsx` | 已完成；任务卡显示服务电脑报告的步数（C13） |
| Dialog* | `Dialog.tsx` 框架；分享、分享 Bot 模板、导入、删除、配对工作电脑、连接模型服务 | 已完成；连接模型服务一次编辑一个连接：免费读取模型列表、默认模型、断开（C17） |
| WorkSupervision、EmptyWorkspace | `WorkTasksScreen.tsx`、`EmptyWorkspace.tsx` | 已完成；任务监督按最新的 Work 动作显示当前步骤 |
| ChannelFilesTrash、SettingsStorage | `AttachmentsManager.tsx`、`MessageAttachments.tsx`、`SettingsStorage.tsx`、`SettingsBrowser.tsx` | 已完成（C21–C24）。存储空间可以一次「清空回收站…」；需要时按 Bot 测量浏览器数据（不计入服务电脑总量，量不出时显示「量不出」）；「查看引用 ›」列出引用文件的消息和任务 |

## 第 22 步设计，第 23 步实现

这些方面在第 22 步设计（2026-10-02 已通过），在第 23a–23f 步重做。[LongLists](LongLists.dc.html) 规定了所有地方
内容多时怎么办：计数写在标题后，每张卡最多放 4 条并接「全部 N 个 ›」，超过 20 条加搜索，滚动时才出现的悬浮滚动条，
对话里的日期浮标和「回到最新」。

| 方面与画板 | 实现位置 | 状态 |
| --- | --- | --- |
| 消息悬停操作、表情回应、引用回复（MessageActions） | `MessageActionBar`、`MessageReactions` | 已完成（23b） |
| 消息与输入框里的附件、语音输入（Composer） | `MessageAttachments`、`AttachmentPreview`、`ComposerAttachmentPicker`、`VoiceRecorder` | 已完成（23b） |
| 「补充指令」输入框与技能选择（Composer、TaskCards） | `TaskActions.tsx` 里的 `SteerForm`、输入框技能菜单 | 已完成（23b） |
| 带回收站的频道文件（ChannelFiles） | `AttachmentsManager` | 已完成（23c，C19–C24） |
| Bot 档案分页：进化档案（受 Hermes Agent 启发）、技能、记忆、工作记录（含进行中）、配置（Profile*） | `EmployeeEvolutionArchive`、`EmployeeSkillReview`、`KnowledgeReviewPanel`、`EmployeeModelEditor` | 已完成（23a） |
| Bot 的浏览器（EmployeeBrowser） | `EmployeeBrowser` | 已完成（23d） |
| 提示、浮动通知、横条、滚动与长列表（Notices、LongLists） | `App.tsx` 中的提示、`useListScroll`、`ApprovalStack`、`SettingsSearch` | 已完成（23e、23e-2） |
| 应用图标（AppIcon） | `AppIcon`、标签页图标、`docs/design/app-icon` | 已完成（23f，C16） |

## 旧设计清单

现在没有组件再使用旧样式类。第 23f 步退役了最后几个：`primary-button` 和 `secondary-button`（33 个按钮改用
`ob-pill`）、`icon-button`、`onboarding-mark`，以及例行任务表单的 `destination-*`。更早的步骤删除了
`workspace-welcome` 和大部分 `destination-*`（第 21 步），`create-dialog`、`dialog-header`、`dialog-backdrop`（第 20 步），
`channel-work-item`、`run-inspector`、`native-run-controls`（第 19 步），`bot-identity-builder`、`appearance-grid`（第 16 步）。

旧样式表：第 23f 步在 65 个设计预览状态里逐条测量了剩下的旧规则，删除了没有作用或被完全覆盖的规则（约 120 条），
也删除了 `components/destinations.css`。第 27 步又退役了 7 个旧样式表（`styles.css`、`workspace-shell.css`、
`workspace-preferences.css`、`desktop-workspace.css`、`conversation-feedback.css`、`desktop-ui-refresh.css`、
`settings-plugin-refresh.css`）。
- 只被一个组件用到的规则，搬进了那个组件的样式表，放在它自己的规则前面。新增了 7 个组件样式表：
  `ApprovalCard`、`ArtifactCard`、`MobileNavigation`、`NodeManagerDialog`、`PortableEmployeeReview`、
  `RichMessage`、`SettingsSections`。
- 元素样式和多个组件共用的规则（包括 `App.tsx` 自己的外壳布局）放进两个全局文件：`base.css` 在
  `primitives.css` 之前加载，`shell.css` 在它之后加载，原来的先后顺序保持不变。
- 删掉了一条已经不起作用的规则。
- 在 68 个设计预览状态里做了计算样式扫描，搬之前和搬之后一致；差别只有时钟文字的宽度，以及已知的设置窗口
  居中外边距波动。

已删除：`CreateBotDialog`、`CreateChannelDialog`（第 16 步）；`EmployeeProfileRail`（第 17 步）；
`RunInspector`、`RunProgressPanel`、`NativeRunControls`、`RunSteering`（第 19 步）；独立的「例行任务」和
「技能库」页面以及旧的欢迎页（第 21 步）；位图标志 `OpenBotMark`，换成矢量的 `AppIcon`（第 23f 步）。

已完成：窗口外壳与右栏、启动与首次设置，以及第 14–23 步。其余按计划逐步进行，每一步在同一个拉取请求里删除它所替换的旧规则。
