# Research: @ai-sdk/openai 4.0.66 CI evidence

[English](openai-sdk-4.0.66-ci-review.md) · [简体中文](openai-sdk-4.0.66-ci-review.zh-CN.md)

- Status: Reviewed; complete CI required before merge
- Date: 2026-09-15
- Related PR: #76
- Acceptance journey: Validate the existing Dependabot update with complete research evidence and all current CI gates.
- Security boundary: Existing Server-side provider adapter; model output stays untrusted and Server authorization/approvals remain authoritative.

## Evidence and reuse decision

Reviewed the existing [reuse ledger](../OPEN_SOURCE_REUSE.md), [baseline](task-flow-refactor.md), the PR package/lock changes, published npm metadata, and [official upstream evidence](https://github.com/vercel/ai/commit/9ed46d2da5df1394079c66d422bc553fd0c34376).

The official release commit updates the package to 4.0.66 and records batch request validation, image batches, optional search includes and JSON Schema compatibility changes. npm metadata requires Node >=22, compatible with CI 22.22.2. The release also updates provider/provider-utils; the existing committed lockfile remains the exact dependency closure. `repo:vercel/ai is:issue is:open 4.0.66` returned no matches; this is not proof of no bugs. Existing provider, Server policy, tool-approval and integration tests remain required.

| Candidate | Exact reviewed release or commit | License | Decision |
| --- | --- | --- | --- |
| Existing released dependency | @ai-sdk/openai 4.0.66; 9ed46d2da5df1394079c66d422bc553fd0c34376 | Apache-2.0 | Retain the Dependabot patch and validate existing contracts |
| Local replacement or fork | None selected | Not incorporated | No implementation gap justifies replacing the maintained dependency |

The gap is missing PR research evidence. Keep the existing upstream dependency and locked checksums; this follow-up changes documentation only. Revert the entire dependency bump if compatibility fails, without weakening tests or security checks.

## Failure and verification

[Original CI](https://github.com/Peerframe/openbot/actions/runs/34935933346) failed the research gate with `missing the 'Open-source research' section`. Record these fields in the PR body and push this research note to create a fresh pull-request event containing the updated body. A rerun of the original event must not be treated as proof that new metadata was consumed.

Run the actual PR-event research validator and documentation check locally. The new CI must run `npm run check`, security audit, native platforms, database and both Server container architectures before acceptance. The original run's passing jobs do not replace current-head verification. No new platform support is claimed.

## Source incorporation

No upstream source copied or substantially adapted. Published dependency license files and existing notices remain intact. This is an evidence update for an existing package, not a new runtime capability.

