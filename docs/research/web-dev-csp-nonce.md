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
    needed. Replace the placeholder per request in real deployments.
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
| New middleware / proxy rewriting random nonces per request | custom | MIT local | Heavier than needed for contributor `vite` serve; fixed nonce OK when documented for dev-only | Defer; use fixed serve nonce |

## Reuse decision

- Selected option: dependency API reuse (already pinned Vite) + thin local serve adapter
- Selected upstream: Vite 8.2.2 `html.cspNonce` and CSP guide behavior
- Why first viable: official, already locked; matches injected CSS/JS without `'unsafe-inline'`
- OpenBot-specific gap: meta CSP in `index.html` must list `'nonce-<same>'` on `script-src` /
  `style-src` during serve; Vite does not rewrite that meta `content` for us
- Upgrade / exit: stay on Vite 8.2.2; if serve injection changes, drop the local transform or switch
  to per-request placeholder replacement behind a real HTML server
- Failure behavior: if the transform is skipped, styles stay blocked under strict CSP (fail closed);
  build/Desktop never register the plugin

## Source incorporation

- Source copied or substantially adapted: no
- Files: `apps/web/src/dev-csp-nonce.ts`, `apps/web/vite.config.ts` (local adapter only)
- Notices: existing Vite MIT via package; no new THIRD_PARTY text required

## Verification plan

- Automated: unit tests for transform (nonce on script-src/style-src; no unsafe-inline; production
  `index.html` CSP string unchanged)
- Optional smoke: brief `vite` serve and assert HTML contains CSP nonce + `csp-nonce` meta
- Negative: build/Desktop paths must not enable `html.cspNonce` or the rewrite plugin
- Support level: Integrated for local web `vite` serve; production CSP behavior unchanged

## Unresolved questions

- None for this slice.
