# Claude UI draft migration — 2026-09-30

[简体中文](2026-09-30-claude-ui-migration.zh-CN.md)

## Current handoff

Branch: `codex/claude-ui-integration-20260930`. Base: current `origin/main` at
`5e5d6ac`, rather than the original draft's `9cc73c9` from September 8. The original
uncommitted draft remains in its original checkout; it is not the integration entry.
Continue from this branch and push to the same branch. Do not replace current components
with the old draft or migrate its obsolete repository instructions over current rules.

The migrated slice combines channel/Bot navigation, adds known member avatars and Bot role
search, clears search with Escape, and adopts the draft's neutral surfaces and primary
buttons through existing style owners. Current message bubbles/composer were reused.
Caret-aware mentions retain the trailing draft, restore the caret after the controlled
value commits, and still use the existing structured recipient commands. Current settings,
plugins, task supervision, attachments, everyone/multiple recipients, mobile navigation,
reply/actions, and Server authority remain in place.

This is the first draft slice only. Additional settings/profile redesign, pinning, unread
state, hiding and renaming are not part of this delivery. No dependency, permission,
persistence schema, backend or Electron bridge changed. Reuse follows the existing
Desktop channel workspace/navigation/conversation entries in `docs/OPEN_SOURCE_REUSE.md`;
no upstream source was copied. The current native disclosure lifecycle was kept instead
of introducing the draft's parallel popover hook.

## Executed verification

- Locked `npm ci` completed in the isolated current-base checkout.
- Focused mention, Sidebar, ChannelWorkspace and ApprovalCard checks: 30 tests passed.
- `npm run check`: exit 0. Web: 72 files / 529 tests passed. Desktop: 44 files /
  514 passed and 3 existing platform/environment skips. Unchanged Turbo tasks used cache;
  the changed Web tests/build executed. Repository lint/style and Vite size/config warnings
  remain informational; they are not relabeled as errors or new platform acceptance.
- `npm run build:demo --workspace @openbot/web`: exit 0 before the final caret refinement;
  the final production Web/Desktop builds ran in the full check.
- Actual production App at `http://127.0.0.1:5180/`, isolated Chrome, synthetic API fixtures:
  1440×900 and 390×844. Page identity, nonblank rendering, no framework overlay, no
  application console errors, and no horizontal page overflow passed. Desktop checked
  role search, Escape clearing, known avatars, disclosure keyboard/focus and settings
  entry. Narrow checked the existing mobile channel/approval navigation. Both selected
  a mention in the middle of text and verified the captured request's preserved content
  and recipient ID. Screenshots and the fixture script remain outside the repository.
- The original development-only meta-CSP `frame-ancestors` warning was recorded separately.

Browser API/EventSource fixtures replace the backend for this UI check. They do not prove a
live Python/Temporal/model run, paid-provider behavior, packaged installation or additional
platform support. The installed alpha.9 application was retained, not upgraded by this change.

## Continuation — remaining approved design

Commits after `0df5c33` on this branch: `ca6aaaf`, `4827c34`, `694d0ad`, `2cba593`, plus this
record. Scope stays in `apps/web`; no dependency, Server route, persistence schema, permission or
Electron bridge changed, and no upstream source was copied.

- Right rail and approval cards use neutral grouped cards with 12–14px text. Attention is a
  coloured label with pill actions; destructive/privileged approval keeps a red primary action.
- The sidebar footer places the account avatar (existing account menu) and the plugins pill on one
  row. The Owner name moves into the avatar's accessible label.
- Plugins/skills, Desktop settings and the Bot profile replace the macOS-blue accents with black
  primary pills, pill tabs/filters and the shared grey cards. Focus rings keep `--blue`.
- Sidebar context menu (right-click, Shift+F10 or the context-menu key): open profile, pin, move to
  a group (inline new group), mark unread and hide. Groups render as sections with rename/dissolve;
  search matches group names and still finds hidden rows. Right-click no longer opens the profile
  directly; the profile is the first menu item.
- The arrangement lives in `sidebar-organization.ts` under the per-device `localStorage` key
  `openbot.sidebar-organization.v1`, with the same bounded allowlist parsing as workspace
  preferences. It is presentation only: it grants nothing, renames nothing and deletes nothing.
  Unread is a manual mark cleared when the row is opened; automatic unread counts would need
  Server read state and are not claimed.
- Typing `/` at the start of a word lists the single @ recipient's reviewed skills, attached
  through the existing draft skill list, followed by the existing attach and channel-file actions.
  Paths and URLs do not open it; candidate skills stay hidden.

Not delivered: renaming or deleting channels and Bots (no Server route; this needs a contract and
persistence change), settings sections without Server data (approval-policy editing, audit viewer,
notification and per-design routine pages), and a sectioned settings screen for the non-Desktop
Web entry, which still opens the model form.

### Continuation verification

- Focused Vitest: Sidebar, sidebar arrangement, slash query, ChannelWorkspace (including the new
  `/` menu case), ChannelWorkspace integration, mention query, App workspace-state/navigation,
  ContextRail, ApprovalCard, EmployeeProfileView, SkillLibraryScreen, DesktopSettingsScreen,
  ModelSettingsScreen and PluginManagerPanel passed; Web typecheck passed. Biome reported no new
  warnings on the touched files compared with their base versions.
- `npm run check`: exit 0 on commit `2cba593`. Web: 74 files / 546 tests passed. Desktop: 44 files /
  514 passed and 3 existing platform/environment skips. Node: 129 passed, 3 skipped. Turbo reused
  12 cached tasks; the changed Web tests and builds executed.
- Rendered the real App through the Vite dev server with `OPENBOT_DEV_API_URL` pointing at a
  disposable synthetic loopback API (outside the repository) at 1440×900 and 390×844: rail and
  footer, account menu, plugins page, Bot profile, context-menu group creation, pin, manual unread,
  group-name search, `/` menu with and without a recipient (skill chip attached, command text
  removed, Escape closes), the mobile approval sheet, and no horizontal page overflow.

The synthetic API does not prove Python/Temporal execution, a live model, packaged Desktop
behaviour or additional platform support.

## Continuation — identity lifecycle, unread and settings

This slice adds the Server contract the previous record listed as missing, under
[ADR-0047](../decisions/0047-identity-lifecycle-and-read-state.md). The Owner chose permanent
deletion with confirmation that removes content and keeps an audit tombstone, and a read-only
approval-policy page.

- Migration `0045_identity_lifecycle` adds `deleted_at` tombstones to `bots` and `channels`, scopes
  name uniqueness to live rows and adds `channel_read_states`; existing channels start as read.
- Python routes: `PATCH`/`DELETE /api/v1/channels/:id`, `PATCH`/`DELETE /api/v1/bots/:id`,
  `POST /api/v1/channels/:id/read`, `GET /api/v1/channels/unread` and `GET /api/v1/audit`. Rename
  and delete write audit events in the same Owner transaction. Delete refuses while any Run is
  active, deletes unreferenced messages, redacts Work-referenced ones and removes membership,
  automations, learning rows and (for Bots) plugin grants after the tombstone commits.
  Workspace, list, message/run reads, membership, direct conversation, profile, task submission,
  automation, attachment, model-selection, browser and plugin-grant entry points exclude tombstones.
- Zod `renameBotInputSchema`/`renameChannelInputSchema` mirror the Pydantic models and join the
  identity differential fixture.
- Web: the sidebar menu adds 重命名… (inline, Server errors in place) and 删除频道…/删除 Bot… with a
  confirmation dialog naming the target and scope. Server unread counts show as badges; opening a
  channel marks it read. Settings gain 审批与权限 (read-only facts from the plugin, browser,
  native-agent and skill documents) and 审计记录 (paged, allowlisted). The non-Desktop Web entry
  now opens the same sectioned settings without Desktop-only connection and material rows, and
  stacks the section list on phones. Fixed two earlier regressions from this branch: channel rows
  wrapped trailing marks onto a new line, and the settings switch override lost on specificity.
- `.claude/launch.json` records the Web dev server entries used for rendered review.

Not delivered: a notification settings page (neither Desktop nor Server has a notification facility
to configure) and approval-policy editing (read-only by the Owner's choice). Attachment blobs of a
deleted channel stay on disk but unreachable; physical retention cleanup is separate.

### Lifecycle verification

- `apps/server-python/scripts/check.sh -q`: 1344 passed, 477 skipped (database cases skip without
  the fixture).
- `node scripts/test-python-control.mjs` on its own disposable PostgreSQL container: 871 passed,
  2 skipped, including 7 new `test_identity_lifecycle.py` cases (rename conflicts and audit,
  direct-channel refusal, active-work refusal, content removal with Work-referenced redaction,
  tombstone exclusion, unread cap and cursor, audit allowlist/paging, HTTP Origin and 404s) and the
  new plugin-grant case. Worker/Temporal checks were not run (`OPENBOT_TEMPORAL_TEST_PYTHON` unset).
- `compare-identity-inputs.ts`: 149 cases agreed between Zod and Python.
- Web: new Sidebar identity, settings-section and Web settings tests; full Vitest suite in
  `npm run check` below.
- `npm run check`: exit 0 before the commit of this slice. Web: 76 files / 554 tests passed. Desktop: 44 files /
  514 passed and 3 existing skips. Node: 129 passed, 3 skipped. Protocol 430 passed. Turbo reused
  cached unchanged tasks; changed packages executed.
- Rendered the real App against the disposable loopback API at 1440×900 and 390×844: unread badges,
  rename success and in-place conflict, delete refusal while work is active, successful Bot delete
  removing its row and channel avatar, open-to-read, Web settings sections, approval policy, audit
  list with tombstone labels, black switches, and no horizontal overflow on phones.

## Continuation — notifications and deleted-channel files

Closes the two items the lifecycle section left open.

- Deleting a channel (or a Bot's direct conversation) now removes its attachment files after the
  tombstone commits, under the attachment lock and in a transaction that re-proves the tombstone;
  responses report `attachmentsRemoved` (ADR-0047 updated).
- Settings → 通知 adds opt-in, per-device system notifications for new pending approvals and new Bot
  replies while OpenBot is in the background ([ADR-0048](../decisions/0048-owner-system-notifications.md)).
  Desktop shows them through a new trusted-frame bridge to Electron's main-process `Notification`
  with exact bounded `{title, body}`; renderer permissions stay denied. The Web entry uses the
  browser Notifications API after a permission prompt from the switch. Notices contain only Bot and
  channel names and a count, a click opens the related channel, and the first snapshot never
  replays a backlog. The open channel is now marked read only while the window is attended, and on
  returning focus, so a background reply there can still notify.
- Fixed a Biome warning (comma operator) introduced by the lifecycle Web commit.

Not claimed: display on packaged or signed Desktop builds on any platform (unsigned macOS builds
report `failed`), or delivery while OpenBot is closed.

### Notification and cleanup verification

- `node scripts/test-python-control.mjs` (disposable PostgreSQL): 873 passed, 2 skipped; the HTTP
  lifecycle case uploads real files and proves the deleted channel's and direct conversation's
  files are removed, a live channel's file survives and the purge refuses a live channel.
- Desktop: notifier and preload tests (bounds, unsupported, click-only focus, failure, expiry,
  four-pending cap). Web: tracker/delivery tests (baseline, no approval details, per-channel
  throttle, browser permission and Desktop bridge paths) and notification settings tests.
- `npm run check`: exit 0 before this commit. Web 77 files / 559 tests; Desktop 45 files / 520 passed, 3
  existing skips; Node 129 passed, 3 skipped; Protocol 430 passed.
- Rendered the settings page against the disposable loopback API: 通知 section, and with the
  browser pane's notifications denied the switches and test button are disabled with the reason
  shown.
