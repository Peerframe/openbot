# OpenBot Desktop design rules

[English](DESIGN.md) · [简体中文](DESIGN.zh-CN.md)

This is the binding design reference for the Desktop and Web clients. The owner's design canvas is
the source; the `.dc.html` snapshot beside this file is its read-only copy (see
[README.md](README.md)). The delivery plan is [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Rules

1. **Every visible element traces to an artboard.** Code reproduces the canvas; it does not invent
   layouts. A screen, dialog, card or state with no artboard is designed on the canvas first and
   approved by the owner, then built.
2. **No legacy look survives.** The earlier interface is retired, not restyled. A component that
   still renders a legacy class (see [Legacy inventory](#legacy-inventory)) is unfinished work, not
   an accepted variant. New code never uses those classes.
3. **One token layer.** Colors, type, radii and spacing come from the `--ob-*` tokens and the
   shared primitives in `apps/web/src/styles.css`. Component CSS lives beside its component.
4. **Data honesty.** A design element whose data or capability does not exist yet is hidden or
   read-only, never faked.
5. **Each pull request updates this file** when it changes what is designed, built or retired.

## Foundations

| Area | Values |
| --- | --- |
| Colors | Text `#1d1d1f`, secondary `#6e6e73`, tertiary `#8e8e93`; page `#fcfcfc`; fill `#f0f0f2`; hover `#e6e6e8`; divider `#e3e3e6`; primary `#111111`; blue `#1f6fd6`; online `#34c759`; danger `#b3261e` (tokens `--ob-*`) |
| Type | System UI / PingFang SC; body 15px, caption 13px, meta 12px, section label 13px/500, page title 24–28px/700 |
| Radii | Pills 17px (34px high), cards 16–18px, bubbles 22px, avatars 12px (square) or 50% (round), dialogs 20–22px |
| Primitives | `.ob-pill` (`is-primary`, `is-outline`, `is-danger`, `is-small`), `.ob-round` (`is-send`, `is-close`), `.ob-switch` (44×26), `.ob-filter`, `.ob-tag`, `.ob-field`, `.ob-search`, `.ob-card`, `.ob-menu`, `.ob-menu-item` |

## Window shell

- Three columns: sidebar 300px, main, rail 340px (264/300 and 236/264 at 1280/1100px).
- **No global toolbar.** The sidebar's top row holds the macOS traffic lights (Desktop places them
  at x 20, y 20) and the 新建 button on one 30px row centred on them. Search follows.
- The main column has its own 56px header: the conversation title pill on the left; 实时 status
  and 分享 on the right.
- **The title pill opens the right rail** (频道信息 / Bot 信息), as in the Main artboard; the
  rail's 收起 closes it. Members are added and removed in the rail, not in a popover.
- Back, forward and the panel toggles are keyboard and menu commands (⌘[ ⌘] ⌘B ⌘⇧B), not
  toolbar buttons. When the sidebar is hidden, the main header leaves room for the traffic lights
  and shows one button to reopen it.

## Screen map

| Artboard | Built in |
| --- | --- |
| Sidebar, Search, Menu, ContextMenu | `Sidebar.tsx`, `SidebarItemMenu.tsx` |
| Main | `App.tsx` (shell header), `ChannelWorkspace.tsx`, `ChannelMessagePresentation.css`, `ContextRail.tsx` |
| Profile | `EmployeeProfileView.tsx`, `EmployeeProfileRail.tsx` |
| New | `NewChatScreen.tsx` |
| Slash | `ChannelWorkspace.tsx` (composer menus) |
| Settings, SettingsNav, Settings* | `DesktopSettingsScreen.tsx`, `Settings*.tsx`, `SettingsDialog.css` |
| Plugins | `PluginsDialog.tsx`, `PluginManagerPanel.tsx` (catalog variant) |
| Components | `styles.css` tokens and primitives |

## Not designed yet

These need artboards before they are rebuilt; until then they keep their current behaviour.

| Area | Code today | Note |
| --- | --- | --- |
| Launch, login and first-run setup, with the opening animation | `DesktopInstallScreen`, `LoginScreen`, `DesktopSetupScreen`, `DesktopConnectionScreen`, `DesktopLocalWorkerScreen`, `ModelSettingsScreen` (onboarding) | Owner is redesigning |
| Bot avatars | `RobotAvatar` | Owner supplies the earlier avatar design |
| Task cards, collaboration and failures in a conversation; task inspector | `NativeRunControls`, `RunCollaboration`, `RunInspector` | |
| Dialogs: create Bot, create channel, share, delete, import/export, host pairing, model connections | `CreateBotDialog`, `CreateChannelDialog`, `ShareConversationDialog`, `DeleteIdentityDialog`, `Import/ExportEmployeeDialog`, `NodeManagerDialog`, `ModelConnectionsDialog` | |
| 任务监督 (work supervision) | `WorkTasksScreen` | |
| Phone layout | `MobileNavigation` | |
| Profile tab contents (evolution, skill graph, memory, records) | `EmployeeEvolutionArchive`, `EmployeeSkillReview`, `KnowledgeReviewPanel` | |

## Legacy inventory

Legacy classes that must disappear: `primary-button`, `secondary-button`, `icon-button`,
`create-dialog`, `dialog-header`, `dialog-backdrop`, `login-card`, `onboarding-mark`,
`loading-screen`, `destination-*`, `workspace-toolbar`/`toolbar-*`, `channel-members-*`,
`usage-rail-*`. Legacy stylesheets: most of `styles.css`, `workspace-shell.css`,
`desktop-workspace.css`, `workspace-preferences.css`, `components/destinations.css`.

Retirement order: (1) window shell and channel rail; (2) conversation task cards; (3) dialogs;
(4) launch, login and setup with the new avatars; (5) 任务监督 and phone layout; (6) delete the
legacy stylesheets and classes. Each step removes the legacy rules it replaces in the same pull
request.
