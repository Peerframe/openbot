# Desktop UI implementation plan

[English](IMPLEMENTATION.md) · [简体中文](IMPLEMENTATION.zh-CN.md)

## In one minute

- **What we are building:** the Desktop and Web app exactly as drawn on the owner's canvas (the
  [artboards](README.md)). The rules are in [DESIGN.md](DESIGN.md); the canvas wins over any older
  screen or copy.
- **Who does what:** Claude builds everything you see and touch (screens, layout, motion, copy,
  keyboard use). Codex builds what is behind it (服务电脑, data, Desktop main process, CI). They meet
  at written contracts: the backlog items C1–C24 below.
- **How you review:** every step is one pull request with screenshots of the built screen next to
  its artboard. You check the pictures and click through the listed behaviours. You do not need to
  read code.
- **What you decide:** the open questions at the end of this file, and the step-22 designs before
  they are built.

## Division of work

One implementer per file scope (root `AGENTS.md`). Cross-scope needs go through the backlog.

| Owner | Scope |
| --- | --- |
| Claude | UI and UX: `apps/web/src/**` (components, styles, the Web API client `api.ts`), UI tests, the design preview harness, `docs/design/**`, the canvas |
| Codex | Backend and platform: `apps/server-python/**`, `packages/db/**`, `packages/protocol/**`, `packages/domain/**`, `apps/desktop/src/**` (main process and preload), desktop packaging and icons, CI and scripts |

A backlog item is ready for UI when its route or bridge method, domain/protocol types and tests are
merged and documented in `docs/API.md`. Until then the UI hides the design element that needs it
and never fakes it (DESIGN.md rule 4).

## How every step is delivered

1. Claude builds the step on a branch stacked on the previous step and keeps the app usable.
2. The pull request holds before/after screenshots at 1440×900 from the design preview harness
   (step 14), the behaviours to click through, and `npm run check` evidence.
3. The step deletes the legacy code and styles it replaces and updates DESIGN.md.
4. The owner merges. Claude never enables auto-merge.

**Definition of done:** pixel layout, sizes, colours and copy match the artboard; every state drawn
on the artboard is reachable; safety behaviour (approvals, Owner-only actions, audit, fail-closed
checks) is unchanged; tests updated; `npm run check` passes with no new Biome errors; DESIGN.md
updated.

## Done

| # | Step | Status |
| --- | --- | --- |
| 0–9 | Tokens and primitives, conversation, sidebar, `/` menu, new chat, Bot profile, settings dialog and all sections, plugins | Merged |
| 10 | Window shell without a global toolbar; title pill opens the rail | Merged: #132 |
| 11 | Avatars v2: frameless Round / Relay / Scout heads | Merged: #133 |
| 12 | 频道信息 rail tabs 详情 / 资料库 / 成员; centred title pill | Merged: #134 |
| 13 | Launch, opening animation and first-run setup | Merged: #135 |
| 14–21, 23a | Foundations, avatars v3, creating Bots and 频道, Bot 信息, 添加成员, task cards, dialogs, 任务监督, Bot 档案 tabs | Merged 2026-10-02: #137–#139, then #151 for steps 16–23a |

## Plan (Claude, UI)

| # | Step | Artboards | Needs | What changes |
| --- | --- | --- | --- | --- |
| 14 | Foundations for 1:1 work — **merged** | Components | — | Tokens and primitives moved out of `styles.css` into `tokens.css` and `primitives.css`, loaded once from `global-styles.ts`; `.ob-seg`, large pills and the `Dialog` frame; a **design preview** (`preview.html`, a synthetic transport using the same isolation as the website demo) that renders the real UI per scene at 1440×900; a copy sweep to the glossary (服务电脑, 工作电脑, 工作中, 产出, 任务) |
| 15 | Avatars v3, group avatars and the 工作中 status — **merged** | Avatar, Avatars, GroupAvatar, GroupAvatars, Sidebar, Profile | C10 for the extra colours | v3 geometry and micro drawing; silhouette cut-out; new `GroupAvatar` in the sidebar, title pill, rail, new chat and mentions; status dot (工作中 / 需要你确认 / 离线) and the working motion with reduced-motion fallback; green replaces blue for 工作中 everywhere |
| 16 | Creating Bots and 频道 — **merged** | New, NewGroup, NewBotChat | C12; C11 optional | 「+」 recipients list with 创建新 Bot ⌘1 and 创建频道 ⌘2; one-click random Bot that opens its 单聊; the 「你最想让我先帮你做什么？」 card; delete `CreateBotDialog` and `CreateChannelDialog` |
| 17 | Bot 信息 rail — **merged** | BotInfo | C9 for 编辑头像 | New `BotInfoRail` for 单聊 and the Bot profile: in-place name, 添加标签, 详情 / 资料库 / 电脑, 编辑头像 popover; replaces `EmployeeProfileRail` |
| 18 | Adding members to a 频道 — **merged** | AddMember, ChannelInfo | — | 添加成员 popover with 搜索 Bot; light-red 移除 pill; group avatar in the rail |
| 19 | Tasks in a conversation — **merged** | TaskCards, TaskInspector | C13 | One `TaskCard` per task with every state, approval on the card, collaboration notice; `TaskSheet` replaces the task inspector modal; delete `channel-work-item`, `native-run-controls`, `run-inspector` styles |
| 20 | Dialogs — **merged** | Dialog* | C17 for 连接模型服务 | One `Dialog` frame; rebuild 分享, 分享 Bot 模板, 导入 Bot 模板, 删除确认, 配对工作电脑, 连接模型服务 |
| 21 | 任务监督 and the empty workspace — **merged** | WorkSupervision, EmptyWorkspace | — | Rebuild `WorkTasksScreen`; new `EmptyWorkspace`; retire the standalone 例行任务 and 技能库 pages (their links open the settings sections) |
| 22 | Design the remaining screens (canvas, then owner approval) — **approved 2026-10-02** | new | — | Message actions and reactions, attachments and voice, 补充指令 input, 频道文件 recycle bin inside 资料库, Bot 档案 tabs (进化档案 credits Hermes Agent), 员工浏览器 view, notices and toasts, app icon and README images |
| 23a | Bot 档案 tabs — **merged** | Profile, ProfileEvolution, ProfileSkills, ProfileMemory, ProfileWork, ProfileConfig | — | Six tabs on a segmented control (运行中 joins 工作记录, 技能图谱 becomes 技能); text filters with counts; long lists per LongLists |
| 23b | Messages and the composer — **merged** | MessageActions, Composer | — | Icon actions beside the bubble, reaction picker, Owner reactions without counts, attachment chips at the 8 / 20 MB limit, recording states, attachment actions |
| 23c | Channel files — **merged** | ChannelFiles, ChannelInfo | — | 频道文件 dialog with 回收站, search and source filter; 资料库 「全部 N 个 ›」 |
| 23d | The Bot's browser — **merged** | EmployeeBrowser | — | Window with take-over and 交还 Bot |
| 23e | Notices and scrolling — **merged** | Notices, LongLists | C18 (merged) | Toast, one banner by severity, the date cue, 回到最新 with a count, older messages on scroll; the scrollbar follows the system overlay |
| 23e-2 | Long lists — **merged** | LongLists | C13 for step counts | Popover lists capped at 8 rows with edge fades, stacked 需要处理, working members first, three collaborators then 「还有 N 个」, long progress collapsed, search in long settings lists |
| 23f | App icon and the legacy layer — **in review** | AppIcon | C16 | Icon sets from the AppIcon board; delete the legacy stylesheets and classes listed in DESIGN.md and `OpenBotMark`; refresh the website demo fixtures |
| 24 | Backend wiring — **merged** | Avatars, New, TaskCards, DialogModel | C10, C12, C13, C17 | Eight accents for new Bots; 创建新 Bot is one atomic call that is never retried automatically; task cards show 「已完成 N 步 · 现在：…」; 连接模型服务 edits one connection: test reads only the model list, a new key is saved only after it passes, a default model per connection, 断开 lists what still uses it |
| 25 | Storage and cleanup — **merged** | ChannelFilesTrash, SettingsStorage | C21 | 永久删除 and 清空回收站 in 频道文件 with a second confirmation, referenced files kept, an unclear cleanup retried with the same request key; 「附件已永久删除」 in messages; 设置 › 存储空间 with measured categories, the 回收站, the opt-in 30-day purge and the largest channels |

Steps run in order; 15 and 20 can run in parallel with Codex items. Each step is one pull request.

## Backend and platform backlog (Codex)

Done (merged into main 40cb3d2):

| ID | Contract | UI |
| --- | --- | --- |
| C1 | Latest activity per conversation: preview, time, ordering | Integrated |
| C2 | Change Owner password; list and revoke other sessions (audited) | Integrated |
| C3 | Audit categories, filters and CSV export | Integrated |
| C4 | Approval policy per action class with protected categories | Integrated |
| C5 | Desktop launch at login, background, global shortcut, Dock badge | Integrated; signed updates deferred |
| C6 | 员工浏览器 status, restart and confirmed clear | Integrated; retention deferred |
| C7 | Owner time zone and default model for new Bots | Integrated |
| C8 | Curated plugin catalog | Integrated |

Done 2026-10-02 and 2026-10-03 (#147, #149, #150, #157–#161, #164, #165):

| ID | Contract | UI |
| --- | --- | --- |
| C10 | Four more avatar accents (violet, teal, pink, slate); older Bot templates still import | Integrated (step 24) |
| C12 | Quick-create a Bot and its 单聊 in one atomic call | Integrated (step 24) |
| C13 | Task progress projection: step counts, the current step, start and end time, a bounded failure code | Task cards, 任务详情 and 任务监督 integrated (23e-2, steps 24 and 26); stage keys shown by their Chinese names |
| C14 | CI: the browser-fixture install step has a longer budget and retries pinned downloads | CI only |
| C15 | Route caller inventory after retiring the 例行任务 and 技能库 pages | No route retired; nothing to wire |
| C16 | App icon sets built from `docs/design/app-icon/` | Packaging only |
| C17 | Model dialog: list models with an unsaved key, a per-connection default model, disconnect refused while a Bot depends on it | Integrated (step 24) |
| C18 | Message pages: a `before` cursor and a bounded page for `GET /channels/{id}/messages` | Integrated (23e) |
| C19 | File reference counts per channel attachment | Integrated (#163) |
| C20 | On-screen claims confirmed or corrected | Wording corrected (#163) |
| C21 | Permanent 回收站 deletion, a cleanup command, measured storage and an opt-in 30-day purge | Integrated (step 25) |

Open — in the order the UI needs them:

| ID | Needed by | Contract to add | UI until ready |
| --- | --- | --- | --- |
| C9 | Step 17 | **Edit a Bot's appearance after creation**: Owner-only, audited, revision-checked | Pencil button hidden |
| C11 | Step 16 (optional) | **New-Bot greeting**: when a model is configured, the 服务电脑 writes a short greeting as the Bot's first message, using only other Bots' names and tags; no model or any failure means no greeting | The setup card shows without a greeting |
| C22 | Step 25 follow-up | **Global 清空回收站**: one confirmed cleanup across every active channel with one replayable `requestKey`, plus `referencedSizeBytes` in `/storage` ([research](../../research/storage-cleanup-follow-ups.md)) | 存储空间 links to each channel's 回收站 |
| C23 | Step 25 follow-up | **Browser profile size per Bot**, measured on the working computer by `agent-computer` (upstream contribution first) and returned by browser status as `profileBytes` | No 浏览器数据 figure |
| C24 | Step 25 follow-up | **Which messages and tasks reference a file**: an Owner-only, bounded list with a short preview | Counts only, no 查看引用 |

## Repository housekeeping (proposals)

| ID | Proposal | Who | Needs owner decision |
| --- | --- | --- | --- |
| H1 | **Done 2026-10-02.** The main checkout `/Users/yxflc/Project/openbot` was on the old branch `feat/desktop-ui-refresh` with superseded edits and stray files. They are archived in a stash (recoverable with `git stash list`), and the checkout now tracks main | Claude | Approved |
| H2 | **Done 2026-10-02.** The avatar source (12 SVGs, manifest, README) is in [`docs/design/avatars/`](../avatars/README.md) | Claude | Approved |
| H3 | **Done 2026-10-02.** Codex moved its eight finished worktrees out of the repository, keeping their environments and records | Codex | No |
| H4 | **Done 2026-10-02.** The stacked pull requests are merged (#132–#151) and the 29 merged `codex/claude-ui-*` branches are deleted | Owner | Yes |
| H5 | `styles.css` is 3,900 lines of mostly legacy rules; split tokens and primitives out first (step 14), delete the rest by step 23 | Claude | No |
| H6 | `docs/INTERFACE.md` still documents the five-layer robot identity and older pictures (`openbot-avatar-system.png`, the channel demo, the README banner); rewrite after C10 and replace the pictures in step 23 | Claude | No |
| H7 | The website demo (`apps/web/src/demo`) renders real product components; its fixtures must follow each step, and it becomes the base of the design preview harness | Claude | No |
| H8 | Many UI tests find elements by Chinese copy, so every copy change breaks them; move to roles and accessible names as screens are rebuilt | Claude | No |
| H9 | Delete the remaining dead UI after each step (`CreateBotDialog`, `CreateChannelDialog`, `AutomationsScreen`, `SkillLibraryScreen`, `OpenBotMark`, legacy dialog classes) instead of leaving them unreachable | Claude | No |

## Owner decisions (2026-10-02)

1. Avatar upload and AI generation: **not now**. Forehead marks are **dropped** (too subtle in the
   avatar); identity is the head, the jaw colour and the name.
2. New-Bot greeting (C11): **yes**, optional, one model call per new Bot.
3. Retire the standalone 例行任务 and 技能库 pages: **yes** (step 21).
4. Commit `nft_like` and clean the main checkout: **yes**, done (H1, H2).
5. Added: a **工作中** status dot with working motion on avatars (step 15).
6. Step 22 boards **approved** (2026-10-02). Bot 档案 uses six tabs on a segmented control with the
   content unframed (option C); 运行中 joins 工作记录 and 技能图谱 becomes 技能. Message actions are
   icons beside the bubble without a bar. Reactions stay the Owner's own six marks.
