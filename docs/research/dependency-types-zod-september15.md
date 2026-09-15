# Research: React DOM types and Zod updates

[English](dependency-types-zod-september15.md) · [简体中文](dependency-types-zod-september15.zh-CN.md)

- Date: 2026-09-15
- Status: reviewed; combined installation and CI required before merge
- Scope: [PR #79](https://github.com/Peerframe/openbot/pull/79) and [PR #80](https://github.com/Peerframe/openbot/pull/80)
- Acceptance: compile Web/Desktop and preserve rejection of invalid configuration, protocol
  envelopes and Server inputs. Zod is a production parser; React DOM types are development-only.

## Sources and exact selection

The existing [reuse ledger](../OPEN_SOURCE_REUSE.md) covers Node protocol input validation and
macOS Worker Host configuration. Historical pins remain dated review baselines.

| Released dependency | Reviewed source | License | Decision |
| --- | --- | --- | --- |
| `@types/react-dom` 19.3.0 | DefinitelyTyped [`de5e8f01d01a14ae4ae502283d3d09f042f1ad89`](https://github.com/DefinitelyTyped/DefinitelyTyped/commit/de5e8f01d01a14ae4ae502283d3d09f042f1ad89), [PR #75429](https://github.com/DefinitelyTyped/DefinitelyTyped/pull/75429) | MIT | Select: peer `@types/react ^19.3.0` matches existing React types 19.3.0 and the React/React DOM 19.3.0 runtime pair. |
| Zod 4.6.2 | [`e359f7378fe56d695134701cda1e9055a08892dc`](https://github.com/colinhacks/zod/tree/e359f7378fe56d695134701cda1e9055a08892dc) | MIT | Select subject to combined checks: existing Zod 4 API and ESM/CJS packaging, no declared production dependencies. |

Read the declaration diff and tests, exact-tag Zod parser and prefault regression tests, licenses,
Zod releases [4.6.0](https://github.com/colinhacks/zod/releases/tag/v4.6.0),
[4.6.1](https://github.com/colinhacks/zod/releases/tag/v4.6.1),
[4.6.2](https://github.com/colinhacks/zod/releases/tag/v4.6.2), and the
[compatibility guide](https://zod.dev/v4/changelog). Compared exact npm metadata with proposed
lockfiles; cached metadata was used when registry DNS was unavailable. GitHub API independently
resolved the Zod release tag. No upstream test suite was executed during research.

Published lock identities:

- `@types/react-dom@19.3.0`: `sha512-ZI7bU42mZXXKHn/qNLEw2IrbiINU7X5+vfgdixBHkCNpYWXjKgfQ/P+uyGb5CjOLB9UcnTeg3rylQtV2hym44Q==`.
- `zod@4.6.2`: `sha512-lh5RCAGFa1Cm2hjtNwLQhSs/AsqdWnTQaBER9fEwN/88pSh7KOtJavtBx/0VlkN/uFd61SwYmljLMDAsHlvzBQ==`.

## Compatibility, maintenance and issue review

The September 9 DefinitelyTyped update adds stable browser rendering declarations. Inspected
[tests](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/de5e8f01d01a14ae4ae502283d3d09f042f1ad89/types/react-dom/test/react-dom-tests.tsx)
cover root creation, server rendering, forms and `act`. OpenBot uses `createRoot(...).render(...)`;
this update introduces no runtime feature. Query `repo:DefinitelyTyped/DefinitelyTyped is:issue
is:open react-dom` included [version alignment #43962](https://github.com/DefinitelyTyped/DefinitelyTyped/issues/43962)
and older third-party type issues; it did not establish an applicable 19.3.0 blocker or absence of defects.

Zod 4.6 includes recursive parse memory cleanup and JSON Schema constraint fixes. Version 4.6.1
fixes defaulted discriminators and recursive inference; the September 10 release 4.6.2 fixes
undefined prefault outputs and object keys. The inspected
[parser](https://github.com/colinhacks/zod/blob/e359f7378fe56d695134701cda1e9055a08892dc/packages/zod/src/v4/core/parse.ts)
retains separate synchronous/asynchronous parsing and error construction. The
[prefault tests](https://github.com/colinhacks/zod/blob/e359f7378fe56d695134701cda1e9055a08892dc/packages/zod/src/v4/classic/tests/prefault.test.ts)
cover transformed undefined outputs, object keys and sync/async paths.

Project searches found `parse`/`safeParse`, strict objects, transforms, refinements and bounds;
no direct use of `prefault`, `compile`, `withParser`, `fromJSONSchema` or `toJSONSchema`.
Dependencies may convert schemas, so Server plugin integration remains part of acceptance.
Searches included `site:github.com/colinhacks/zod "v4.6.2"` and
`repo:colinhacks/zod is:issue is:open 4.6.2` (the latter returned no matches).
The broader issue review included compiled async/lazy behavior #6574,
[automocking #6486](https://github.com/colinhacks/zod/issues/6486), and recursive type depth #6015.
OpenBot does not opt into compiled parsing or automock Zod. Later 4.6.3–4.6.5 releases were screened
by the dependency reviewer; properties API changes and URL performance work did not identify a
blocker in observed calls. This decision does not pre-approve later versions.

## Reuse decision and security boundary

Reuse the existing released dependencies. A standard does not supply drop-in React declarations
or the existing Zod implementation; an adapter, fork or local parser has no demonstrated need.
Keeping 19.2.7 declarations leaves them behind the runtime pair; keeping Zod 4.5.4 omits reviewed
maintenance fixes. Those previous pins remain rollback options for a relevant regression.

The OpenBot-specific gap is exact manifest/lock synchronization and evidence. Preserve integrity
checks, peer checks, strict types and input rejection tests. Server identity, authorization,
routing, approvals and audit remain authoritative. Do not cast around failures or bypass parsing.
No new capabilities, copied or substantially adapted upstream source, or vendored files.
Retain distributed [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/de5e8f01d01a14ae4ae502283d3d09f042f1ad89/LICENSE)
and [Zod](https://github.com/colinhacks/zod/blob/v4.6.2/LICENSE) MIT licenses.

## Validation required

Run clean `npm ci`, inspect `npm ls @types/react @types/react-dom zod`, and run the complete
`npm run check` on the final combination. Preserve config/protocol rejection tests, Server
route/plugin tests, Web component tests and Web/Desktop builds. Hosted Linux/macOS/Windows
checks remain required. Record actual results and tested commits in the integration PR;
source inspection alone is not execution evidence or a new platform/security support claim.
