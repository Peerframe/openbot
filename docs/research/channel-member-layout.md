# Research: channel member menu layout

- Status: Accepted for implementation
- Date: 2026-09-13
- Owner: OpenBot contributors
- Related issue: Owner-reported Desktop member-menu regression
- Acceptance journey: Open a channel's members, read each Bot identity, open its profile or remove it, and add an available Bot without clipped controls.
- Security boundary: Presentation only. Existing Server membership, cancellation, history retention and direct-channel restrictions stay authoritative.

## Search evidence

Reviewed the reuse ledger's channel interactions entry and [existing research](channel-interactions.md) before editing. The installed alpha.8 UI and the Owner's screenshot expose default browser buttons and clipped identity text. The component now wraps profile/removal buttons in a row, while its older CSS still requires a direct button child of the list.

GitHub queries on 2026-09-13: `repo:w3c/csswg-drafts flexbox automatic minimum size button overflow`. Reviewed [CSSWG issue 8502](https://github.com/w3c/csswg-drafts/issues/8502) and [6794](https://github.com/w3c/csswg-drafts/issues/6794), both closed, on overflow and intrinsic sizing. The maintained specification links its [Web Platform Tests](https://wpt.fyi/results/css/css-flexbox). Read the standard's automatic minimum sizing and flexible-length rules, and React's [stable list identity guidance](https://react.dev/learn/rendering-lists).

## Candidate comparison

| Candidate | Exact release or snapshot | License | Maintenance, tests and fit | Decision |
| --- | --- | --- | --- | --- |
| Native buttons and CSS Flexbox | [CSS Flexbox Level 1, 2025-10-14 CRD](https://www.w3.org/TR/2025/CRD-css-flexbox-1-20251014/) | W3C permissive document license | Standard browser layout, upstream WPT and sizing issues reviewed. Explicit shrinkable text and fixed avatar/action sizes fit Chromium on Desktop and Web. | First viable standard; no dependency. |
| Existing React component | React 19.2.8, `1dd4ecbdabf826f527fc9a58c05ea70375b7d170` | MIT | Existing exact-ID membership and failure tests; stable Bot keys. Retain native disclosure, buttons and select. | Reuse unchanged state and callbacks. |
| New menu/component package | Not selected | Not applicable | Does not repair stale local selectors; would replace functioning focus and membership behavior. | Unnecessary after the viable standard. |

## Reuse decision

Use explicit component classes for profile, identity and removal controls. Keep their styles with the component instead of splitting them between conversation history and reaction stylesheets. Make identity text shrink within the row; preserve the avatar and independent removal target. Names and roles may ellipsize, but full text stays accessible and available through native titles. Preserve focus visibility and Escape/outside dismissal. A rendered check also exposed the old right-aligned popup extending past the left edge when Desktop's sidebar is hidden; align it with the Desktop heading's left edge while retaining the narrow-screen fixed inset.

No source copied or substantially adapted; no upstream notices added. Existing React and browser standards remain replaceable without a new protocol or dependency.

## Verification plan

- Existing component tests for failed removal and direct-channel restrictions; profile callback and Escape focus behavior where affected.
- Actual rendered production component with the application's styles, long names/roles, empty/many members, and desktop/narrow viewports. Check identity visibility, clipping, focus and separate actions.
- `npm run check`; verify the installed Desktop entry after the integrated release. A fixture preview alone does not establish native release acceptance.
- Maintain the Chinese research counterpart and user-visible member-menu description.

## Unresolved questions

Grok's observable design advice is being requested separately. No claim about its private source, exact internal implementation, or complete pixel parity is made.
