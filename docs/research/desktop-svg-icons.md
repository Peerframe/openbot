# C16: source-derived Desktop icons

- Date: 2026-10-03
- Baseline: `cbf1700bf596f8f06f202005123e6d92cf7d59a1`
- Status: pipeline candidate; approved source export and native screenshots pending.

Reuse [Desktop delivery](desktop-installable-delivery.md) and the reviewed builder
[maintenance pin](dependency-ci-september12.md): electron-builder / app-builder-lib 26.16.1,
`7d3b30f3b15950d19f7c5ff882cf2d161cd3ba2c`, MIT. Its installed `toolsets/icons.js` selects
icons@1.2.3, `6a73d9cc231a7446632702a9c3be856b449ba414`, with archive SHA256
`4e5bb546c9d3ab0c2bbacc22857467bf415f742a34c2be9dd138779d2fc066f9`.

Primary evidence inspected: [builder source](https://github.com/electron-userland/electron-builder/tree/7d3b30f3b15950d19f7c5ff882cf2d161cd3ba2c),
[icons release](https://github.com/electron-userland/electron-builder-binaries/releases/tag/icons%401.2.3),
[icon sources/tests](https://github.com/electron-userland/electron-builder-binaries/tree/6a73d9cc231a7446632702a9c3be856b449ba414/packages/icons/assets),
and [official configuration](https://www.electron.build/v26/docs/features/icons-and-images/).
Read installed conversion source and downloaded hash-verified CLI. GitHub open issue search for
this toolset found no pending icon issue (open Wine/NSIS issues are unrelated).

| Candidate | Fit and cost | Decision |
| --- | --- | --- |
| Existing builder icons@1.2.3 | Portable resvg WASM, PNG/SVG conversion, ICNS/ICO/set; retained tests and license; no new dependency | Reuse pinned tool |
| macOS iconutil | Native ICNS only; requires another Windows/Linux pipeline | No extra pipeline |
| New raster/image dependency | Adds lock/licensing/platform work while builder already rasterizes SVG | Unnecessary |

The local gap is using a separate micro drawing in the small container entries. Merge the already
converted ICNS/ICO frames, preserving original encoding and metadata. No renderer network, model,
remote publishing or new product authority. SVGs are bounded and reject external references,
active content and fonts. Missing sources fail before replacing generated output; no old binary
is silently substituted. Generation is sequential per output directory.

## Export contract

Claude owns `docs/design/app-icon/`: `app-icon.svg`, `app-icon-dark.svg`, `app-icon-small.svg`. All are square viewBox, self-contained
vector paths. Optional `app-icon-linux.svg` and `app-icon-splash.svg` override the circularly clipped
master and dark icon artwork. Three sources suffice for platform icons; without an explicit splash
source its PNG is only the dark icon artwork, not the full approved startup composition.
Claude owns the startup screen layout; native/artboard visual acceptance remains pending. No third-party logo.
Run `npm run icons:generate --workspace @openbot/desktop`. Both package and installer entry points
regenerate in `apps/desktop/out/icons/`; generated images are ignored, never committed.

- ICNS: 16/32/64/128/256/512/1024px including Retina frames. Small logical 16/32pt use the micro source.
- ICO: 16/24/32/48/64/128/256px; <=32px use the micro source.
- Linux `icons/NxN.png`: 16/24/32/48/64/128/256/512px; <=32px use a circularly clipped micro source.
- `openbot-icon.png`: master 512px; `linux/openbot-icon.png`: circular Linux 512px; `openbot-icon-dark.png` and `openbot-icon-splash.png`: 1024px.
- `sources.json`: exact input SHA256 and converter identity.

Source copied or substantially adapted: no. Existing MIT tool and bundled WASM remain supplied by
builder; no upstream code is vendored. Standard container headers are assembled locally.

## Current handoff

Checkout `/private/tmp/openbot-c16-icons`, branch `codex/c16-icon-pipeline`. No `apps/web` changes.
Synthetic vector conversion ran twice: 6 focused tests passed, no skips, including invalid SVG and
missing-source preservation. This proves conversion, not the approved icon appearance. Full `npm run check` passed on the initial and three-source revisions (build: 18 successful, 17 cached).
An intermediate micro-source wrapper had an invalid regex escape; fixed and the six focused
cases plus full check passed again. Platform window PNG now selects the circular Linux asset
only on Linux; Windows keeps the master artwork. Final affected checks: 43 passed across icon generation, installer policy and package policy,
zero skips. Final full `npm run check` passed (18 build tasks successful, 17 cached); its Desktop
suite ran 532 tests with three existing platform-guard skips, not counted as passes. Initial
sandbox runs failed at loopback listen with EPERM; rerun with the authorized local test
environment passed. Hosted [validate passed](https://github.com/Peerframe/openbot/actions/runs/37039027532/job/110944356974)
on `29451ed`. No SVG source exists on the
baseline, so native package/Dock/taskbar/menu screenshots remain blocked on Claude's export;
this item is not complete. Keep the current tracked binaries until replacement artwork is verified.
PR: [#158](https://github.com/Peerframe/openbot/pull/158), draft; source/native screenshots remain
required. C9/C11 remain deferred; no auto-merge or release.
