# Desktop UI implementation plan

[English](IMPLEMENTATION.md) · [简体中文](IMPLEMENTATION.zh-CN.md)

Goal: every screen matches the [approved artboards](README.md). The owner decided on 2026-10-01
that the UI follows this design only; earlier restyle work is not a reference. Work proceeds one
step at a time, each step one pull request with a rendered comparison against its artboard.

## Division of work

One implementer per file scope (root `AGENTS.md`). Cross-scope needs go through the backlog below.

| Owner | Scope |
| --- | --- |
| Claude | UI: `apps/web/src/**` (components, styles, the Web API client `api.ts`), UI tests, `docs/design/**` |
| Codex | Server and platform: `apps/server-python/**`, `packages/db/**`, `packages/protocol/**`, `packages/domain/**`, `apps/desktop/src/**` (main process and preload), CI and scripts |

A backend item is ready for UI when its route or bridge method, domain/protocol types and tests are
merged and documented in `docs/API.md`. Until then the UI shows the design without the missing
data (hidden, disabled or read-only) and never fakes it.

## UI steps (Claude)

| # | Step | Artboards | Status |
| --- | --- | --- | --- |
| 0 | Design tokens and shared primitives (colors, type, radii, pill buttons, chips, inputs, switches, menus) as one token layer | Components | In review: PR #109 (`--ob-*` tokens and `.ob-*` primitives in `styles.css`) |
| 1 | Channel conversation, title pill, composer, right rail | Main | In review: PR #109 |
| 2 | Shared sidebar, account menu, context menus, groups and search | Sidebar, Menu, ContextMenu, Search | In review (stacked on PR #109) |
| 3 | `/` menu: skill descriptions and the design's actions (members, new routine, settings sections) | Slash | In review (stacked) |
| 4 | New chat: recipient chips, Bot picker with ⌘1–9, channel created on first message | New | Planned |
| 5 | Bot profile: header, pill tabs, stats card, recent evolution/work, skills; settings rail (name, tag, description, notifications, runtime) | Profile | Planned |
| 6 | Settings dialog shell and grouped navigation with counts | Settings, SettingsNav | Planned |
| 7 | Settings sections with existing data: 模型服务, 技能, 插件, 例行任务, 记忆, 工作主机, 导入与导出, 审计记录 | Settings* | Planned |
| 8 | Settings sections needing backlog items: 通用, 通知, 账户与安全, 审批与权限, 员工浏览器, 关于 | Settings* | After C2–C6 |
| 9 | Plugins page with the curated catalog | Plugins | Planned (catalog after C8) |

## Backend and platform backlog (Codex)

| ID | Needed by | Contract to add | UI until ready |
| --- | --- | --- | --- |
| C1 | Sidebar, Search | Per-conversation latest activity: last message preview (bounded, owner-visible), its time, and ordering by recent activity | Second line shows description or role; no time |
| C2 | 账户与安全 | Change the Owner password; list signed-in sessions and revoke other sessions (audited) | Rows shown read-only; actions hidden |
| C3 | 审计记录 | Record login, settings-change and host events; filter by category; CSV export | Client-side category filter over loaded events; export hidden |
| C4 | 审批与权限 | Server approval policy per action class and per-Bot/target exceptions (security boundary: ADR and fail-closed tests first; delete/install/permission changes can never be excepted) | Read-only policy list (current behaviour) |
| C5 | 通用, 关于, Menu | Desktop main process: launch at login, keep running in background with a menu-bar icon, global shortcut, Dock badge count, update check/download/install | Rows hidden on Desktop until the bridge exists; Web shows none |
| C6 | 员工浏览器 | Browser runtime status, restart, clear browsing data, download/screenshot retention settings | Status from existing sessions only; actions hidden |
| C7 | 通用 | Owner time zone and default model for new Bots as Server settings | Hidden |
| C8 | 插件 page | Curated plugin catalog source (reviewed entries only) | "我的插件" only |

Client-only design items that need no backlog: theme, language, notification options (the ADR-0048
preference store), per-conversation mute, sidebar pin/group/hide and unread marks.

## Per-step definition of done

1. Layout, sizes, colors and copy match the artboard at 1440×900; phone width has no overflow.
2. Existing behaviour and data paths are kept; nothing the Server does not provide is invented.
3. Component tests updated or added; `npm run check` passes; no new Biome warnings.
4. Rendered comparison against the artboard recorded in the pull request.
