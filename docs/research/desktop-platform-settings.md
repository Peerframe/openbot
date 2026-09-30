# Research: Desktop preferences and signed update bridge

- Date: 2026-10-01
- Status: Native preferences accepted; signed-update delivery depends on release credentials/artifacts.
- Trigger: native startup/background effects and an executable-update trust boundary.

Reuse Electron 44.3.0 public [app](https://www.electronjs.org/docs/latest/api/app/),
[Tray](https://www.electronjs.org/docs/latest/api/tray/),
[globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut/) APIs and existing private
RestrictedJsonFile storage. Retain one window, local Server shutdown and trusted main-frame IPC.

Compared Electron built-in autoUpdater (Squirrel Windows does not match existing NSIS installers;
no Linux support), electron-updater and custom release download/install scripts.
Select released electron-updater 6.8.9 (MIT), registry integrity
`sha512-ZhVxM9iGONUpZGI1FxdMRgJjUFXi7AYGVa5PwKlO1tV1/4zDxQmfKpXOHVztKrd6L9rLcFjERvi1Mf2vxyTkig==`,
with its existing-builder-compatible NSIS/macOS adapters. Reviewed the installed release's
AppUpdater/NsisUpdater/MacUpdater source, published types/changelog, upstream
[auto-update documentation](https://www.electron.build/docs/features/auto-update/),
[security documentation](https://www.electron.build/docs/features/security/), and
[upstream issue tracker](https://github.com/electron-userland/electron-builder/issues).

The release NsisUpdater source skips signature checks when publisherName or app-update.yml is
missing. The OpenBot adapter must reject that configuration before creating an updater. Accept
only an immutable bundled GitHub configuration for Peerframe/openbot, with a publisher allowlist
on Windows and a current Developer ID TeamIdentifier match on macOS. Verify the running binary's
signature first; keep native updater signature/checksum validation. Development/unsigned apps and
Linux installers expose unavailable instead of executing installers. No arbitrary URL/path/command
is accepted over preload. Disable automatic install-on-quit and downgrade; installation requires
native confirmation and clean Server shutdown. No upstream source copied or substantially adapted.

Existing releases through desktop-v0.1.0-alpha.9 are unsigned and have no updater metadata. The
current prepare-release workflow explicitly has no automatic updater. This is a real distribution
prerequisite: no signed download/install claim until the selected signing configuration, metadata
and next signed artifact are available. Native preference tests use disposable profile files;
startup OS changes are not enabled against the user's installed app during implementation.

## Candidate verification

`npm run check` passed and the Desktop suite passed530 cases with3 existing skips. An isolated
real macOS Electron44.3.0 temporary profile exercised trusted IPC/preload, private persistence,
tray creation/cleanup, global shortcut registration/cleanup, Dock badge cap/cleanup and missing
user-gesture update-install rejection. It never enabled OS startup or installed an update.
Unsigned/missing-config refusal is verified; signed artifact download/install remains dependent
on the distribution prerequisites above. No production signed-update claim or release.
