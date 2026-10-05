# Desktop 界面设计契约（2026-10）

[English](README.md) · [简体中文](README.zh-CN.md)

仓库所有者于 2026-10-01 确认本设计为 Desktop 与 Web 客户端**唯一**的界面契约，取代之前“只换样式”的
做法：每个界面都按这些画板逐步重建。可编辑的源文件是所有者的私有设计画布；这里的 `.dc.html` 是
只读快照（标记与内联样式，最近更新于 2026-10-03），让包括 Codex 在内的所有协作者按同一套尺寸工作。

这些文件是 Design Component 页面，需要画布运行时才能渲染，但其中的内联样式、文字和结构就是规格。
`Settings.dc.html` 里的 9 个服务商标志是画布上传的图片（`/_blob/…`），产品中使用 MIT 许可的
`@lobehub/icons-static-svg` 对应图标。`[128]`、`[版本号]` 这类方括号内容是占位，不是产品数据。

| 画板 | 界面 |
| --- | --- |
| [Components](Components.dc.html) | 规范：颜色、字号、圆角、按钮、标签、输入框、列表行、气泡、菜单 |
| [Sidebar](Sidebar.dc.html) | 共享侧栏：搜索、分组、列表行、账户菜单、底部 |
| [Main](Main.dc.html) | ① 频道对话与右侧栏 |
| [Profile](Profile.dc.html) 与 [ProfileEvolution](ProfileEvolution.dc.html)、[ProfileSkills](ProfileSkills.dc.html)、[ProfileMemory](ProfileMemory.dc.html)、[ProfileWork](ProfileWork.dc.html)、[ProfileConfig](ProfileConfig.dc.html) | ② Bot 档案：概览和另外五个分页（分段控件切换） |
| [New](New.dc.html) | ③ 新建聊天 / 选择 Bot |
| [Settings](Settings.dc.html) 与 `Settings*.dc.html`、[SettingsNav](SettingsNav.dc.html) | ④ 设置弹窗及其 14 个分区 |
| [Plugins](Plugins.dc.html) | ⑥ 插件 |
| [Menu](Menu.dc.html) | ⑦ 账户菜单 |
| [ContextMenu](ContextMenu.dc.html) | ⑧ Bot 与频道右键菜单 |
| [Search](Search.dc.html) | ⑨ 分组与搜索 |
| [Slash](Slash.dc.html) | ⑩ `/` 技能与操作 |
| [Avatars](Avatars.dc.html)、[Avatar](Avatar.dc.html) | ⑪ Bot 头像系统 v3（三种头型 × 八种下颌色，无外框，状态圆点与工作动画）及其组件 |
| [GroupAvatars](GroupAvatars.dc.html)、[GroupAvatar](GroupAvatar.dc.html) | ⑪ 0、1、2、3、4 个及以上 Bot 的群组头像（沿轮廓挖缝）及其组件 |
| [BotInfo](BotInfo.dc.html) | 「Bot 信息」右栏与「编辑头像」弹窗（组件） |
| [NewGroup](NewGroup.dc.html)、[NewBotChat](NewBotChat.dc.html) | ③ 从收件人创建频道；创建新 Bot——随机生成后直接进入单聊 |
| [AddMember](AddMember.dc.html) | ① 给已有频道添加 Bot |
| [TaskCards](TaskCards.dc.html)、[TaskInspector](TaskInspector.dc.html) | ⑭ 对话里的任务卡（全部状态）与「任务详情」面板 |
| [WorkSupervision](WorkSupervision.dc.html) | ⑯ 任务监督 |
| [EmptyWorkspace](EmptyWorkspace.dc.html) | ⑰ 还没有任何对话时的首次进入 |
| [DialogShare](DialogShare.dc.html)、[DialogExport](DialogExport.dc.html)、[DialogImport](DialogImport.dc.html)、[DialogDelete](DialogDelete.dc.html)、[DialogPairHost](DialogPairHost.dc.html)、[DialogModel](DialogModel.dc.html) | ⑮ 对话框：分享、分享 Bot 模板、导入 Bot 模板、删除确认、配对工作电脑、连接模型服务 |
| [MessageActions](MessageActions.dc.html)、[Composer](Composer.dc.html)、[ChannelFiles](ChannelFiles.dc.html) | ① 消息操作与回应；输入框的附件、语音和补充指令；带回收站的频道文件 |
| [ChannelFilesTrash](ChannelFilesTrash.dc.html)、[SettingsStorage](SettingsStorage.dc.html) | ① 从回收站永久删除（再确认一次）和文件删除后的占位；④ 设置 › 存储空间 |
| [EmployeeBrowser](EmployeeBrowser.dc.html) | Bot 的浏览器：接管与交还 |
| [DarkTokens](DarkTokens.dc.html)、[MainDark](MainDark.dc.html)、[NewDark](NewDark.dc.html)、[SettingsGeneralDark](SettingsGeneralDark.dc.html)，以及组件 [SidebarDark](SidebarDark.dc.html)、[ChannelInfoDark](ChannelInfoDark.dc.html)、[SettingsNavDark](SettingsNavDark.dc.html) | 深色外观：每个颜色 token 的浅色值与深色值，以及三个深色画面 |
| [PrimaryBot](PrimaryBot.dc.html) | 主 Bot：方案一（2026-10-05 选定），侧栏第一行，头像和名字后都有王冠，以及王冠的专属动画 |
| [ReviewProfile](ReviewProfile.dc.html)、[ProfileRailClosed](ProfileRailClosed.dc.html) | 体验检查：Bot 档案重复显示 Bot 身份的位置，以及收起右栏的另一种做法（未采用，右栏保留） |
| [Notices](Notices.dc.html)、[LongLists](LongLists.dc.html)、[AppIcon](AppIcon.dc.html) | 提示与连接状态；所有界面的长列表与滚动；应用图标 |
| [ChannelInfo](ChannelInfo.dc.html) | 「频道信息」右栏，含 详情 / 资料库 / 成员 分页（由 Main 引用） |
| [Launch](Launch.dc.html)、[LaunchMotion](LaunchMotion.dc.html) | 启动画面的各状态与 900 毫秒开场动画 |
| [Welcome](Welcome.dc.html)、[Install](Install.dc.html)、[Connect](Connect.dc.html)、[Login](Login.dc.html)、[ModelSetup](ModelSetup.dc.html)、[WorkerSetup](WorkerSetup.dc.html) | 首次设置：选择用法、准备这台电脑、连接、登录、选择模型、把这台电脑设为工作电脑 |

修改设计时先改画布，并在同一个拉取请求中刷新这份快照。交付计划与分工见
[IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md)。

必须遵守的规则、画板与代码的对应、尚未设计的部分以及旧设计清单见 [DESIGN.zh-CN.md](DESIGN.zh-CN.md)。
