# C22–C24: storage cleanup follow-ups

- Status: Contracts implemented; C23 Owner-approved narrow fork qualified
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
| Browser data | Upstream `agent-computer` reports bounded per-Bot profile bytes; `browser.maintenance@1` status carries them | Per-Bot, measured where the data lives, no new authority | **Selected (C23)**: Owner-approved narrow fork now; return to upstream after merge and qualification |
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
  - `/storage` `trash` adds `referencedSizeBytes`, so the confirmation can distinguish measured referenced
    and unreferenced trash bytes; concurrent changes and gone markers affect eventual freed bytes.
- **C23 — browser profile size.**
  - Upstream `agent-computer` reports one Bot's profile bytes, measured with a bounded no-follow
    traversal. There is no path in the reply, and the size is `null` when the measurement is
    refused.
  - The `browser.maintenance@1` status result adds `profileBytes: number | null`.
  - Record the upstream PR, or the narrow fork pin, in `OPEN_SOURCE_REUSE.md`.
- **C24 — attachment references.**
  - `GET /api/v1/channels/:channelId/attachments/:id/references?limit=20`, Owner-only, returning:
    - `messages: [{id, createdAt, author: {kind: "owner" | "bot" | "system", botId?}, preview}]`, where
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

- Selected option: local contract extensions (C22, C24) and the Owner-approved narrow fork (C23).
- Exact OpenBot-specific gap: the three facts above. Nothing in C21 or C19 changes.
- Upgrade, replacement, or exit plan: keep #730 open. After upstream merges the route, review and
  qualify the accepted upstream version/image, update the pin, and retire the narrow branch.
- Failure behavior: a refused or unknown measurement shows as 「量不出」, never as 0; unknown
  references refuse deletion; an unclear cleanup is retried only with the same key.

## Source incorporation

- Source copied or substantially adapted: yes, the separately deployed MIT agent-computer narrow
  fork preserves CopilotKit source and LICENSE. No upstream control plane enters this repository.

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

- None for this slice. Owner approved the fork on 2026-10-03; upstream acceptance is the exit
  condition, not a blocker.

## Implementation checkpoint (2026-10-03)

C22 and C24 backend contracts are implemented on `codex/c22-c24-storage-follow-ups` from
`dafc2e13`. Migration `0051_global_trash_cleanup` adds a separate global `storage_cleanup_receipts`
table keyed only by UUID, with a bounded JSON response and no channel foreign key; existing C21
channel receipts keep their namespace/lifetime. `channelCount` counts active channels with candidate
trash, including retained-only channels. Referenced trash bytes include metadata and derived text.
The existing `_remove` owns all staging, reference rechecks, SQL guards, receipts and per-file audit.
No cleanup authority is inferred from the measured size.

C24 uses one SQL statement for bounded counts and both newest-first lists. The optional ASCII
`limit` is 1–100 (default 20) per list; timestamp ties use descending C-collated ID. Task titles are
bounded to 160 code points. The Owner approved `author.kind: "system"` on 2026-10-03 because C19
already includes automatic system messages; labelling them as Owner would misrepresent authorship.
This is an accepted addition to the proposed author union above.

C23 is submitted as [CopilotKit/OpenBot #730](https://github.com/CopilotKit/OpenBot/pull/730),
against reviewed upstream `cb5dc32a44517622c6db4e527e61d3abb389b43c`, contribution commit
`46eb7af817027c5de4202846c73c43bbb2fa67b7`. The MIT contribution
adds authenticated `GET /computers/profile-usage` before session creation, selecting only the
validated `Bot-Id`. Linux descriptor-relative traversal anchors each directory via `/proc/self/fd`,
opens directories with `O_NOFOLLOW`, skips symlinks, refuses hardlinks/special files/device changes,
and detects directory replacement during observation. Bounds are 10,000 entries, depth 16, a
2-second cooperative deadline around filesystem operations, and one concurrent measurement.
Confirmed absent Bot directories return 0; errors, refusal, unsupported platforms or absent roots
return null. Regular files may change during a live observation; no atomic snapshot is promised.

Primary boundary evidence: [Node filesystem APIs](https://nodejs.org/api/fs.html) and
[Linux open(2)](https://man7.org/linux/man-pages/man2/open.2.html). `O_NOFOLLOW` only protects the
last path component, hence descriptor-anchored traversal instead of recursively joining untrusted
paths. The finite traversal limits and Provider request deadline bound ordinary work; stalled
kernel filesystem operations are not claimed to be preemptible by the cooperative deadline.

The earlier wait-for-upstream decision is superseded by the Owner decision below. Provider/status
wiring remains unchanged, with safe-integer validation and unknown/refused measurements as null.

Focused acceptance evidence: 52 real PostgreSQL/HTTP Python tests across storage purge, attachment
references and browser sessions; 3 protocol tests and 35 Docker browser/maintenance tests. Upstream
Linux tests passed 46 cases (one non-Linux test skipped), including the real authenticated HTTP route
without Chromium startup, using the existing `openbot-browser:257c1280` image with Bun 1.4.2.
macOS Bun 1.3.14 passed the unsupported-platform case with four Linux-only cases skipped.
No user database, paid model or production mutation was used. Integration and migration
qualification results, including limitations, follow below.

Migration qualification: the committed 52-entry SQL source `8946a480542683cb85bf1b6ebc7c4134a9b27630`
passed all 40 retained upgrade/restore cases and 8 cleanup cases. The
[checked-in result](../../experiments/s7-migration/evidence/global-trash-result.json) records exact
SQL/journal hashes; sealed histories and test logic are unchanged.

The actual Linux arm64 product image
`sha256:059fef02e0a3ea0a9b599953c6df20d1612ea34f74358e91a86181914c8e04b8`
passed `deploy/server/smoke-product.py`: all 52 migrations, real Owner HTTP, built Web, DOCX/PDF
and blank OCR initialization, invalid startup before schema creation, SIGTERM and restart with
original files/key retained. All owned containers/network/volume were removed. This was local
Docker VM evidence, with no configured Temporal engine or real model call, not hosted qualification.

Integration outcome: `npm run check` ran all preliminary gates through lint/typecheck, then failed
on an unchanged publisher CLI 30-second timeout. Its three tests passed alone. A serial Turbo test
retry passed Web (644), Docker Provider (67) and the other completed packages, but Desktop had
four timeouts in three unchanged files (530 passed, three skipped). Those three files passed all
15 tests with `--maxWorkers=1`. The interrupted Node suite was run separately with one Worker:
129 Vitest tests passed, three skipped, plus all 54 bounded-transport Node tests passed. Final
`npm run build` succeeded for all 18 tasks (five executed, 13 cached). Existing passing preliminary
gates were reused; the original aggregate check is recorded as failed, not relabelled green.

`npm run test:control:python` exceeded its existing 300-second suite deadline twice. The first run
also hit four SDK failures under concurrent load; all four passed on the second run. The second
completed 789 tests without a failed test before timing out in employee portability (1,039 collected,
two skipped). The interrupted module and all following modules were checked separately in owned
PostgreSQL: 301 tests completed, initially 288 passed and 13 failed because the temporary diagnostic
fixture omitted the original base Bot/Channel. Supplying that original fixture shape made all
13 reruns pass. These are supplemental results, not success of the default full command or its
post-pytest TS read-back assertions. Dedicated Worker/Temporal and hosted CI qualification remain
unrun. Documentation checks passed (12 tests and 576 Markdown files); research-check unit tests
passed (27), while the PR-event check correctly skipped outside a pull-request event.

Handoff: local backend/contracts, translations and tests are ready for review on the branch above;
the migration source commit is fixed in the qualification manifest. No product PR or deployment
was created in this C22–C24 slice; the explicitly requested upstream PR is open without reviews.
The unrelated pre-existing `output/` directory is untouched. No test or implementation writer is
left running. C23 no longer depends on acceptance/rejection of upstream #730; UI remains
the separate planned slice. Default full-command timeouts remain visible acceptance limitations.

## C23 Owner-approved fork and image (2026-10-03)

Owner explicitly decided to maintain the narrow branch without waiting for upstream #730. The
repository is [yxflc11/openbot-agent-computer-upstream](https://github.com/yxflc11/openbot-agent-computer-upstream),
branch `codex/c23-profile-usage-production`, commit `29a83c1932fb67398dd7a36fa80c473e0230a637`.
Its sole parent is production `257c1280d684089be9adb0b35cce262efc7064bf`; its sole change is the
transplant of contribution `46eb7af817027c5de4202846c73c43bbb2fa67b7`.

Conflicts: retain the production `sessionFor`, profile release callback and `PROFILES_DIR ??
"/profiles"` behavior. Add only the usage import/root alias and authenticated route before session
creation. Do not import the newer session, secret-masking, virtual-display or egress changes. The
newer `control-http.test.ts` does not exist in production: extract only the usage case and bounded
child-process fixture into `profile-usage-http.test.ts`. The traversal, unit tests and usage docs
are identical to the contribution. No dependency/lock/Dockerfile changes enter the fork.

MIT: Copyright (c) 2026 CopilotKit; retain the full fork root `LICENSE` and the image notice at
`/app/THIRD_PARTY_LICENSES/agent-computer.MIT`. The local Linux arm64 image is
`openbot-browser:29a83c1`, digest
`sha256:2efa5b5dd9edd7a37357413e7091f27c34e3e37eeb63d3643e5ddc8249dc5019`.
Build the exact fork checkout with `docker build -t openbot-browser:29a83c1 -f agent-computer/Dockerfile .`,
then add the license/provenance layer (no code replacement):

```dockerfile
FROM openbot-browser:29a83c1
COPY LICENSE /app/THIRD_PARTY_LICENSES/agent-computer.MIT
LABEL org.opencontainers.image.source="https://github.com/yxflc11/openbot-agent-computer-upstream"
LABEL org.opencontainers.image.revision="29a83c1932fb67398dd7a36fa80c473e0230a637"
```

The production source manifest/download fixture now uses this exact repository/commit and includes
the usage implementation's SHA-256; all other source hashes and dependency pins are unchanged.
The actual final image with Bun 1.4.2 passed 45 Linux tests (one non-Linux case skipped). The unchanged
Docker Provider connected to the actual image: one synthetic Bot measured 8 bytes, a hardlinked
profile returned null, an absent Bot returned 0, and no Chromium started. Authentication and the
image MIT notice were verified. Provider/status wiring is unchanged. Settings continues to show
「量不出」 for null; measured remote bytes stay outside the Server storage total.

Exit: leave [#730](https://github.com/CopilotKit/OpenBot/pull/730) open. After upstream merges the
route, review and qualify its exact commit/image, switch production and the fixture back to upstream,
then retire the narrow branch. This is local Linux arm64 image/Provider evidence; hosted Linux amd64
qualification and deployment to existing Worker computers are separate. No user profiles were used.
