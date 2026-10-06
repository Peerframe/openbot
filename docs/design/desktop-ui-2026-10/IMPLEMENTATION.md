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
| 26 | Stage names and 任务监督 step counts — **merged** | TaskCards, TaskInspector, WorkSupervision | C13 | Chinese names for the 服务电脑's stage keys; 「第 N 步：…」 from the latest Work action |
| 27 | Retire the legacy style layer — **merged** | — | — | The seven legacy sheets are gone: component rules beside their components, shared ones in `base.css` and `shell.css`, verified by a 68-state computed-style sweep |
| 28 | README and interface pictures — **merged** | Avatars, AppIcon | C10 | New README banner (the Round head and a pixel wordmark, drawn by `?scene=banner`), a current channel picture, the avatar sheet, and `INTERFACE.md` §5 rewritten for the head-and-jaw identity |
| 29 | Storage follow-ups — **merged** | ChannelFilesTrash, SettingsStorage | C22, C23, C24 | 清空回收站… in 存储空间 with the second confirmation and same-key retry; per-Bot browser data measured on request; 查看引用 › jumps to the message (reading older pages, bounded) or opens 任务详情 |
| 30 | Website demo and dead code — **merged** | — | C13 | The demo's sidebar follows the product width and its fixed runs report step counts (H7); the last unreachable module is deleted (H9) |
| 31 | Close-out — **merged** | — | — | Docs brought up to date with what is built, contracts for C9 and C11 recorded for Codex, H8 reviewed, CJK spacing around names, and the C16 icon test's budget |
| 32 | Owner feedback: settings, popovers, scale and motion — **merged** | Settings, Sidebar, New, Slash | — | Settings search and close fixed, overlay scrollbars, plugin tiles, no title on New, 「+」 closes outside, @ with plugins at the caret, Desktop at 1200×780 and 90%, the motion layer |
| 33 | Telegram-like conversation — **merged** | Main, Composer | — | Arriving messages rise in, views fade in, glide to latest and to quotes with a flash, compact 48px composer |
| 34 | Retire the phone layout — **merged** | — | — | `MobileNavigation` and the phone-only layout rules deleted; the desktop layout holds down to 800px |
| 35 | 新建聊天 recipients as a compact dropdown — **merged** | New | — | As in the Owner's reference recording: 36px rows from the field's left edge, the shortcut on the highlighted row only, closes on an outside press |
| 36 | Dark appearance — **in review with 37** | DarkTokens, MainDark, NewDark, SettingsGeneralDark | C25 on Desktop | A dark value for every colour token; about 500 hard-coded colours moved to tokens (light unchanged); 通用 › 主题 跟随系统 / 浅色 / 深色; on Desktop the window follows (C25) |
| 37 | Backend wiring — **in review** | BotInfo, NewBotChat, SettingsGeneral | C9, C11, C25 | 编辑头像 saves each change at the revision; the C11 greeting above the role card; 主题 on Desktop through the C25 bridge. Carries step 36, whose #183 was merged into the step 35 branch after that branch had already been merged |
| 38 | Bottom rows level and real logos — **merged** | Main, New, Sidebar, Settings, Plugins | — | Composer and sidebar footer both 44px and 18px above the window edge; provider and plugin logos from LobeHub (MIT) and SVG Logos (CC0) instead of letter tiles |
| 39 | Conversation polish — **in review** | Main, MainDark | C27 on Desktop | From the Owner's second reference recording: Telegram-like runs (coloured name above, avatar below), Bot names as tags, 「X 正在工作…」, 「新」, https links (Web; Desktop inert until C27), mic-only empty composer, deep-grey own bubble in dark |
| 40 | One model list in 设置 › 模型服务 — **in review** | Settings | C28 to retire it | The older single setting stays (the Server still uses it for voice transcription and Bots without a model) but becomes 语音转写与旧版 Bot 的模型: a compact provider list with the logo and why it is separate; first-run setup shows logos; the `kimi` preset id gets the Moonshot logo |
| 42 | Plugins dialog and the Bot page into the rail — **in review** | Plugins, BotInfo, BotInfoWork | C27 for the catalogue links on Desktop | After Grok's 市场: a 760px dialog as tall as its content with two-column rows. The Bot page is gone: opening a Bot opens its 单聊 with the rail, which gains 介绍, 技能 and 记忆 rows and a short 工作 tab (three tasks, three 成长 events), routine switches and fainter scrollbars; the Profile artboards move to the canvas page 已移除 · Bot 档案 and about 870 lines of page-only CSS go |

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

Done 2026-10-02 and 2026-10-03 (#147, #149, #150, #157–#161, #164, #165) and C22–C24 (Codex branch `codex/c22-c24-storage-follow-ups`):

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
| C22 | Global 清空回收站 with one replayable key, and `referencedSizeBytes` | Integrated (step 29) |
| C23 | Browser profile bytes per Bot from browser status (Owner-approved narrow fork qualified; null still shows 「量不出」) | Integrated (step 29) |
| C24 | Owner-only list of the messages and tasks that reference a file | Integrated (step 29) |

Done 2026-10-03 (#182, #184–#186):

| ID | Contract | UI |
| --- | --- | --- |
| C9 | Edit a Bot's appearance after creation: Owner-only, audited, revision-checked | Integrated (step 37): 编辑头像 in the Bot rail |
| C11 | New-Bot greeting: one bounded, tool-less model call after quick-create, tagged `origin: "greeting"` | Integrated (step 37): the greeting sits above the role card |
| C23 fork | Owner-approved narrow `agent-computer` fork reporting profile bytes ([evidence](../../research/storage-cleanup-follow-ups.md#c23-owner-approved-fork-and-image-2026-10-03)); deployment to existing Workers is separate | Real bytes once a Worker runs the new image; a failed measurement still shows 「量不出」 |
| C25 | Desktop colour scheme: the main process keeps 跟随系统 / 浅色 / 深色 and sets the window background and material ([contract](../../API.md#desktop-color-scheme-c25)) | Integrated (step 37): 主题 works on Desktop |

Open — in the order the UI needs them:

| ID | Needed by | Contract to add | UI until ready |
| --- | --- | --- | --- |
| C27 | Step 39 | **Desktop opener for links in messages**: an optional bridge `openExternalLink(url)`. The main process accepts only an https URL without credentials, at most 2,048 characters, from the main window during a user gesture, and at most one per second. The first time a host is opened in a session, a native confirmation names the host (打开 / 取消). It opens with the system browser and returns `opened` or `refused`. Links never navigate the app window | Links show with a globe but stay inert on Desktop |
| C28 | Step 40 | **Retire the older single model setting**: voice transcription uses an Owner-chosen OpenAI model connection, and Bots without their own model fall back to the C7 default model, so `GET/PUT /api/v1/settings/model` and its separate key are no longer needed. Existing settings migrate or are offered once as a connection; nothing is deleted silently | 设置 › 模型服务 keeps the compact 语音转写与旧版 Bot 的模型 section |
| C26 | Step 41 | **主 Bot** (Owner decision 2026-10-05; the design is being chosen on the canvas): one Owner-chosen Bot per workspace, revision-checked and audited, that un-@ messages in a 频道 it belongs to go to first and that may hand work to other members through the existing delegation. Contract to follow the chosen design | — |

## Repository housekeeping (proposals)

| ID | Proposal | Who | Needs owner decision |
| --- | --- | --- | --- |
| H1 | **Done 2026-10-02.** The main checkout `/Users/yxflc/Project/openbot` was on the old branch `feat/desktop-ui-refresh` with superseded edits and stray files. They are archived in a stash (recoverable with `git stash list`), and the checkout now tracks main | Claude | Approved |
| H2 | **Done 2026-10-02.** The avatar source (12 SVGs, manifest, README) is in [`docs/design/avatars/`](../avatars/README.md) | Claude | Approved |
| H3 | **Done 2026-10-02.** Codex moved its eight finished worktrees out of the repository, keeping their environments and records | Codex | No |
| H4 | **Done 2026-10-02.** The stacked pull requests are merged (#132–#151) and the 29 merged `codex/claude-ui-*` branches are deleted | Owner | Yes |
| H5 | **Done 2026-10-03 (step 27).** The legacy `styles.css` and six other legacy sheets are gone; rules live beside their components, with shared ones in `base.css` and `shell.css` | Claude | No |
| H6 | **Done 2026-10-03 (step 28).** `docs/INTERFACE.md` describes the head-and-jaw identity with the eight accents; the README banner, channel picture and avatar sheet are captured from the design preview | Claude | No |
| H7 | **Updated 2026-10-03.** The website demo (`apps/web/src/demo`) renders the redesigned components; its sidebar follows the product width and its fixed runs report step counts. Keep its fixtures in step with each change | Claude | No |
| H8 | **Reviewed 2026-10-03.** Tests mostly find elements by role, `aria-label` or class (about 620 and 420 uses); only 41 finds use visible text, mostly button names, which are the accessible names. Copy assertions stay on purpose: the copy is the behaviour under test | Claude | No |
| H9 | **Done 2026-10-03.** No unreachable UI module is left; the last one, `desktop-setup.ts` (a stale copy of the Desktop setup plan), is deleted. Keep deleting replaced UI in the same step | Claude | No |

## Owner decisions (2026-10-06)

1. Remove the Bot page; keep the right rail. Its useful parts (介绍, counts, tasks, 成长, links to
   skills and memory) move into the rail (step 42).
2. The 插件 dialog is too large and less clear than Grok's 市场; make it compact (step 42).
3. After Grok's rail: 工作 must not grow long by default, and scrollbars should be lighter (step 42).

## Owner decisions (2026-10-05)

1. The composer and the sidebar footer share one line; providers and known plugins show real logos
   (step 38).
2. From the second reference recording (step 39): Telegram-like runs, Bot name tags, 「X 正在工作…」,
   「新」 and a mic-only empty composer.
3. B: in dark, your own bubble is deep grey, not white.
4. C: links in messages open, https only; Desktop needs its own opener (C27).
5. D: no realtime voice conversation for now.
6. A: a 主 Bot, in OpenBot's own design rather than the reference's; three options are on the
   canvas (主 Bot · 待选) and the backend contract (C26) follows the chosen one.

## Owner decisions (2026-10-03)

1. Delete the phone layout (`MobileNavigation`) rather than design it (step 34).
2. 新建聊天 recipients become a dropdown under the field, as in the reference recording (step 35).
3. Add a dark appearance (step 36), with dark artboards on the canvas first.
4. Republish the design canvas without the 「待确认」 marks.
5. C23: do not wait for upstream; run our own narrow `agent-computer` fork.

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
