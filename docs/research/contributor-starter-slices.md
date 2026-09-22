# Research: contributor starter slices

- Status: Accepted for documentation
- Date: 2026-09-23
- Owner: OpenBot contributors
- Related issue: pending (open from the feature template before implementing a listed card)
- Acceptance journey: a new contributor can pick one Starter card, change one existing behavior,
  and land an independently reviewable PR without first building a cross-tool CI gate.
- Security boundary: documentation and test-only starter work; no change to Server authority,
  credentials, enrollment, Runtime/snapshot/receipt/recovery, or contribution policy files.

## Search evidence

- Search date: 2026-09-23
- Baseline commit inspected: `ebce9950b2bde2c44d88d1d3d1902b9e27ba9eb8`
- Existing OpenBot entries checked:
  - `docs/CONTRIBUTOR_TASKS.md` / `.zh-CN.md` (Starter cards for accessibility runner and
    translation consistency checker; Intermediate Agent Skills quarantine; Advanced PoP identity;
    Platform Provider)
  - `docs/OPEN_SOURCE_REUSE.md` (contributor startup, accessibility-related Desktop/WAI entries,
    workspace-state refactor; no ledger claim that an axe/Playwright a11y CI gate or a
    localization-diff linter already shipped)
  - `docs/research/2026-09-15-contributor-startup.md` (fresh-checkout smoke remains a separate
    “Next” package; not restated as Starter churn)
  - `docs/ACCESSIBILITY.md` (implemented native-dialog and profile-tab baseline; known gaps for
    automated a11y tooling, Run Inspector / mobile overlays, and screen-reader matrices)
  - `docs/research/TEMPLATE.md` and bilingual research pairing conventions
- Paths and tests inspected at the baseline tip (not invented):
  - `apps/web/src/components/useModalDialog.ts` — shared native `<dialog>` bridge; **no** dedicated
    `useModalDialog.test.ts`
  - `apps/web/src/components/CreateBotDialog.tsx` — uses `useModalDialog`, `aria-labelledby`,
    icon close `aria-label="关闭"`, `role="alert"` on create failure; **no** `CreateBotDialog.test.tsx`
  - `apps/web/src/components/AttachmentsManager.test.tsx` — existing Escape / `showModal` / opener
    focus-restore pattern to reuse
  - `apps/web/src/components/EmployeeProfileView.tsx` + `.test.tsx` — `profileTabForNavigationKey`
    and static `tablist` markup covered; **no** interactive keydown proving focus and
    `aria-selected` move together
  - `apps/web/src/components/RunInspector.tsx` + `.integration.test.tsx` — Escape closes and restores
    focus in source; integration test covers collaboration wiring only
  - `apps/web/src/components/NodeManagerDialog.tsx` + `.test.tsx` — dialog uses `useModalDialog`;
    tests cover `NodeIdentityList` static markup and revocation copy only
  - `apps/web/src/components/MobileNavigation.tsx` — sheet has labelled panel and “完成” close;
    **no** test file; Escape not wired (left as ACCESSIBILITY known-gap / Intermediate follow-on,
    not a new Starter inventing product behavior without an issue)
  - `scripts/check-docs.mjs` — local-link and research-policy checks exist; they do **not** already
    implement a translation consistency gate
- GitHub / standards queries (documentation decision only; no new dependency selected):
  - WAI-ARIA APG tabs and modal dialog guidance already pinned in `docs/ACCESSIBILITY.md`
  - Existing Vitest + jsdom harness in `@openbot/web` (`apps/web/src/test/render-component.tsx`)

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Keep large Starter cards (axe CI runner; translation checker) | Current `docs/CONTRIBUTOR_TASKS.md` at baseline | MIT docs | No implementation yet; each requires tool selection, CI artifacts, and multi-file contracts | Too wide for a first independent PR; overlaps ACCESSIBILITY known gaps and `check-docs` evolution | Demote to Intermediate |
| Split into tiny Starter regressions against existing Web dialogs/tabs | Baseline Web sources above | MIT | Reuses AttachmentsManager / ChannelMembersMenu test patterns already in-repo | One behavior + one missing regression each; no new authority surface | Select for four Starter cards |
| Invent metrics or “completed starter count” dashboards | None | n/a | No repository evidence | Contributor-churn fiction | Reject |

## Reuse decision

- Selected option: local documentation gap — restructure contributor task cards only.
- Selected upstream or standard: existing WAI-ARIA / native `<dialog>` baseline already recorded in
  `docs/ACCESSIBILITY.md`; existing Vitest jsdom helpers.
- Why this is the first viable option: the baseline already implements the behaviors; the missing
  pieces are independently completable regressions and checklist updates, not new subsystems.
- Exact OpenBot-specific gap: Starter section previously pointed contributors at multi-tool CI
  projects; small real gaps (Create Bot dialog lifecycle, profile tab DOM keyboard, RunInspector
  Escape/focus, Node manager dialog lifecycle) were not listed despite existing source/tests.
- Upgrade, replacement, or exit plan: when a Starter card is delivered, mark it Delivered in
  `CONTRIBUTOR_TASKS` and keep Intermediate a11y/translation tooling proposals until research selects
  pinned tools.
- Failure behavior when the upstream is missing: N/A for this docs change; listed vitest commands
  fail closed if a contributor’s new test regresses.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none
- Required copyright or license notice location: none

## Verification plan

- Automated tests: `npm run docs:check` for this documentation PR; each Starter card lists the
  focused `@openbot/web` vitest command the implementer must add/run.
- Negative and fail-closed tests: each card’s acceptance counter-examples (Escape leaves dialog
  mounted; ArrowRight changes selection without focus; Escape does not call `onClose`; cancel does
  not restore opener).
- Platforms and devices: jsdom unit/integration only for Starters; no WCAG, screen-reader, or
  hosted CI matrix claim.
- User-visible documentation and translations: `docs/CONTRIBUTOR_TASKS.md` + `.zh-CN.md` and this
  research pair stay in sync.
- Support level that the evidence permits: contributor onboarding documentation accuracy at the
  inspected baseline SHA; not a claim that the four regressions already exist.

## Unresolved questions

- Whether Run Inspector should later migrate from a custom `role="dialog"` overlay to native
  `<dialog>` remains an Intermediate / ACCESSIBILITY known-gap item, outside the four Starters.
- Automated accessibility runners and translation consistency checkers remain Intermediate until
  separate research pins tools and licenses.
