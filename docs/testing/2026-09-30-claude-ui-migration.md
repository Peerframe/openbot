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
