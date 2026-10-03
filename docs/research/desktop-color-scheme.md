# Research: Desktop color scheme

- Status: Accepted; backend/platform implementation, renderer acceptance separate
- Date: 2026-10-03
- Owner: OpenBot maintainers
- Acceptance journey: Persist system/light/dark, apply before first native window paint and notify the renderer on effective appearance changes.
- Security boundary: Local presentation only; existing private preferences and trusted focused IPC, no OS setting changes or Server authority.

## C25 color scheme extension (2026-10-03)

Owner approved system/light/dark selection on 2026-10-03. This extends the earlier light-only
sidebar decision; its native material, accessibility and window-control boundaries still apply.
The changed boundary is a local persisted presentation field and three optional fixed bridge
methods, not OS configuration or Server authority.

Targeted review reused the repository's Electron **44.3.0**, tag object
`a5d1c52118831d762385f34c1b3ffbcc4d99de58`, commit
`07e460719c75b2ec5ee4893f7d2192ef31c7b8c2`, MIT. Reviewed the
[release](https://github.com/electron/electron/releases/tag/v44.3.0),
[pinned native-theme implementation](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_native_theme.cc),
[pinned native-theme tests](https://github.com/electron/electron/blob/v44.3.0/spec/api-native-theme-spec.ts),
[MIT license](https://github.com/electron/electron/blob/v44.3.0/LICENSE) and installed declarations.
The official [nativeTheme API](https://www.electronjs.org/docs/latest/api/native-theme) supplies
three theme sources, resolved dark colors and update notifications. The upstream tests cover
immediate forced resolution and changed/unchanged update events. GitHub query on 2026-10-03:
`repo:electron/electron nativeTheme themeSource is:open`; reviewed the ongoing
[override refactor #54595](https://github.com/electron/electron/pull/54595),
[per-WebContents proposal #52438](https://github.com/electron/electron/pull/52438) and the historical
[Ubuntu issue #28887](https://github.com/electron/electron/issues/28887). A single window needs
neither per-WebContents overrides nor an unreleased refactor. Other OS behavior needs its own lane.

Compared renderer-only media queries (cannot set native initial paint/chrome), an additional
preference store (duplicates persistence and migration), and the existing released nativeTheme
plus platform preference store. Selected the latter: a thin typed adapter with strict values,
trusted focused IPC and an isolated-preload user gesture. Optional methods retain Web/older-shell
compatibility. Legacy preference files default to system; older settings submissions preserve a
saved color scheme. Persistence is the commit point, followed by native application. A failed save
retains the prior native theme. Initialization applies the stored preference before BrowserWindow
construction; the resolved opaque colors are `#ffffff` / `#141414`. Native material and accessibility
fallbacks use this same resolution without changing the retained translucency choice.

No dependency/version change, upstream source copy or substantial adaptation. Existing Electron
MIT notices remain. Upgrade/replacement uses the existing Electron packaging path and repeats native
theme/material qualification; no parallel implementation to retire. Automated acceptance covers
invalid values, actual private-file persistence, legacy reads, startup resolution, system updates,
IPC/preload authority and deep/dim material fallback. An isolated macOS arm64 Electron fixture
qualifies the native boundary; renderer dark styles remain Claude's work. No global appearance or
accessibility setting is changed for testing, and no other-platform support claim is added.
