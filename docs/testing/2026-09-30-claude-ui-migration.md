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
