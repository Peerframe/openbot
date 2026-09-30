# Usable Agent delivery evidence — September 7–8, 2026

[English](DELIVERY_WORKLOG.md) · [简体中文](DELIVERY_WORKLOG.zh-CN.md)

Historical evidence for [PR #19](https://github.com/Peerframe/openbot/pull/19), starting from
`8868da1`. This is not the current implementation backlog or release qualification. The
[delivery status](DELIVERY_STATUS.md) preserves the milestone's behavior and limits; use the
[current repository map](REPOSITORY_MAP.md) and [contributor tasks](CONTRIBUTOR_TASKS.md) for current work.
The [original journal](https://github.com/Peerframe/openbot/blob/6f8b6697eec815e3d54ee739dfae3bf0eb7000b0/docs/DELIVERY_WORKLOG.md)
retains intermediate commits, checks, the first DMG hash and the detailed chronology.

## Reusable findings and evidence

| Area | Verified at this milestone | Constraint or unresolved evidence |
| --- | --- | --- |
| Installers and notices | Actual macOS DMG mount, ASAR/fuses, native resources and licenses; native installer CI on three platforms; Linux failed-copy/retry/concurrent-target fixtures | Notices must come from Packager's extracted runtime, including nested app layout. Public release, signing/notarization, source correspondence and real-device qualification were separate gates. See [installation research](research/desktop-installable-delivery.md). |
| Download safety | Nine offline PowerShell 7.5.0 cases; hosted fixtures under Windows PowerShell and pwsh; Linux coreutils no-clobber variants | Preserve redirect denial/count, streamed bounds, existing targets and cancellation during body transfer. curl before 8.4 cannot bound unknown-length bodies: reject before networking and keep the manual-download fallback. |
| Report delivery | Real built Web/Server/PostgreSQL: login, UTF-8 filenames, provenance, authenticated download, unauthenticated 401, reload retention; 12 database cases | Sources and models were deterministic fixtures. Local DNS mapped public sites to reserved `198.18.*`; the reader correctly refused before connecting. Public HTTPS success remained unverified; never relax private-address denial for that network. |
| Native save | Actual Electron renderer/preload/main/Server/disk path, matching provenance and overwrite refusal | Retain the artifact-UUID-only bounded authenticated fetch, global browser-download denial and exclusive new-file creation. QA intercepted save-dialog selection; it did not certify an uninstrumented OS dialog. |
| Execution and usage | Real UI stop/resubmit, distinct task/history and provider-reported usage; 16 PostgreSQL cases | Resubmit creates a new task. Fixed timeout/Server-denial categories discard upstream stream errors. Token fixtures and durable cancellation do not prove live billing or checkpoint resume. |
| Reviewed memory | 273 Server tests including 22 PostgreSQL cases; real edit/accept/reject, next-task use, revoke, reload and wide/narrow UI | Sharing defaults off; snapshots are bounded and revision-bound; private/revoked memories stay excluded. No paid inference or autonomous skill-execution claim. Later skill work is linked in the status page. |
| Model settings | OpenRouter 3.0.0 metadata verification, persistence/reload and secret-free summaries; public catalog HTTP 200 | Inference stayed simulated. Preserve routing restrictions, private encrypted configuration and workspace drafts. |
| Desktop event streams | Packaged ASAR memory/revoke flow, four distinct reports separated by reloads, four further reloads, zero page errors | Stale SSE connections exhausted request slots. Pinned Electron source and upstream issue 47097 informed single-window ownership; abort streams on navigation/replacement/Server switch/exit/close. Isolated identity and dialog overrides are not signed-app evidence. |

The credential scanner stayed strict: a synthetic negative-test URL was constructed at runtime;
upstream errors and test fixtures did not justify weakening secret checks. The local DMG at the
installer-hardening checkpoint lacked the Worker companion; native CI packaged it. A package build
alone does not prove real-device installation, and simulated providers do not prove live paid work.

## Historical final checks

- Runtime `cb718fc`: [CI 34155768881](https://github.com/Peerframe/openbot/actions/runs/34155768881),
  all nine jobs passed. Three installer and three portable artifacts had 14-day retention; this is
  historical evidence, not a promise that those artifacts remain downloadable.
- Documentation `688fefb`: [CI 34156245222](https://github.com/Peerframe/openbot/actions/runs/34156245222),
  all nine jobs passed. Downloaded installer files were checked against version, source, size and
  SHA-256. The later curl minimum-version guard and negative fixtures passed the repository check.
- The actual UI journeys used the built application, real Server/database and isolated credentials;
  source/model responses remained fixtures. Temporary processes/data were removed. No public release
  or paid model call occurred in this delivery.

Current acceptance must use its own candidate revision and applicable checks; do not repeat these
old runs as fresh evidence or recreate the completed delivery sequence.
