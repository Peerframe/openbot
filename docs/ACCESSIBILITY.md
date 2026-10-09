# Accessibility baseline

OpenBot is not claiming WCAG conformance yet. This document records the interaction patterns that
are implemented, the upstream work they follow, the checks that were run, and the gaps contributors
must not accidentally describe as complete.

## Upstream review

The 2026-09-04 employee-flow audit reviewed these maintained sources before changing local code:

| Source | Pinned baseline | License | Decision |
| --- | --- | --- | --- |
| [WAI-ARIA Authoring Practices](https://github.com/w3c/aria-practices/tree/7e4034b262bc0d25332e330d8a582aaf34113829) | `7e4034b2` | W3C Software and Document License | Adopt the normative roles, state relationships, roving focus, and keyboard behavior for tabs and modal dialogs. No example source was copied. |
| [Adobe React Spectrum](https://github.com/adobe/react-spectrum/tree/50279a10ab998572e240e44aa36f84a15c7c4f99) | `50279a10` | Apache-2.0 | Use as a mature React implementation reference. Do not add its component and styling stack for the current fixed rail tabs and native dialogs. No source was copied. |
| [HTML `dialog` WCAG technique H102](https://www.w3.org/WAI/WCAG22/Techniques/html/H102) | updated 2026-01-12 | W3C document license | Use the browser's `showModal()` implementation for focus containment, background inertness, Escape handling, and focus restoration instead of recreating a focus trap. |

The local code is deliberately small: OpenBot-specific tab state remains in the Bot information rail,
and a thin React hook connects the native dialog lifecycle to application state. If future flows
need nested overlays, async collections, orientation changes, or virtualized tabs, reassess React
Aria Components before extending the local implementation.

## Implemented baseline

- The Bot information rail (which replaced the separate employee profile page on 2026-10-06)
  exposes one `tablist`, four `tab` elements (详情, 工作, 资料库, 电脑), one labelled `tabpanel`, and
  a single tab stop for the selected tab.
- Left Arrow and Right Arrow move focus and activate the adjacent tab with wrapping at both ends;
  Home and End jump to the first and last tab. These are jsdom-tested; the rail has not yet had the
  manual browser pass described below.
- Create Bot, Create Channel, employee export, and employee import use native modal dialogs.
- Opening a modal moves focus inside it; Tab remains inside the modal; Escape closes it; closing
  returns focus to the control that opened it.
- Existing validation errors use `role="alert"`, background content becomes inert while a dialog is
  open, and icon-only close controls have accessible names.
- The former employee profile page and export review were manually checked in the Codex in-app
  browser at a desktop three-column layout and at `390 × 844` CSS pixels. That evidence predates
  the rail and does not cover it.

## Reproduce the checks

Run the deterministic repository checks:

```bash
npm --workspace @openbot/web test
npm --workspace @openbot/web run typecheck
npm run lint
```

Then verify the browser behavior:

1. Open a Bot's direct conversation with the right rail open.
2. Focus `详情`; use Right Arrow, Left Arrow, Home, and End; confirm focus, selection, and visible
   panel change together.
3. Open the rail's share button (分享 Bot 模板); confirm focus begins inside the dialog and
   background controls cannot receive focus.
4. Press Escape; confirm the dialog closes and focus returns to the share button.



Deterministic Starter DOM regressions (jsdom; not real-browser AT evidence):

```bash
npm exec --workspace @openbot/web -- vitest run src/components/Dialog.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/BotInfoRail.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/TaskSheet.test.tsx
npm exec --workspace @openbot/web -- vitest run src/components/NodeManagerDialog.test.tsx
```

These cover Create Bot dialog labelling / cancel unmount / create `role="alert"`, Bot rail tab
keyboard focus+`aria-selected` coupling, TaskSheet (任务详情) Escape/focus restore, and Node manager dialog
`showModal` / cancel unmount (including revoke confirmation copy).

## Known gaps

- VoiceOver/Safari, NVDA/Firefox or Chrome, and Orca/Firefox manual screen-reader matrices have not
  been run on real operating systems.
- Automated accessibility regression tooling has not been selected or integrated.
- Contrast, forced-colors, reduced-motion, text zoom, and 200%/400% reflow need explicit evidence.
- The Run Inspector and mobile navigation sheets still use custom overlay behavior and need the same
  upstream-first focus-management review.
- The interface text is currently Chinese-first; locale selection, translated accessible names,
  directionality, and pseudolocale testing remain planned.

An accessibility contribution must include the tested browser/assistive-technology combination,
before/after behavior, and a regression test where the repository toolchain can express it.
