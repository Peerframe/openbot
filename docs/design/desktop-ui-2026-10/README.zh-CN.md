# Desktop 界面设计契约（2026-10）

[English](README.md) · [简体中文](README.zh-CN.md)

仓库所有者于 2026-10-01 确认本设计为 Desktop 与 Web 客户端**唯一**的界面契约，取代之前“只换样式”的
做法：每个界面都按这些画板逐步重建。可编辑的源文件是所有者的私有设计画布；这里的 `.dc.html` 是
2026-10-01 的只读快照（标记与内联样式），让包括 Codex 在内的所有协作者按同一套尺寸工作。

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

修改设计时先改画布，并在同一个拉取请求中刷新这份快照。交付计划与分工见
[IMPLEMENTATION.zh-CN.md](IMPLEMENTATION.zh-CN.md)。
