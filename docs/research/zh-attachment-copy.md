# Research: Chinese UI copy for empty-PDF extract and original-save dialog

- Status: Accepted before implementation
- Date: 2026-09-13
- Owner: @yxflc11
- Acceptance journey: A Chinese Owner extracts an image-only or blank PDF and reads a Chinese
  reason that the file may be scanned or blank; saving the original opens a Chinese native
  dialog. Unknown Server errors do not become that scanned-PDF reason.
- Security boundary: Presentation only. Server English error text, 415/empty-extract rejection,
  original-byte retention, cancel/retry, parser, OCR, and permission checks stay unchanged.
  No success is invented.

## Search evidence

- Search date: 2026-09-13 (Asia/Shanghai)
- GitHub / docs queries: `repo:i18next/i18next fallback keys unknown error`,
  `electron showSaveDialog title buttonLabel`, `repo:electron/electron dialog.ts title`,
  existing OpenBot `nativeRunFailure` exact-key map
- Existing ledger and research checked: [empty attachment extraction](attachment-empty-extraction.md),
  [attachment processing](attachment-processing-completion.md),
  [channel attachment presentation](channel-attachment-presentation.md),
  Desktop application foundation (Electron 44.2.0), and the Native run error-code map in
  `apps/web/src/components/NativeRunControls.tsx`
- Primary sources:
  - [i18next fallback keys](https://www.i18next.com/principles/fallback): known code → specific
    copy; unknown → a generic fallback, never a sibling reason
  - i18next **26.4.2** / commit `4dba50f20669c3678db0812255716eb7693ad2da` (MIT); annotated tag
    `476a099636b478d250fb2c1af339bae1054d15c1`
  - Electron **44.2.0** `dialog.showSaveDialog` `title` / `buttonLabel` / `message`
    ([dialog API](https://www.electronjs.org/docs/latest/api/dialog)); tag object
    `369b0d9d3afdd5b8c0bdb0ad42391443947a7424` → commit `aa650d74597c652878629df0038a50485e156a09`
  - OpenBot `nativeRunFailure`: `messages[run.errorCode ?? ""] ?? run.errorMessage`

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Existing exact-key presentation map (`nativeRunFailure`) | OpenBot current `main` | MIT | In-repo; unknown codes keep the original message | Matches Chinese-first Web UI; no new package | **Selected** for extract-failure copy |
| Electron `showSaveDialog` title/buttonLabel/message | 44.2.0 / `aa650d74597c652878629df0038a50485e156a09` | MIT | Already pinned Desktop shell; sibling report/image/employee dialogs are Chinese | Same exclusive-create save path; Linux may hide `title` | **Selected** for dialog labels |
| i18next message catalog | 26.4.2 / `4dba50f20669c3678db0812255716eb7693ad2da` | MIT | Maintained fallback-key docs; would add a locale runtime for two strings | Repo has no i18n stack; interpolating raw Server English as keys is the same exact-map job | Rejected |
| Change Server errors to Chinese or add error codes | n/a | n/a | Would change API semantics | Task requires keeping Server error semantics | Rejected |
| Substring / `includes("PDF")` mapping | n/a | n/a | Would map password, timeout, or prefixed text to the scanned-PDF reason | Violates unknown-error honesty | Rejected |

## Reuse decision

- Selected option: local gap — exact English→Chinese map plus mechanical dialog translation
- Selected upstream or standard: existing OpenBot exact-key UI map; Electron 44.2.0 dialog labels
- Why this is the first viable option: the Web UI is already hardcoded Chinese; Native run
  failures already map known codes only. Two extract-failure sentences do not justify a new
  i18n dependency. Server English stays the canonical source string.
- Exact OpenBot-specific gap: `updateAttachment` forwarded Server `error` verbatim, so
  image-only/empty PDF extract showed English. The original-save `showSaveDialog` was left
  English while sibling dialogs were Chinese.
- Upgrade, replacement, or exit plan: if Server later emits stable error codes, replace the
  English keys with those codes; keep exact lookup. Dialog copy stays with the Electron API.
- Failure behavior: unknown or prefixed/suffixed Server text is shown unchanged and must not
  become the scanned-PDF Chinese reason. Failed extract still does not mark success or replace
  the original. Cancel still aborts without a success path.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none
- Required copyright or license notice location: existing Electron and repository notices; no new notice

## Verification plan

- Automated tests: exact PDF-empty and generic-empty maps; prefix/suffix/password/timeout/parser
  failures stay unmapped; `updateAttachment` 415 with the exact PDF string; AttachmentActions
  alert is Chinese and `onChange` is not called; unknown alert is not the scanned-PDF reason;
  cancel does not report success; desktop dialog helper is Chinese
- Negative and fail-closed tests: unknown English is not rewritten to a specific Chinese reason
- Platforms and devices: jsdom Web tests; Desktop unit test of dialog options (not a native GUI)
- User-visible documentation and translations: ATTACHMENTS.zh-CN.md already describes the
  empty-PDF reason; this change implements that UI copy. Research note has a Chinese counterpart.
- Support level that the evidence permits: not applicable (UI copy only)

## Unresolved questions

- None yet.
