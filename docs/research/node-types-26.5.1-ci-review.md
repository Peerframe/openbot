# Research: @types/node 26.5.1 CI evidence

[English](node-types-26.5.1-ci-review.md) · [简体中文](node-types-26.5.1-ci-review.zh-CN.md)

- Status: Reviewed; complete CI required before merge
- Date: 2026-09-15
- Related PR: #74
- Acceptance journey: Validate the existing Dependabot update with complete research evidence and all current CI gates.
- Security boundary: Development declarations only; CI and production Node runtime versions remain unchanged.

## Evidence and reuse decision

Reviewed the existing [reuse ledger](../OPEN_SOURCE_REUSE.md), [baseline](dependency-ci-september12.md), the PR package/lock changes, published npm metadata, and [official upstream evidence](https://www.npmjs.com/package/@types/node/v/26.5.1).

Downloaded the exact npm tarball without executing scripts and inspected package.json, LICENSE and index.d.ts. It requires TypeScript 5.6 or later, retains undici-types ~8.9.0, and preserves the Node documentation notices. Project TypeScript 7.0.2 satisfies the declared minimum. The GitHub query `repo:DefinitelyTyped/DefinitelyTyped is:pr node 26.5.1` returned no matches; the published version and integrity identify this review instead of an unverified source commit.

| Candidate | Exact reviewed release or commit | License | Decision |
| --- | --- | --- | --- |
| Existing released dependency | @types/node 26.5.1; npm 26.5.1; integrity sha512-CzNm2FezW4VR/LjG6yUdiEgLE/rAQ9Slj5gCu/C2VrdcW7I0ahNZ8DRbHT7zOZ6r3ONgd/bsQIeSaoDGrd1C6g== | MIT | Retain the Dependabot patch and validate existing contracts |
| Local replacement or fork | None selected | Not incorporated | No implementation gap justifies replacing the maintained dependency |

The gap is missing PR research evidence. Keep the existing upstream dependency and locked checksums; this follow-up changes documentation only. Revert the entire dependency bump if compatibility fails, without weakening tests or security checks.

## Failure and verification

[Original CI](https://github.com/Peerframe/openbot/actions/runs/34935880988) failed the research gate with `missing the 'Open-source research' section`. Record these fields in the PR body and push this research note to create a fresh pull-request event containing the updated body. A rerun of the original event must not be treated as proof that new metadata was consumed.

Run the actual PR-event research validator and documentation check locally. The new CI must run `npm run check`, security audit, native platforms, database and both Server container architectures before acceptance. The original run's passing jobs do not replace current-head verification. No new platform support is claimed.

## Source incorporation

No upstream source copied or substantially adapted. Published dependency license files and existing notices remain intact. This is an evidence update for an existing package, not a new runtime capability.
