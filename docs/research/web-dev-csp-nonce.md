# Research: Web Vite serve CSP nonce for styles

- Status: Accepted before implementation
- Date: 2026-09-13
- Owner: @yxflc11
- Acceptance journey: `npm run dev` in `apps/web` serves HTML whose CSP allows Vite-injected
  stylesheets/scripts via a matching nonce, so `document.styleSheets` is populated and UI CSS
  applies; production `vite build` / Desktop renderer HTML keep the existing strict meta CSP.
- Security boundary: change is **dev-serve only** (`command === 'serve'`, not `mode === 'desktop'`).
  Production and Desktop meta CSP stay without `'unsafe-inline'` and without a shipped fixed nonce.
  Plugin iframe sandbox CSP is untouched.

## Search evidence

- Search date: 2026-09-13 (Asia/Shanghai)
- GitHub / docs queries: `vite html.cspNonce`, `repo:vitejs/vite cspNonce`, Vite CSP guide
- Primary documentation:
  - [Vite `html.cspNonce`](https://vite.dev/config/shared-options.html#html-cspnonce) (type `string`)
  - [Vite CSP feature guide](https://vite.dev/guide/features.html#content-security-policy-csp): when set,
    Vite adds nonce attributes to script/style/link tags and injects
    `<meta property="csp-nonce" nonce="PLACEHOLDER">`; meta nonce is used in dev and after build when
    needed. Replace the placeholder on every HTML response, including development.
  - Pinned release: Vite **8.2.2** / commit `de1111ab0be00879b404e7ed3b2a80e264edddc1` (MIT)
  - Keep `@vitejs/plugin-react` **6.1.1**; no version bumps
- Existing OpenBot entries checked: official-site / Desktop foundation rows pinning Vite 8.2.2;
  `apps/web/index.html` CSP (`style-src 'self'`); plugin-app-sandbox CSP (out of scope)

## Candidate comparison

| Candidate | Exact release / commit | License | Maintenance, tests, fit | Decision |
| --- | --- | --- | --- | --- |
| Vite `html.cspNonce` + serve-only CSP meta rewrite | 8.2.2 / `de1111ab0be00879b404e7ed3b2a80e264edddc1` | MIT | Official API; stamps tags and meta; documented placeholder semantics | **Selected** for local serve |
| Add `'unsafe-inline'` to style-src (dev or prod) | n/a | n/a | Weakens XSS defense; contradicts “do not expand production CSP” | Reject |
| Remove CSP meta in `index.html` for all modes | n/a | n/a | Weakens production/Desktop | Reject |
| Public fixed development nonce | local | MIT | Predictable to an injected script; the dev listener binds all interfaces and proxies the actual Server | Reject; supersedes the initial fixed-nonce decision |
| Vite placeholder + final `server.transformIndexHtml` adapter | same pinned Vite | MIT | Awaits the complete upstream HTML pipeline, then fills a fresh cryptographic nonce without response interception or new dependencies | Select |

## Reuse decision

- Selected option: dependency API reuse (already pinned Vite) + thin local serve adapter
- Selected upstream: Vite 8.2.2 `html.cspNonce` and CSP guide behavior
- Why first viable: official, already locked; matches injected CSS/JS without `'unsafe-inline'`
- OpenBot-specific gap: each response needs a fresh nonce; meta CSP in `index.html` must list `'nonce-<same>'` on `script-src` /
  `style-src` during serve; Vite does not rewrite that meta `content` for us
- Upgrade / exit: keep the real-server hook-order regression test when upgrading Vite; remove the
  adapter if upstream adds a response nonce callback
- Failure behavior: missing, duplicate, or out-of-head CSP metadata fails the document transform;
  build/Desktop never register the plugin. The current standard Vite dev pipeline is covered;
  experimental `bundledDev` bypasses this upstream method and is not claimed.

## Pinned integration review (before revision)

The initial Grok-authored PR #62 (`d097c67d426b2dde4a53cf730fdf738a8ff7cd69`) reused
`html.cspNonce`; this revision retains that contribution and replaces its predictable literal.
The fixed value is not accepted as a development security boundary.

Inspected [Vite HTML middleware](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/node/server/middlewares/indexHtml.ts),
[HTML nonce hooks](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/node/plugins/html.ts),
and [dev client CSS updates](https://github.com/vitejs/vite/blob/de1111ab0be00879b404e7ed3b2a80e264edddc1/packages/vite/src/client/client.ts).
Vite runs even user `order: 'post'` hooks before its final nonce-attribute hook. Therefore a user
post hook alone cannot finalize all placeholders. The existing HTML middleware awaits the public
`server.transformIndexHtml` method before calculating response headers/body. A thin `configureServer`
adapter awaits that method, uses Node `crypto.randomBytes(24)` for each document, rewrites only the
existing app policy, and fills the placeholder after upstream processing. It does not mutate shared
Vite config or change CSS/React transforms, HMR transport, proxy routing, or sandbox middleware.
Move the development CSP meta ahead of Vite's head-prepended scripts so the policy also governs the
React preamble. Keep production/Desktop registration disabled. No upstream source copied.

## Source incorporation

- Source copied or substantially adapted: no
- Files: `apps/web/src/dev-csp-nonce.ts`, `apps/web/vite.config.ts` (local adapter only)
- Notices: existing Vite MIT via package; no new THIRD_PARTY text required

## Verification evidence (2026-09-13)

- `npm exec --workspace @openbot/web -- vitest run src/dev-csp-nonce.test.ts --maxWorkers=1`:
  13 tests passed. Real Vite 8.2.2 HTTP serving covers eight concurrent responses to `/`, an SPA
  route, `/?query=1`, and `/index.html?query=1`; each response has a distinct 192-bit nonce shared
  by its CSP, Vite nonce meta, React preamble, module scripts, and styles/links injected by a late
  test hook. Shared config keeps its placeholder. ETag revalidation returns a fresh nonce/body.
  Missing/duplicate/misplaced policy and missing head fail closed. The actual sandbox route equals
  `pluginProxyDocument()` byte for byte. Production/Desktop config excludes the adapter.
- `npm run typecheck --workspace @openbot/web`, `npm run build --workspace @openbot/web`, and
  `npm run build:desktop --workspace @openbot/web` passed. Inspected the actual eight files in each
  output directory: both entry policies equal the strict source policy, and no emitted file contains
  the development placeholder or previous fixed nonce. The generated sandbox files are identical.
- Browser plugin not available; used existing bundled Playwright 1.62.1 and headless Chromium
  **149.0.7827.55**, with no install or dependency change. The isolated fixture uses the actual
  web Vite config and source `index.html`, a synthetic React counter and a local CSS file. No
  Owner data, credentials, Server requests, or native desktop interaction. Temporary fixtures
  were removed; the reproducible script, logs, and screenshots remain outside the repository.
- At `http://127.0.0.1:57494`, 1280 × 900: initial computed background was `rgb(20, 90, 140)`,
  padding was `24px`, and one stylesheet carried the response nonce. Clicking the counter gave
  `Count 1`. Editing CSS changed the computed background to `rgb(180, 60, 30)` through HMR;
  editing the React component changed its heading while preserving `Count 1`. Restoring both
  files restored the initial appearance. Document identity and nonce stayed unchanged throughout,
  proving no full reload. At 390 × 844 the restored fixture had no horizontal overflow. Initial,
  updated, and mobile screenshots were inspected.
- No page exceptions, framework overlay, or `securitypolicyviolation` events occurred. Chromium
  still reports the pre-existing warning that `frame-ancestors` is ignored in a meta CSP; this
  change does not claim frame protection from that directive or alter it. Vite also reports its
  existing config-import extension migration warning. Neither warning was suppressed.

- Actual OpenBot entry `apps/web/src/main.tsx` also loaded at `http://127.0.0.1:57750` in the
  same headless Chromium, 1280 × 900. A test-only middleware returned `{ authenticated: false }`
  for the two auth-session reads and blocked all other API/health access before Vite's proxy;
  zero requests reached the real Server. The actual login page rendered 18 stylesheets whose
  nonces all matched. `.login-card` computed width `420px`, padding `38px 40px 34px`, border radius
  `14px`, and white background matched the product stylesheet. Screenshot inspected: no blank
  page, error overlay, horizontal overflow, page exception, or CSP violation. Only the existing
  `frame-ancestors` meta warning appeared. No product source was modified for this check.
- Full `npm run check` passed: Web 58 test files / 300 tests passed, including the 13 CSP
  regressions. Other workspace suites and builds passed or reused matching Turbo cache entries.
  Existing platform/database-dependent skips remain; 308 existing lint warnings and four infos
  were not changed. Documentation and research checks were rerun after recording this evidence.

## Remaining scope

This verifies the standard Vite development nonce/CSS/React HMR path on the tested Chromium,
plus real production/Desktop output inspection. It does not claim a full Owner workflow,
cross-browser conformance, native Desktop GUI testing, or experimental bundled development.
