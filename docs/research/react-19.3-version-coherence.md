# Research: React 19.3 version coherence

- Status: Accepted; current-head CI remains required before merge
- Date: 2026-09-15
- Owner: @yxflc11
- Related issue: #75
- Acceptance journey: A fresh install imports the real React client and server renderers and passes the existing Web interaction suites on the supported CI platforms.
- Security boundary: Dependency maintenance only; Server authorization, renderer isolation, production audit, and all existing CI gates remain authoritative.

## Search evidence

- Search date: 2026-09-15.
- GitHub queries: `repo:react/react is:issue is:open 19.3.0`; inspected the official `v19.3.0` release, tag, source tree, renderer version guard, DOM/server integration tests and MIT license.
- Primary documentation queries: `site:react.dev warnings version mismatch react react-dom exact same version`; `site:docs.github.com dependabot groups react react-dom patterns`.
- Existing entries checked: Web component interaction tests and Desktop application foundation in `docs/OPEN_SOURCE_REUSE.md`, the September 12 dependency review, and PR #75 run [34935896797](https://github.com/Peerframe/openbot/actions/runs/34935896797).
- The failed Linux, macOS and Windows Web suites all report `react` 19.3.0 with `react-dom` 19.2.8. The upstream import-time guard requires exact equality, although the old npm peer range accepts newer React minors. This is an incoherent dependency update, not a test assertion to relax.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| React and React DOM | 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` | MIT | Official stable release dated 2026-09-09; version guard and `ReactDOMServerIntegrationElements-test.js` inspected | Existing browser/Electron renderer; matching runtime pair; no new capability | Select released dependency |
| React declarations | `@types/react` 19.3.0; existing `@types/react-dom` 19.2.7 | MIT (DefinitelyTyped) | Published declaration package; project typecheck and existing interaction suites validate use | Development-only; declaration patch/minor versions need not equal runtime versions | Retain PR update and compatible existing DOM declarations |
| GitHub Dependabot groups | Official `groups`/`patterns` contract reviewed 2026-09-15 | GitHub documentation terms | Maintained hosted configuration API; documented matching by exact package names | Group only React, React DOM and their declarations for future version updates | Select existing service option |
| Version-guard override, renderer fork, or alternate UI framework | None | N/A | Bypasses a tested upstream invariant or introduces unrelated migration | No missing renderer functionality justifies it | Reject |

## Reuse decision

Select the maintained released dependencies first. Pin `react-dom` to the PR's React version, 19.3.0, and regenerate the lockfile with the repository's npm 10.9.9 CLI. Keep React and both declaration packages in one narrow Dependabot version-update group. This reduces split update proposals; the installed renderer's own guard and existing CI still enforce compatibility.

The only OpenBot gap is coherent dependency selection. No local rendering implementation is needed. Review and upgrade the runtime pair together; revert the complete update if real suites fail. Keep the exact lockfile integrity and production audit. Missing or incompatible packages must fail installation, import, build or CI rather than bypassing the guard. Dependency installation and rendering do not grant Server authority.

## Source incorporation

- Source copied or substantially adapted: no.
- Files: `apps/web/package.json`, `package-lock.json`, `.github/dependabot.yml` and bilingual research/reuse records only.
- Required notices: retain the MIT licenses distributed with React, React DOM, scheduler and DefinitelyTyped packages.

## Verification plan

- Clean npm 10.9.9 installation; inspect installed runtime and declaration versions.
- Existing Web client/server-rendering and interaction tests, typecheck, production audit, and full `npm run check`.
- Existing negative and fail-closed tests remain unchanged, including Server authorization and native security assertions.
- Local macOS verification plus existing Linux x64, macOS arm64 and Windows x64 hosted CI. No new platform or accessibility claim follows from this update.
- Keep this research and the reuse ledger available in English and Simplified Chinese.

## Known issues and limits

The open-issue search returned upstream #37614 (Next.js ViewTransition navigation), #37560 (Flight decoding), #37556 (Suspense retry under `act`), #33038 (customizable select hydration), and #37551 (suspended head hydration). The patch does not adopt Next.js, Flight, hydration or new transition APIs. Existing interaction tests remain necessary for possible `act` regressions. Search results are not proof of an absence of upstream bugs. Upstream tests were inspected, not executed locally.

## Primary sources

- [React exact-version requirement](https://react.dev/warnings/version-mismatch)
- [React 19.3.0 release](https://github.com/react/react/releases/tag/v19.3.0)
- [Pinned version guard](https://github.com/react/react/blob/1d34f91dfde6bba84d08b683aaba164c7194dacb/packages/react-dom/src/shared/ensureCorrectIsomorphicReactVersion.js)
- [Pinned renderer integration tests](https://github.com/react/react/blob/1d34f91dfde6bba84d08b683aaba164c7194dacb/packages/react-dom/src/__tests__/ReactDOMServerIntegrationElements-test.js)
- [React DOM 19.3.0 package](https://www.npmjs.com/package/react-dom/v/19.3.0)
- [React declarations 19.3.0](https://www.npmjs.com/package/@types/react/v/19.3.0)
- [Dependabot group options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups)

## Local verification result

On 2026-09-15, a clean npm 10.9.9 install passed, the installed graph contained one React/React DOM 19.3.0 pair and scheduler 0.28.0, and the production audit reported zero vulnerabilities. Full `npm run check` passed on macOS arm64 with Node 22.23.2: all 59 Web test files / 329 tests passed, and Desktop passed 38 files / 359 tests with one existing platform-specific skip. Existing environment-dependent Server/Node skips remain covered by their configured hosted jobs. The initial sandbox run could not inspect native process identity or compile temporary native fixtures; the complete check passed when rerun with those OS operations permitted. Hosted current-head CI remains a separate required result.
