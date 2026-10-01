# Desktop 界面设计契约（2026-10）

[English](README.md) · [简体中文](README.zh-CN.md)

仓库所有者于 2026-10-01 确认本设计为 Desktop 与 Web 客户端**唯一**的界面契约，取代之前“只换样式”的
做法：每个界面都按这些画板逐步重建。可编辑的源文件是所有者的私有设计画布；这里的 `.dc.html` 是
只读快照（标记与内联样式，最近更新于 2026-10-02），让包括 Codex 在内的所有协作者按同一套尺寸工作。

这些文件是 Design Component 页面，需要画布运行时才能渲染，但其中的内联样式、文字和结构就是规格。
`Settings.dc.html` 里的 9 个服务商标志是画布上传的图片（`/_blob/…`），产品中使用 MIT 许可的
`@lobehub/icons-static-svg` 对应图标。`[128]`、`[版本号]` 这类方括号内容是占位，不是产品数据。

| 画板 | 界面 |
| --- | --- |
| [Components](Components.dc.html) | 规范：颜色、字号、圆角、按钮、标签、输入框、列表行、气泡、菜单 |
| [Sidebar](Sidebar.dc.html) | 共享侧栏：搜索、分组、列表行、账户菜单、底部 |
| [Main](Main.dc.html) | ① 频道对话与右侧栏 |
| [Profile](Profile.dc.html) | ② Bot 档案与设置栏 |
| [New](New.dc.html) | ③ 新建聊天 / 选择 Bot |
| [Settings](Settings.dc.html) 与 `Settings*.dc.html`、[SettingsNav](SettingsNav.dc.html) | ④ 设置弹窗及其 14 个分区 |
| [Plugins](Plugins.dc.html) | ⑥ 插件 |
| [Menu](Menu.dc.html) | ⑦ 账户菜单 |
| [ContextMenu](ContextMenu.dc.html) | ⑧ Bot 与频道右键菜单 |
| [Search](Search.dc.html) | ⑨ 分组与搜索 |
| [Slash](Slash.dc.html) | ⑩ `/` 技能与操作 |
| [Avatars](Avatars.dc.html)、[Avatar](Avatar.dc.html) | ⑪ Bot 头像系统 v3（三种头型 × 八种下颌色 × 五种额饰，无外框）及其组件 |
| [GroupAvatars](GroupAvatars.dc.html)、[GroupAvatar](GroupAvatar.dc.html) | ⑪ 0、1、2、3、4 个及以上 Bot 的群组头像（沿轮廓挖缝）及其组件 |
| [BotInfo](BotInfo.dc.html) | 「Bot 信息」右栏与「编辑头像」弹窗（组件） |
| [NewGroup](NewGroup.dc.html)、[NewBotChat](NewBotChat.dc.html) | ③ 从收件人创建频道；创建新 Bot——随机生成后直接进入单聊 |
| [AddMember](AddMember.dc.html) | ① 给已有频道添加 Bot |
| [TaskCards](TaskCards.dc.html)、[TaskInspector](TaskInspector.dc.html) | ⑭ 对话里的任务卡（全部状态）与「任务详情」面板 |
| [WorkSupervision](WorkSupervision.dc.html) | ⑯ 任务监督 |
| [EmptyWorkspace](EmptyWorkspace.dc.html) | ⑰ 还没有任何对话时的首次进入 |
| [DialogShare](DialogShare.dc.html)、[DialogExport](DialogExport.dc.html)、[DialogImport](DialogImport.dc.html)、[DialogDelete](DialogDelete.dc.html)、[DialogPairHost](DialogPairHost.dc.html)、[DialogModel](DialogModel.dc.html) | ⑮ 对话框：分享、分享 Bot 模板、导入 Bot 模板、删除确认、配对工作电脑、连接模型服务 |
| [ChannelInfo](ChannelInfo.dc.html) | 「频道信息」右栏，含 详情 / 资料库 / 成员 分页（由 Main 引用） |
| [Launch](Launch.dc.html)、[LaunchMotion](LaunchMotion.dc.html) | 启动画面的各状态与 900 毫秒开场动画 |
| [Welcome](Welcome.dc.html)、[Install](Install.dc.html)、[Connect](Connect.dc.html)、[Login](Login.dc.html)、[ModelSetup](ModelSetup.dc.html)、[WorkerSetup](WorkerSetup.dc.html) | 首次设置：选择用法、准备这台电脑、连接、登录、选择模型、把这台电脑设为工作电脑 |

修改设计时先改画布，并在同一个拉取请求中刷新这份快照。交付计划与分工见
[IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md)。

必须遵守的规则、画板与代码的对应、尚未设计的部分以及旧设计清单见 [DESIGN.zh-CN.md](DESIGN.zh-CN.md)。
