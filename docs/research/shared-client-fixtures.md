# Research: deterministic shared-client fault fixtures

- Status: Accepted
- Date: 2026-09-22
- Owner: OpenBot maintainers
- Related issue: development track C2
- Acceptance journey: a fresh contributor opens one isolated local entry and exercises approval waiting, tool failure, cancellation, partial output, artifacts and reconnect in the actual shared Web/Desktop components without a Server, private environment or paid model.
- Security boundary: fixtures replace only their own document's Fetch/EventSource before product UI imports; unknown requests fail closed and CSP forbids connections. They have no production Owner session or execution authority.

## Search evidence

- Search date: 2026-09-22.
- GitHub queries: `site:github.com/mswjs/msw release v2.15.0 browser service worker tests`; inspected [Vite 8.3.0 release](https://github.com/vitejs/vite/releases/tag/v8.3.0), its `playground/multiple-entrypoints`, HTML middleware and MIT license, and [MSW 2.15.0 release](https://github.com/mswjs/msw/releases/tag/v2.15.0), package test scripts and issue tracker. The Vite coherence review's open-issue query is reused; no dependency upgrade is required.
- Primary documentation: [Vite HTML/multiple-entry builds](https://vite.dev/guide/build), [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore), [WHATWG EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html).
- Existing evidence: reuse ledger official website demo, ordered workspace state and React runtime coherence; `website-component-demo.md`, `workspace-snapshot-stream.md`, `vite-8.3-lock-coherence.md`, `react-19.3-version-coherence.md`, `web-dev-csp-nonce.md`; demo adapter/component tests and actual ChannelWorkspace/API reconnect implementation.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| WHATWG Fetch/EventTarget/EventSource contracts | Living standard, reviewed 2026-09-22 | WHATWG document terms | Native browser primitives used by the current API | Named events/error handlers exercise the existing subscriber; no persistent worker | Reuse standard boundary |
| Existing OpenBot isolated component demo | `2cc32d0` | MIT | Existing adapter and real-component tests, prior rendered verification | Already denies unknown/foreign endpoints and isolates browser storage; genuine shared components | Extend through narrow protected fixture hooks |
| React / React DOM | 19.3.0 / `1d34f91dfde6bba84d08b683aaba164c7194dacb` | MIT | Matched runtime and upstream renderer test review retained | Stable external-store snapshots, existing product renderer | Reuse pinned dependency |
| Vite | 8.3.0 / `434e8e9495436a60789f2b588a04a6a24a3d1661` | MIT | Published release, HTML/multiple-entry playground tests, existing strict-CSP review | Explicit independent HTML build; regular Web/Desktop entry unchanged | Reuse pinned dependency |
| MSW | 2.15.0 | MIT | Browser/node/unit suites and active issue tracker | Good for a broader API, but a service worker adds persistent origin state for this already-isolated surface | No new dependency; retain existing adapter |

## Reuse decision

- Selected option: browser standards, existing released dependencies and a thin extension to the existing local fixture adapter.
- Exact gap: the existing demo illustrates successful collaboration but cannot select fault cases, expose an actual approval card, inject a connection error, or verify recovery from missed events. Add only those deterministic projections and explicit controls.
- Keep production `App`, authentication, Desktop bridge and Server APIs unchanged. The explicit `client-fixtures.html` entry can be built into its own output directory; normal Web/Desktop builds must exclude it. No query parameter in the production entry enables fixtures.
- Subclass the isolated demo adapter with bounded known scenario data and a post-validation request hook. Reuse actual ChannelWorkspace, Sidebar, ContextRail/ApprovalCard, RunInspector and artifact links/styles; do not redraw their UI.
- Use actual error events and the current 2-second reconnect timer; missed messages are recovered through the real channel read path. Manual scenario steps make results independent of model timing; expiry labels alone use a relative display clock.
- Development entry builds and previews the isolated page. Rebuild and reload after changes; no HMR. This preserves `connect-src 'none'` without loading Vite's development client.
- Replacement/exit: remove the standalone entry without touching production. Changes to product contracts must keep the fixture and actual component tests coherent; no support claim comes from fabricated transport data.
- Failure behavior: unknown fixture names, foreign origins, unrecognized writes and account/model/plugin endpoints are rejected; no fallback to the original fetch. Fixed downloads contain only public synthetic text. Storage is memory-only in that document.

### Development WebSocket verification

Actual Vite development serving with response-specific CSP nonces rendered all six scenarios, but `hmr: false` still injected a WebSocket attempt. Inspected the installed pinned Vite source (`clientInjections`, `server/ws`, browser client) and types, [official `server.ws`](https://vite.dev/config/server-options#server-ws), and GitHub search `repo:vitejs/vite hmr false ws false`. Even `ws:false` after a full restart disabled only the server transport in the observed build; the injected client still attempted connection and CSP correctly blocked it. Do not weaken CSP or patch upstream client code. The final supported command uses the already-verified Vite build plus preview APIs; contributors rebuild and reload, with no HMR or dev nonce adapter.

## Source incorporation

- No upstream source copied or substantially adapted. Existing MIT OpenBot component and adapter code is reused directly; dependency notices remain unchanged.

## Verification plan

- Adapter tests cover scenario resets, one-consumption approval, cancellation plus late output, synthetic artifact gating, disconnected reads and no-network fallback.
- Actual React component tests exercise official approval/cancel controls, partial text, failure details, artifacts and automatic reconnect after missed updates.
- Build and inspect regular Web/Desktop outputs to confirm the fixture entry and marker are absent. Run the existing demo regression suite and full `npm run check`.
- Use the existing bundled Playwright with an isolated Chrome profile without adding a dependency. Flow: isolated built fixture entry → scenario control/official action → expected official UI state. Capture desktop and narrow viewport, console errors, no-network evidence and synthetic download content outside the repository.
- English/Chinese module instructions document exact commands, scenario steps, evidence and limitations. Native Electron packaging/IPC, live Server auth, external effects and model quality remain unverified by these fixtures.

## Unresolved questions

- The production Desktop read-only snapshot proxy is outside C2; this entry does not expose or bypass it.

## Verification evidence (2026-09-22)

- `npm ci --ignore-scripts` and `npx turbo run build --filter=@openbot/web^...` passed without private configuration. No dependency or lockfile change.
- `npm exec --workspace @openbot/web -- vitest run src/client-fixtures src/demo --maxWorkers=2`: 4 files / 18 tests passed (12 new fixture tests and 6 existing demo tests). The reconnect component test verifies the final message is absent offline and appears after the real 2-second retry, not merely a fixture online flag.
- Web typecheck, isolated fixture build, ordinary Web build and Desktop renderer build passed. Actual regular output scans found none of `client-fixtures.html`, `fixture-approval`, the fixture heading or `.client-fixtures-root` in HTML/JS/CSS. Existing regular build chunk-size and extension migration warnings remain.
- The final exact development command `npm run dev:fixtures --workspace @openbot/web -- --port 5183` built and served the preview. Fresh isolated system Chrome driven by the existing bundled Playwright completed all six scenarios at 1440 × 960, followed by actual approval rejection at 390 × 844. The default preview on 5182 also passed all six scenarios. No console errors, page exceptions, real `/api/` requests or horizontal overflow occurred. The rendered title was `OpenBot 共享客户端夹具 · 合成数据`.
- Browser actions verified the official approval submission, fault inspector, cancellation then suppressed late output, duplicate/older partial output then final message, actual Blob download `OpenBot-发布介绍.md` with fixed report text, and offline completion absent from the channel until the native retry/refetch recovered it. Screenshots of approval, failure details, offline state and narrow approval were inspected. Fixed the wrapper's conflicting official grid row and missing favicon found during inspection.
- Browser verification used bundled Playwright plus installed Chrome, with a new temporary profile and no user session. Temporary scripts and screenshots are outside the repository (`/private/tmp/openbot-client-fixtures-dev-qa.cjs`, `/private/tmp/openbot-fixtures-dev-*.png`). Native Electron/IPC and live Server/model behavior were not exercised.
- Changed TypeScript/CSS/package files pass Biome, `git diff --check`, documentation checks (350 Markdown files), and research checks (17 tests). Full repository `npm run check` is delegated to the parent integration branch, per the track handoff, to include all four independently developed tracks once.
