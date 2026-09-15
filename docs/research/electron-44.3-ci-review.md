# Research: Electron 44.3.0 dependency review

[English](electron-44.3-ci-review.md) · [简体中文](electron-44.3-ci-review.zh-CN.md)

- Status: Reviewed; final integration CI required
- Date: 2026-09-15
- Related PR: #81
- Acceptance journey: Existing Desktop packaging, plugin isolation and native installation contracts pass with the reviewed runtime.
- Security boundary: Server authority, context isolation, sandbox, Node-disabled renderers, permission policy and package fuses remain unchanged.

## Evidence and reuse decision

Reviewed the existing Desktop foundation and reuse ledger, official v44.3.0 release (2026-09-08), annotated tag `a5d1c52118831d762385f34c1b3ffbcc4d99de58` pointing to commit `07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`, MIT license at that commit, and permission-lifecycle source/tests in upstream #53691. Existing Electron 44 support and packaging adapters remain the selected implementation; no framework replacement or fork is justified by this maintenance change.

The release retains embedded Node 24.20.0 and updates Chromium to 152.0.7977.78. Reviewed changes include narrower document-scoped file permissions and frame attribution, native dialog/process fixes and stricter worker Node-integration inheritance. The OpenBot security policy already disables Node integration in frames and workers and retains restrictive session handlers. No newly introduced API or debug environment option is enabled.

The exact npm lock record is Electron 44.3.0 with integrity `sha512-St9EV7F2VtYaYWD2qaAjBwUgKxx39eJOUsUJ5+/1113sqbVfNqv4Dbm/W1rN7qmYSPa+mWwR6yr+b7MfgjgVfQ==`. Synchronize its workspace declaration with the exact manifest pin. Preserve published package and bundled component notices. No upstream source copied or substantially adapted.

## Known issues and limits

The query `repo:electron/electron is:issue is:open 44.3.0` returned #53887 (PAC with standard custom schemes), #30650 (Linux file-transfer portal) and #52024 (frameless Linux X11 borders). #53887 reports remote renderer requests with a PAC script, while `session.fetch` succeeds; it provides no last-known working version. OpenBot uses a standard custom scheme, so this is relevant context, not proof of immunity. No custom PAC adapter is configured in the source inspected, and current CI does not establish enterprise PAC support. Do not broaden network/platform claims from passing baseline tests. The other issues do not establish a new blocking regression in the existing tested workflow.

## Verification plan

Upstream permission source and regression assertions were inspected, not executed locally. PR #81's existing eight non-research jobs passed, including real native plugin isolation and Windows installation/cold-start checks. Its research metadata and final aggregate failed; these old results do not replace final combined-head checks.

Run a clean installation, exact-pin/lock consistency check and full `npm run check`, then hosted Linux/macOS/Windows packaging, plugin sandbox, Windows installation and ten cold starts on the integrated branch. Reject or revert the upgrade if these contracts fail; do not disable type checks, fuses, permission checks or native assertions.

## Primary sources

- [Release](https://github.com/electron/electron/releases/tag/v44.3.0)
- [Runtime component versions](https://releases.electronjs.org/release/v44.3.0)
- [Pinned license](https://github.com/electron/electron/blob/07e460719c75b2ec5ee4893f7d2192ef31c7b8c2/LICENSE)
- [Permission source and tests](https://github.com/electron/electron/pull/53691/files)
- [PAC issue](https://github.com/electron/electron/issues/53887)
