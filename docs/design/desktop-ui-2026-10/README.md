# Desktop UI design contract (2026-10)

[English](README.md) · [简体中文](README.zh-CN.md)

The repository owner approved this design on 2026-10-01 as **the** UI contract for the Desktop and
Web clients. It replaces the earlier restyle-only direction: every screen is rebuilt to these
artboards, one step at a time. The editable source is the owner's private design canvas; the
`.dc.html` files here are a read-only snapshot of it (markup and inline styles, taken 2026-10-01)
so that every contributor, including Codex, works from the same measurements.

The files are Design Component pages. They need the canvas runtime to render, but their inline
styles, texts and structure are the specification. Nine provider logos in `Settings.dc.html` are
canvas uploads (`/_blob/…`); the product uses the MIT-licensed `@lobehub/icons-static-svg`
equivalents. Bracketed values such as `[128]` and `[版本号]` are placeholders, not product data.

| Artboard | Screen |
| --- | --- |
| [Components](Components.dc.html) | Tokens: colors, type scale, radii, buttons, chips, inputs, rows, bubbles, menus |
| [Sidebar](Sidebar.dc.html) | Shared sidebar: search, groups, rows, account menu, footer |
| [Main](Main.dc.html) | ① Channel conversation with right rail |
| [Profile](Profile.dc.html) | ② Bot profile with settings rail |
| [New](New.dc.html) | ③ New chat / choose Bots |
| [Settings](Settings.dc.html) and `Settings*.dc.html`, [SettingsNav](SettingsNav.dc.html) | ④ Settings dialog and its 14 sections |
| [Plugins](Plugins.dc.html) | ⑥ Plugins |
| [Menu](Menu.dc.html) | ⑦ Account menu |
| [ContextMenu](ContextMenu.dc.html) | ⑧ Bot and channel context menus |
| [Search](Search.dc.html) | ⑨ Groups and search |
| [Slash](Slash.dc.html) | ⑩ `/` skills and actions |
| [Avatars](Avatars.dc.html), [Avatar](Avatar.dc.html) | ⑪ Bot avatar system (three heads × four jaw colours, frameless) and its component |
| [ChannelInfo](ChannelInfo.dc.html) | 频道信息 rail with 详情 / 资料库 / 成员 tabs (imported by Main) |
| [Launch](Launch.dc.html), [LaunchMotion](LaunchMotion.dc.html) | Opening screen states and the 900 ms opening animation |
| [Welcome](Welcome.dc.html), [Install](Install.dc.html), [Connect](Connect.dc.html), [Login](Login.dc.html), [ModelSetup](ModelSetup.dc.html), [WorkerSetup](WorkerSetup.dc.html) | First-run setup: choose a role, prepare this computer, connect, sign in, choose a model, enable this computer as a worker |

The binding rules, the screen map, what is not designed yet and the legacy inventory are in
[DESIGN.md](DESIGN.md).

Changing the design means changing the canvas first and refreshing this snapshot in the same pull
request. The delivery plan and the division of work are in
[IMPLEMENTATION.md](IMPLEMENTATION.md).
