# Research: Starter DOM regressions for Owner dialogs and profile tabs

- Status: Accepted for test delivery
- Date: 2026-09-23
- Owner: OpenBot contributors
- Related: depends on D3 / PR that splits Starter cards (`7b9b930140db8a3318c5d192ae8adf394385109e`); Draft follows that tip
- Acceptance journey: four Starter cards gain jsdom regressions that fail on the documented
  counter-examples without claiming WCAG, axe CI, or real-browser evidence
- Security boundary: Web Vitest/jsdom tests and bilingual status docs only; no Server authority,
  Runtime/Worker/snapshot/approval, package, or contribution-policy changes

## Search evidence

- Search date: 2026-09-23 (Asia/Shanghai)
- Baseline tip: `7b9b930140db8a3318c5d192ae8adf394385109e`
- Reused already-reviewed baselines (no new upstream selection):
  - WAI-ARIA APG tabs/modal dialog guidance pinned in `docs/ACCESSIBILITY.md`
  - HTML `dialog` technique H102 / native `showModal()` lifecycle via `useModalDialog`
  - React 19.3.0 + react-dom 19.3.0 (`apps/web` lockfile after `npm ci`)
  - Vitest 5.0.0 + jsdom 30.0.1 (root / web lockfile after `npm ci`)
  - Existing harness: `apps/web/src/test/render-component.tsx`
  - Existing Escape/opener pattern: `AttachmentsManager.test.tsx`
  - Prior research: `docs/research/contributor-starter-slices.md`,
    `docs/research/vitest-5-migration.md`, `docs/research/react-19.3-version-coherence.md`
- Exact installed versions verified after `npm ci` on this tip:
  - `react@19.3.0`, `react-dom@19.3.0`, `jsdom@30.0.1`, `vitest@5.0.0`

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Extend existing Vitest/jsdom component tests | Vitest 5.0.0 / jsdom 30.0.1 / React 19.3.0 | MIT | Already in CI for `@openbot/web` | Matches Starter acceptance; no new authority surface | Select |
| Add axe/Playwright a11y CI gate now | unselected | n/a | Requires tool pin + CI artifacts | Explicit Intermediate card; out of Starter scope | Reject for D4 |
| Treat jsdom focus as real-browser proof | n/a | n/a | jsdom lacks full dialog focus containment | Would over-claim ACCESSIBILITY baseline | Reject |

## Reuse decision

- Selected option: local gap — add/extend four component regressions using the existing harness
- Selected upstream or standard: reused WAI-ARIA / native `<dialog>` baseline already recorded;
  no new dependency
- Why first viable: behaviors already implemented; missing pieces are independently completable
  regressions and checklist/status updates
- Exact OpenBot-specific gap: CreateBotDialog had no test; EmployeeProfileView lacked interactive
  keydown↔`aria-selected`/focus coupling; RunInspector Escape/focus untested; NodeManagerDialog
  never opened the `<dialog>` in tests
- Upgrade/exit: Intermediate a11y runner remains separate; RunInspector native `<dialog>` migration
  remains a known ACCESSIBILITY gap
- Failure when upstream missing: N/A; vitest fails closed on assertion regression

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none
- Required copyright or license notice location: none

## Verification plan

- Automated tests:
  - `npm exec --workspace @openbot/web -- vitest run src/components/CreateBotDialog.test.tsx`
  - `npm exec --workspace @openbot/web -- vitest run src/components/EmployeeProfileView.test.tsx`
  - `npm exec --workspace @openbot/web -- vitest run src/components/RunInspector.integration.test.tsx`
  - `npm exec --workspace @openbot/web -- vitest run src/components/NodeManagerDialog.test.tsx`
  - `npm --workspace @openbot/web run typecheck`
  - `npm run docs:check` / `npm run research:check` / full `npm run check`
- Negative and fail-closed tests: cancel leaves dialog mounted; ArrowRight selection without focus;
  Escape without `onClose`; create failure without `role="alert"`
- Platforms and devices: jsdom only; not real-browser or AT evidence
- User-visible documentation: bilingual ACCESSIBILITY checklist + CONTRIBUTOR_TASKS status
- Support level: Starter regression coverage at the inspected tip; not WCAG conformance

## Product bug found (not fixed in D4)

`useModalDialog` records `document.activeElement` as the opener inside its mount effect. Both
`CreateBotDialog` and `NodeManagerDialog` set `autoFocus` on an in-dialog field. In jsdom (and
likely when autofocus runs before the effect), the hook can capture the autofocused field instead
of the real opener, so cleanup focus restore does not return to the opening control.

Concrete repro (jsdom):

1. Focus a page button and open `CreateBotDialog` or `NodeManagerDialog`.
2. Observe focus move into the autofocused field.
3. Dispatch `cancel` or click the labelled close control so the dialog unmounts.
4. Observe `document.activeElement` is not the original opener (often `document.body`).

D4 regressions still lock showModal/`aria-*` labelling, cancel unmount, revoke confirmation copy,
create `role="alert"` failure messaging, profile tab focus+selection coupling, and RunInspector
Escape/`onClose`/close-name/focus restore (custom overlay path, unaffected by `useModalDialog`).
Product autofocus ordering is left for a follow-up; no cross-file product rewrite in this change.

## Unresolved questions

- Whether to capture the opener synchronously before `showModal` / defer autofocus until after the
  hook effect — product follow-up, outside D4 test-only scope.
