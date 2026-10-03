# C22–C24: storage cleanup follow-ups

English · [简体中文](storage-cleanup-follow-ups.zh-CN.md)

- Status: Proposed
- Date: 2026-10-03
- Owner: @yxflc11
- Related issue: follow-up to C21 (#164) and its UI (#169)
- Acceptance journey: in 设置 › 存储空间 the Owner empties every channel's 回收站 with one
  confirmation, sees how much browser data each Bot keeps on its working computer, and from any
  kept file in 回收站 opens the messages and tasks that still reference it.
- Security boundary: Owner-only reads and one confirmed Owner-only deletion. The 服务电脑 stays
  the only authority for eligibility, references and audit. Remote Worker measurements are
  reported facts, never estimates, and never become a deletion grant.

## Trigger and existing decision

- Trigger: public protocol (three new or extended commands) and the persistent-data boundary of
  [C21](channel-storage-purge.md).
- Existing decision and reviewed pin: C21's private file catalog, staging journal, per-file audit
  and `attachment_cleanup_receipts`; C19's bounded single-snapshot
  [reference counts](channel-attachment-reference-counts.md); C6 browser maintenance over the
  pinned MIT `agent-computer` `257c1280` (see [the C6 record](desktop-browser-management.md)).
- Changed assumption or precise missing evidence: the SettingsStorage and ChannelFilesTrash boards
  need three facts that no route provides. Step 25 (#169) therefore ships three documented
  deviations: 清空回收站 is per channel only, 浏览器数据 is absent, and there is no 查看引用.
- Scope of this targeted review: those three gaps only. C21 deletion safety, receipts and audit
  stay as they are.

## Search evidence

- Search date: 2026-10-03.
- GitHub queries: the pinned `agent-computer` sources (`src/profiles.ts`, `src/bot-id.ts`, HTTP
  routes) through the GitHub contents API, to find the per-Bot profile directory and any usage
  route.
- Standards and primary documentation: RFC 9110 (idempotent retry of a non-idempotent POST under
  a client key, as C21 already applies).
- Existing OpenBot records checked: C21, C19, C6, the C18 message paging contract in `docs/API.md`,
  and the `agent-computer` row of `OPEN_SOURCE_REUSE.md`.

## Findings

1. **Global 清空回收站.** `StorageService.cleanup` already removes a list of recycled files in one
   Owner transaction under the private file lock. It only filters by one channel and keys its
   receipt by `(channel_id, request_key)`. The daily 30-day pass already walks every active
   channel. A client loop over channels would need one request and key per channel, could stop
   halfway with no single result, and cannot show exact numbers in its confirmation. `/storage`
   reports `referencedFileCount` but not the size of the files that would stay.
2. **Browser data.** Each Bot's Chromium profile is a directory on the `agent-computer` volume
   (`profileDirectoryFor(botId)`, one per Bot, on the Worker's machine). The pinned upstream exposes
   `/health`, `/computers/stop` and `/computers/reset`, but nothing reports a profile's size. The
   Docker Provider talks to it over HTTP and has no access to the volume. The Server cannot measure
   a remote disk, so C21 correctly returns `workingComputerBrowserData: null`.
3. **References.** The C19 query only counts, by design. It matches
   `[OpenBot attachment: <id>]` in a channel's messages and Run instructions. Showing *which*
   messages and tasks needs a listing. The UI can already page older messages (C18) and scroll to a
   loaded message (`showMessage`), and it already opens 任务详情 by Run id.

## Candidate comparison

| Gap | Candidate | Fit | Decision |
| --- | --- | --- | --- |
| Global cleanup | Client loop over per-channel cleanup | No single receipt or result; partial outcomes; inexact confirmation | Rejected |
| Global cleanup | `POST /api/v1/storage/trash/cleanup` reusing `_remove` over every active channel, with one global receipt | One confirmation, one replayable result, same safety | **Selected (C22)** |
| Browser data | Docker Provider measures the volume itself | It has no volume access, and adding the Docker socket widens authority | Rejected |
| Browser data | `docker system df -v` on the Worker | One total for the volume, no per-Bot figure, slow, needs the Docker socket | Rejected |
| Browser data | Upstream `agent-computer` reports bounded per-Bot profile bytes; `browser.maintenance@1` status carries them | Per-Bot, measured where the data lives, no new authority | **Selected (C23)**: upstream contribution first, narrow fork only if it is refused |
| References | Include message text in the C19 count response | Makes every file listing heavy | Rejected |
| References | Owner-only listing per attachment with a short preview | Bounded, on demand, same authority as reading the channel | **Selected (C24)** |
| References | A new `around=<messageId>` page for jumping | Needs gap handling in the conversation window | Deferred; the UI pages back a bounded number of C18 pages instead |

## Proposed contracts (for Codex)

- **C22 — global 清空回收站.**
  - `POST /api/v1/storage/trash/cleanup` with `{requestKey}`. It returns
    `{removed, retained, retainedCount, retainedHasMore, freedBytes, channelCount}`, using C21's
    item shape.
  - It covers recycled files of active channels only. Referenced files stay, and each removal is
    audited per file with `reason: empty_trash_all`.
  - The receipt is keyed by `requestKey` alone: a retry with the same key replays the result and
    touches nothing new. The same limits as C21 apply, and an unknown reference refuses the whole
    request.
  - `/storage` `trash` adds `referencedSizeBytes`, so the confirmation can state the exact size to
    be removed.
- **C23 — browser profile size.**
  - Upstream `agent-computer` reports one Bot's profile bytes, measured with a bounded no-follow
    traversal. There is no path in the reply, and the size is `null` when the measurement is
    refused.
  - The `browser.maintenance@1` status result adds `profileBytes: number | null`.
  - Record the upstream PR, or the narrow fork pin, in `OPEN_SOURCE_REUSE.md`.
- **C24 — attachment references.**
  - `GET /api/v1/channels/:channelId/attachments/:id/references?limit=20`, Owner-only, returning:
    - `messages: [{id, createdAt, author: {kind: "owner" | "bot", botId?}, preview}]`, where
      `preview` is at most 120 characters with attachment markers removed;
    - `tasks: [{runId, title, status, createdAt}]`;
    - `messageCount`, `taskCount` and `hasMore`.
  - Newest first, using C19's matching rule. It covers recycled files too, never another
    channel's references, and reports nothing for a purged file.

## UI plan (Claude, after each contract lands)

- **C22:** 设置 › 存储空间 gets back 清空回收站… with the board's confirmation, then shows the
  result, including what was kept.
- **C23:** 设置 › 员工浏览器 shows each Bot's profile size after 查看状态. 存储空间 adds a separate
  「工作电脑上的浏览器数据」 row that measures on request. It is not added to the 服务电脑 total,
  because it lives on other machines.
- **C24:** 查看引用 › on a kept file opens the list. Choosing a message closes the dialog and scrolls
  to it, loading older pages up to a bound; choosing a task opens 任务详情.

## Reuse decision

- Selected option: local contract extensions (C22, C24) and an upstream contribution (C23).
- Exact OpenBot-specific gap: the three facts above. Nothing in C21 or C19 changes.
- Upgrade, replacement, or exit plan: if upstream rejects C23, pin a narrow fork limited to the
  usage route. Until a contract lands, the step-25 deviations stay documented in DESIGN.
- Failure behavior: a refused or unknown measurement shows as 「量不出」, never as 0; unknown
  references refuse deletion; an unclear cleanup is retried only with the same key.

## Source incorporation

- Source copied or substantially adapted: no.

## Verification plan

- Automated tests: Python route tests for C22 (replay, kept files, refusal on unknown references,
  per-file audit) and C24 (bounds, scope, preview trimming); the upstream and Provider test for
  C23; Web tests for each UI change.
- Negative and fail-closed tests: wrong channel, purged file, oversized limit, stale or missing
  Owner session, a Worker without the capability.
- Platforms and devices: macOS arm64 locally; the hosted Linux CI lanes.
- User-visible documentation and translations: `docs/API.md` (en/zh), DESIGN screen map.
- Support level that the evidence permits: Integrated, once each contract and its UI are merged.

## Unresolved questions

- Whether `agent-computer` upstream accepts a usage route, which decides between an upstream
  pin and a narrow fork for C23.
