# Real logos for model providers and plugins

- Status: Implemented (step 38)
- Date: 2026-10-05
- Owner: @yxflc11
- Related issue: Owner request 2026-10-05: "use the real icons for Gmail and the models"
- Acceptance journey: 设置 › 模型服务, the model dialog, the plugins panel, the @ list and the
  sidebar's 插件 button show each known service's logo; an unknown service keeps its letter.
- Security boundary: presentation only. A logo identifies the service a model connection or plugin
  talks to; it grants nothing, changes no routing and is chosen from a fixed table in the client.
  No logo is fetched at runtime; all are bundled and loaded from `self` or `data:` (existing CSP).

## Trigger and existing decision

- Trigger: new dependencies.
- Existing decision: `ModelConnectionsDialog.tsx` used letter tiles because "OpenBot ships no
  third-party logos". The design README already named `@lobehub/icons-static-svg` for the nine
  provider logos on the Settings artboard. The Owner has now asked for real logos.
- Scope: the provider presets in `packages/domain/src/model-providers.ts` (11) and well-known plugin
  services matched by name or endpoint host (10). Any other plugin keeps its letter.

## Search evidence

- Search date: 2026-10-05.
- Queries: npm and GitHub for "AI provider logo svg", "brand logos svg CC0", "simple-icons",
  "lobe-icons", "svg-logos"; each package's license, release date and contents were checked.
- Existing ledger entries checked: `OPEN_SOURCE_REUSE.md` has no logo entry; the design README
  names LobeHub for provider logos.

## Candidate comparison

| Candidate | Exact release | License | Maintenance | Fit | Decision |
| --- | --- | --- | --- | --- | --- |
| LobeHub icons (`@lobehub/icons-static-svg`) | 1.95.1, gitHead `49a2130d` | MIT | Released 2026-09-21; the reference AI-provider set | Has all 11 presets in colour and one-colour forms; static SVG files, import only what is used | **Selected for providers** |
| SVG Logos (`@iconify-icons/logos`) | 2.0.2 (upstream `gilbarbara/logos` `37a6b807`) | CC0-1.0 | Released 2026-09-28 | Full-colour current marks for Gmail, Drive, Calendar, Slack, Notion, Discord, Figma; one ES module per logo, so only the ten used are bundled | **Selected for plugins** |
| Simple Icons (`simple-icons`) | 16.34.0 | CC0-1.0 | Released 2026-10-04 | One-colour marks only; Slack removed at the owner's request; tree-shakable | Rejected: Gmail and Drive would lose their real colours |
| Hand-drawn or copied SVGs | — | — | — | Inaccurate, and a maintenance burden | Rejected |

## Reuse decision

- Selected option: two released dependencies, pinned exactly in `apps/web/package.json`.
- Exact OpenBot-specific gap: a small table (`components/BrandMark.tsx`) that maps provider
  preset ids and plugin names or hosts to a logo, and draws one-colour logos as a CSS mask in the
  text colour so they stay visible in dark mode.
- Upgrade or exit: either package can be bumped or replaced by editing the imports in one file;
  removing a mapping falls back to the letter tile.
- Failure behaviour: an unknown service, or a missing logo, shows the first letter as before.

## Source incorporation

- Source copied or substantially adapted: no. Logos are imported from the packages at build time.
- Notices: `licenses/runtime/lobehub-icons-static-svg/LICENSE` (MIT, from the repository at the
  package's gitHead, since the npm package has none) and `licenses/runtime/iconify-icons-logos/`
  (the package notice and the full CC0 text), recorded with checksums in `sources.json`.
- Trademarks stay with their owners; logos are used only to name the service being connected.

## Verification

- Automated tests: the existing component suites (plugins panel, model services, @ list, sidebar)
  pass unchanged, since the visible names are unchanged; type-check covers the imports.
- Manual: design-preview captures of 设置 › 模型服务, the model dialog, 设置 › 插件 (light and dark),
  the @ list and the sidebar.
- Support level: Integrated (Web and Desktop share the bundle).

## Unresolved questions

- None.
