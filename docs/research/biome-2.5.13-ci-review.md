# Research: @biomejs/biome 2.5.13 CI evidence

[English](biome-2.5.13-ci-review.md) · [简体中文](biome-2.5.13-ci-review.zh-CN.md)

- Status: Reviewed; complete CI required before merge
- Date: 2026-09-15
- Related PR: #73
- Acceptance journey: Validate the existing Dependabot update with complete research evidence and all current CI gates.
- Security boundary: Development lint/format tooling; no application authority or runtime change.

## Evidence and reuse decision

Reviewed the existing [reuse ledger](../OPEN_SOURCE_REUSE.md), [baseline](deps-patch-hono-biome-types-filename.md), the PR package/lock changes, published npm metadata, and [official upstream evidence](https://github.com/biomejs/biome/blob/810ea565b87dc639b64805ebadb2e7d68b9d7cc7/packages/%40biomejs/biome/CHANGELOG.md).

The published changelog includes type-inference performance repairs and rule corrections. The package and all eight native optional binaries are pinned to 2.5.13. Node >=14.21.3 fits CI Node 22.22.2. Existing recommended rules stay enabled; nursery rules are not newly enabled. The open-issue query `repo:biomejs/biome is:issue is:open 2.5.13` returned reports including #11782, #11744, #11745 and #11786. These remain upstream caveats; the complete lint gate must pass before integration.

| Candidate | Exact reviewed release or commit | License | Decision |
| --- | --- | --- | --- |
| Existing released dependency | @biomejs/biome 2.5.13; 810ea565b87dc639b64805ebadb2e7d68b9d7cc7 | MIT OR Apache-2.0 | Retain the Dependabot patch and validate existing contracts |
| Local replacement or fork | None selected | Not incorporated | No implementation gap justifies replacing the maintained dependency |

The gap is missing PR research evidence. Keep the existing upstream dependency and locked checksums; this follow-up changes documentation only. Revert the entire dependency bump if compatibility fails, without weakening tests or security checks.

## Failure and verification

[Original CI](https://github.com/Peerframe/openbot/actions/runs/34935873986) failed the research gate with `missing the 'Open-source research' section`. Record these fields in the PR body and push this research note to create a fresh pull-request event containing the updated body. A rerun of the original event must not be treated as proof that new metadata was consumed.

Run the actual PR-event research validator and documentation check locally. The new CI must run `npm run check`, security audit, native platforms, database and both Server container architectures before acceptance. The original run's passing jobs do not replace current-head verification. No new platform support is claimed.

## Source incorporation

No upstream source copied or substantially adapted. Published dependency license files and existing notices remain intact. This is an evidence update for an existing package, not a new runtime capability.

