# OpenBot Desktop design rules

[English](DESIGN.md) · [简体中文](DESIGN.zh-CN.md)

This is the binding design reference for the Desktop and Web clients. The owner's design canvas is
the source; the `.dc.html` snapshot beside this file is its read-only copy (see
[README.md](README.md)). The delivery plan and the division of work are in
[IMPLEMENTATION.md](IMPLEMENTATION.md).

## Rules

1. **The canvas wins.** Code reproduces the artboards one to one: layout, sizes, copy, states and
   interaction. Earlier screens, earlier copy and behaviour that has no artboard are not a
   reference. Anything visible with no artboard is designed on the canvas first, approved by the
   owner, then built.
2. **No legacy look survives.** The earlier interface is retired, not restyled. A component that
   still renders a legacy class (see [Legacy inventory](#legacy-inventory)) is unfinished work.
3. **One token layer.** Colours, type, radii and spacing come from the `--ob-*` tokens in
   `tokens.css` and the shared primitives in `primitives.css` (pills, `.ob-seg`, the `Dialog`
   frame). Component CSS lives beside its component.
4. **Data honesty.** An element whose data or capability does not exist yet is hidden, never faked.
   The artboard shows the finished product; the plan says what stays hidden until its backend item
   lands.
5. **Safety is not a design choice.** Approvals, Owner-only actions, fail-closed checks and audit
   stay even when an artboard does not draw them; the design decides only how they look.
6. **One vocabulary.** User-facing copy uses the [glossary](#glossary).
7. **Accepted by picture.** Each step is accepted by screenshots of the built screen next to its
   artboard at 1440×900, plus the listed behaviours. Screens are captured from the design preview
   (`npm run design:preview -w @openbot/web`, synthetic data, dev only).
8. **Each pull request updates this file** when it changes what is designed, built or retired.

## Glossary

| Use | For | Do not use in the UI |
| --- | --- | --- |
| Bot | A persistent digital employee | 员工 (except 员工浏览器), Agent |
| 频道 | A conversation with several Bots | 群聊, 群组, Channel |
| 单聊 | A conversation with one Bot | DM, 私聊 |
| 服务电脑 | The OpenBot Server | Server, 服务器, 服务端 |
| 工作电脑 | A computer that runs Bot tasks | Worker, 节点 (the settings section may keep the name 工作主机) |
| 任务 | One unit of Bot work | Run |
| 例行任务 | A scheduled, repeating task | 自动化, Automation |
| 产出 | Files a task produced | Artifact, 产物 |
| 需要你确认 | An action waiting for the Owner's approval | Approval |
| 工作中 | A Bot or task that is working right now | 执行中, Running |

## Foundations

| Area | Values |
| --- | --- |
| Colours | Text `#1d1d1f`, secondary `#6e6e73`, tertiary `#8e8e93`; page `#fcfcfc`; fill `#f0f0f2`; hover `#e6e6e8`; divider `#e3e3e6`; primary `#111111`; blue `#1f6fd6` (unread only); green `#34c759` (工作中 and online), text `#1c7c3c`; danger `#b3261e` on `#fbe9e7`; attention `#b5651d` on `#fdf0e1` (tokens `--ob-*`) |
| Type | System UI / PingFang SC; body 15px, caption 13px, meta 12px, section label 13px/500, page title 24–28px/700, dialog title 22px/700 |
| Radii | Pills 17px (34px high) or 20px (40px high, dialogs), cards 16–18px, task cards 18px, bubbles 22px, dialogs 22px; Bot avatars have no radius because they have no frame |
| Primitives | `.ob-pill` (`is-primary`, `is-outline`, `is-danger`, `is-small`), `.ob-round`, `.ob-switch` (44×26), `.ob-filter`, `.ob-tag`, `.ob-field`, `.ob-search`, `.ob-card`, `.ob-menu`, `.ob-menu-item`, `.ob-seg` (segmented control) |

## Window shell

- Three columns: sidebar 300px, main, rail 340px (264/300 and 236/264 at 1280/1100px).
- **No global toolbar.** The sidebar's top row holds the macOS traffic lights (x 20, y 20) and the
  「+」 button on one 30px row. Search follows.
- The main column has its own 56px header: the title pill in the centre; 实时 status and 分享 on
  the right.
- **The title pill opens the right rail**: 频道信息 (ChannelInfo) in a 频道, Bot 信息 (BotInfo) in a
  单聊. The rail's 收起 closes it.
- Back, forward and the panel toggles are keyboard and menu commands (⌘[ ⌘] ⌘B ⌘⇧B). When the
  sidebar is hidden, the header leaves room for the traffic lights and shows one button to reopen
  it.
- The phone layout is out of scope for now; narrow windows keep working but get no new design.

## Creating Bots and 频道

- **「+」 opens 新建聊天** (New): a 收件人 field with a list. The first two rows are actions —
  创建新 Bot ⌘1 and 创建频道 ⌘2 — then existing Bots continue the numbering up to ⌘9.
- **One Bot chosen = 单聊; several = 频道.** Chosen Bots become chips and the list keeps the rest.
  With several chips a hint offers 命名频道, and the 频道 is created when the first message is sent
  (NewGroup).
- **创建新 Bot creates immediately — no dialog** (NewBotChat). The new Bot gets the name 新建 Bot
  (numbered when the name is taken), a random head and colour the team is not using yet,
  no computer, and the default model. The app opens its 单聊 with the rail open.
- The conversation shows **「你最想让我先帮你做什么？」**: three role choices and a free answer.
  Choosing sets the Bot's tag and role and sends the choice as the Owner's first message. The
  Bot's own greeting above it appears only when the backend can generate it (C11).
- **BotInfo rail**: the 88px avatar with a pencil button, the name edited in place, 添加标签, then
  详情 / 资料库 / 电脑. The pencil opens **编辑头像**: 头型, 下颌色, 随机 and 重置; changes apply at once
  (needs C9). Upload and AI generation are not planned (owner decision, 2026-10-02).
- **Adding to an existing 频道** (AddMember): 成员 → 添加成员 opens a popover with 搜索 Bot and the
  Bots not yet in it. Hovering a member shows a light-red 移除 pill.

## Bot avatars (v3)

- Three head characters from the owner's avatar system (`nft_like/03_avatar_svg` v2) on a 96-unit
  grid: **Round** (antenna), **Relay** (ears) and **Scout** (cat ears). Stored head shape round →
  Round, square → Relay, cat → Scout. v3 widens Relay's face from 62 to 66 units.
- **Jaw colour**, eight accents of matched lightness: green `#91CF4B`, blue `#5F7CDE`, amber
  `#DFAD4F`, coral `#E0785C`, violet `#9C7FE3`, teal `#3FB4A6`, pink `#E57BA8`, slate `#8C98A8`.
  The last four need C10; until then only the first four are offered.
- **No frame.** No tile, ring, border or background behind an avatar anywhere.
- Sizes: 96 profile, 88 rail, 72 launch, 40 sidebar rows and members, 32 messages, 24 title pill,
  16–20 menus and mentions. Below 32px the micro drawing is used: larger eyes and antenna ball,
  rounder cat ears, no ear stripes.
- **Status dot and motion.** A dot at the lower right with a ring of the surface colour: green
  and pulsing = 工作中, orange = 需要你确认, grey ring = 离线; idle shows nothing. While working the
  head also moves: a gentle bob, the eyes look left and right, Round's antenna wiggles, Relay's ear
  lights blink, Scout's ears twitch. Reduced motion keeps only the static dot. The dot is shown in
  the sidebar and the Bot profile; rail members show the motion next to their status label.
  Shape and colour never change with status, and colour carries no meaning.
- A dark-surface edition exists (ivory head) for a future dark mode.

## Group avatars

- A 频道 draws at most three heads. **The first member is in front**, and the order never follows
  status.
- Each front head is **cut out along its own silhouette** by about 2px of the surface colour, so
  overlapping dark heads stay separate.
- 0 Bots: a grey tile with #. 1 Bot: the head plus a small # badge, so a 频道 never looks like a
  单聊. 2: a diagonal pair at 66%. 3: two behind, one in front. 4 or more: the first two heads plus
  a black count badge (+N).
- One status dot for the whole 频道 (any member working or waiting), lower right, or upper right
  when the # or +N badge holds that corner.
- Accessible name: 「市场周报，3 名 Bot：研究助理、客服小橙、发布助手」.

## Tasks in a conversation

- **One task card per task, updated in place** (TaskCards): queued → running → needs you → done
  or failed, then it collapses to a one-line summary. White card, 1px `#ececee` border, radius 18,
  under the Bot's avatar column, at most 76% of the message column.
- Colour marks state only: green 工作中, orange needs you, red failed; done uses a neutral black
  check.
- Running shows the reported step count (「已完成 3 步」) and the current step, never an invented
  total, plus the live computer frame when there is one, 补充指令 and 停止.
- Approvals are decided on the card; the same approval in the rail updates with it.
- Failures show the user-readable reason from the 服务电脑; raw errors stay in 任务详情.
- **任务详情** is a 460px sheet from the right (TaskInspector): status, computer frame, 分工, 进度,
  任务信息 (model and usage), and 补充指令 / 停止任务.

## Dialogs

- One frame for every dialog: the app behind a `rgba(0,0,0,0.34)` dim, a `#fdfdfd` sheet with
  radius 22 and padding 30/32/24, a close button at the top right, a 22px/700 title with a 14px
  intro, and actions at the bottom right (grey 取消, then a black primary or red danger pill).
- Designed: 分享, 分享 Bot 模板, 导入 Bot 模板, 删除确认 (Bot and 频道), 配对工作电脑, 连接模型服务.
  New Bot and new 频道 have **no dialog** (see above).

## Screen map

**Built** = matches the artboard; **Step N** = planned in [IMPLEMENTATION.md](IMPLEMENTATION.md).

| Artboard | Built in | Status |
| --- | --- | --- |
| Components | `tokens.css`, `primitives.css`, `Dialog.tsx` | Built |
| Sidebar, Search, Menu, ContextMenu | `Sidebar.tsx`, `SidebarItemMenu.tsx` | Built (group avatars and status dots included) |
| Main | `App.tsx`, `WorkspaceHeader.tsx`, `ChannelWorkspace.tsx` | Built; task cards in step 19 |
| ChannelInfo, AddMember | `ContextRail.tsx` | Built; add-member popover in step 18 |
| BotInfo | `BotInfoRail.tsx` (单聊 and the Bot profile) | Built; 编辑头像 waits for C9 |
| Profile | `EmployeeProfileView.tsx` | Header and 概览 built; other tabs need design (step 22) |
| New, NewGroup, NewBotChat | `NewChatScreen.tsx`, `NewBotSetupCard.tsx` | Built; the greeting waits for C11 |
| Slash | `ChannelWorkspace.tsx` composer menus | Built |
| Settings, SettingsNav, Settings* | `DesktopSettingsScreen.tsx`, `Settings*.tsx` | Built |
| Plugins | `PluginsDialog.tsx`, `PluginManagerPanel.tsx` | Built |
| Avatar, Avatars, GroupAvatar, GroupAvatars | `RobotAvatar.tsx`, `GroupAvatar.tsx` | Built; violet, teal, pink and slate wait for C10 |
| Launch, LaunchMotion, Welcome, Install, Connect, Login, ModelSetup, WorkerSetup | `Onboarding.tsx` and the setup screens | Built |
| TaskCards, TaskInspector | new `TaskCard.tsx`, `TaskSheet.tsx` | Step 19 |
| Dialog* | new `Dialog.tsx` frame and the dialogs | Step 20 |
| WorkSupervision, EmptyWorkspace | `WorkTasksScreen.tsx`, new `EmptyWorkspace.tsx` | Step 21 |

## Not designed yet

These are designed on the canvas (step 22) before they are rebuilt; until then they keep working.

| Area | Code today |
| --- | --- |
| Message hover actions, reactions, reply quote | `MessageActionBar`, `MessageReactions` |
| Attachments in messages and the composer, voice input | `MessageAttachments`, `AttachmentPreview`, `ComposerAttachmentPicker`, `VoiceRecorder` |
| 补充指令 input and the skill picker | `RunSteering`, composer skill menu |
| 频道文件 management (recycle bin), to fold into 资料库 | `AttachmentsManager` |
| Bot 档案 tabs: 进化档案 (inspired by Hermes Agent), 技能图谱, 运行中, 记忆, 工作记录, 配置 | `EmployeeEvolutionArchive`, `EmployeeSkillReview`, `KnowledgeReviewPanel`, `EmployeeModelEditor` |
| 员工浏览器 live view | `EmployeeBrowser` |
| Notices, toasts, offline banner | `App.tsx` notices |
| App icon and README images | `apps/desktop/resources`, `docs/design/*.png` |

## Legacy inventory

Legacy classes that must disappear: `primary-button`, `secondary-button`, `icon-button`,
`create-dialog`, `dialog-header`, `dialog-backdrop`, `onboarding-mark`, `destination-*`,
`workspace-toolbar`/`toolbar-*`, `channel-members-*`, `channel-work-item`, `run-inspector`,
`native-run-controls`, `bot-identity-builder`, `appearance-grid`, `workspace-welcome`.

Legacy stylesheets: most of `styles.css`, `workspace-shell.css`, `desktop-workspace.css`,
`desktop-ui-refresh.css`, `settings-plugin-refresh.css`, `workspace-preferences.css`,
`components/destinations.css`.

`CreateBotDialog` and `CreateChannelDialog` were removed in step 16. Screens retired by the plan:
the standalone 例行任务 and 技能库 pages, `AutomationsScreen` and `SkillLibraryScreen`
(replaced by 设置 › 例行任务 and 设置 › 技能); and the old raster mark `OpenBotMark`.

Done so far: the window shell and rail, and launch and setup. The rest follow the steps in the
plan; each step deletes the legacy rules it replaces in the same pull request.
