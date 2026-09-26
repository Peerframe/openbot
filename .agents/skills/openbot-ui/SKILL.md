---
name: openbot-ui
description: Change or inspect OpenBot Web/Desktop presentation and interaction using existing tokens, components and truthful product states. Use for UI work; not backend-only changes or a visual redesign without a brief.
---

# openbot-ui

## Inputs

Use the affected user action/page, expected result, current reference and supported viewport/state scope.

## Steps

1. Read [Web rules](../../../apps/web/AGENTS.md), [design entry](../../../docs/design/README.md) and
   the matching [map route](../../../docs/REPOSITORY_MAP.md#ui-interaction). Read only the relevant
   `INTERFACE.md` section and actual component/CSS/test; the historical office image is not a brief.
2. Reuse `apps/web/src/styles.css` tokens, native controls and the nearest component pattern.
   Confirm who owns data in `api.ts`, `work-api.ts` or the workspace hooks before changing callbacks.
   Client state never grants authority. Read Desktop rules when crossing preload/main.
3. Cover applicable loading, empty, pending approval, failure, offline/stale, read-only and delivery
   states using the design index's actual owners. Unknown outcomes cannot become success or automatic
   resubmission. An artifact record does not prove publication/download availability.
4. Run the component test and Web typecheck through the existing commands. For rendered changes,
   use the real page at wide and narrow widths, keyboard/focus and the changed states. Use synthetic
   data; document the fixture and actual viewport. A mocked test is not rendered acceptance.

## Output and stop conditions

Deliver the usable interaction, tests and rendered evidence with remaining limitations. If a needed
state/backend is unavailable, report it and continue independent checks. Stop a proposed redesign,
new permission or external action outside the requested scope. Preserve accepted design and user assets.
