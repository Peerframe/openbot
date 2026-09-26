# Research: isolated Desktop Preview identity

- Status: Accepted for local macOS preview packaging
- Date: 2026-09-05
- Owner: OpenBot maintainers
- Acceptance journey: Open a real `OpenBot Preview.app` with the OpenBot icon and native app
  identity, while the installed OpenBot and its data remain untouched.
- Security boundary: Preview has a separate bundle identifier, executable, Electron application
  name, profile, session cookies, encrypted bootstrap and database. It retains existing renderer,
  Server, ASAR and fuse boundaries; packaging neither launches nor installs an application.

## Search evidence

- GitHub searches: `electron/packager appBundleId name executableName issues` and
  `site.github.com/electron/packager/issues name bundle` on 2026-09-05.
- Reviewed existing `Desktop application and language foundation` and `Integrated Desktop
  onboarding` entries in `docs/OPEN_SOURCE_REUSE.md`, and their accepted research.
- [Electron 44.2.0 app documentation](https://github.com/electron/electron/blob/v44.2.0/docs/api/app.md):
  `app.setName` changes Electron's internal name, not the OS identity; the package's `productName`
  takes precedence over `name`; default `userData` appends that application name to `appData`, and
  `sessionData` defaults to `userData`.
- [Packager 20.3.0](https://github.com/electron/packager/releases/tag/v20.3.0), exact commit
  `8c5cc941018b1d890c7152734972c44b9b98f268`: inspected installed `dist/mac.js` and
  `dist/types.d.ts` plus upstream [macOS tests](https://github.com/electron/packager/blob/v20.3.0/test/mac.spec.ts).
  The maintained BSD-2-Clause implementation derives app/helper bundle metadata from `name` and
  `appBundleId`, renames the executable with `executableName`, and copies `extraResource` outside
  ASAR. The existing adapter already verifies packaged ASAR contents and all Electron fuses.
- [Issue 166](https://github.com/electron/packager/issues/166) records a historical Windows shell
  identity mismatch; [the maintained FAQ](https://github.com/electron/packager/blob/v20.3.0/docs/faq.md)
  links issue 553 and explains the development-launcher difference. These older reports are not
  evidence of a current macOS defect. Actual macOS artifact validation is required.

## Candidate comparison

### Python candidate collision — 2026-09-26

Before this increment, rechecked the reuse entries above, Electron's pinned
[44.3.0 application API](https://github.com/electron/electron/blob/v44.3.0/docs/api/app.md)
and GitHub singleton reports, including [issue24447](https://github.com/electron/electron/issues/24447).
The installed canonical app can intentionally retain the original `OpenBot Preview` profile
through `desktopProfileCompatibility`. Read-only process and profile-lock inspection confirmed
that exact case: the installed app owns the legacy Preview database and singleton lock. The new
Python Preview consequently exits normally as a second instance; the UI tool reports a timeout.
Deleting the lock, bypassing singleton protection or closing the user's installed app is not a fix.

Reuse Packager20.3.0 and Electron44.3.0 with one fixed Python candidate identity:
`OpenBot Python Preview`, bundle `dev.openbot.desktop.python-preview`, staged package
`openbot-python-preview`. Select it only for `--preview --python-product`. Keep the legacy Preview
and canonical migration identity intact. The candidate has its own profile, Keychain namespace
and process lock; it still refuses a shared production Worker companion. No dependency, copied
source, generic profile override or security bypass is introduced. Qualification must reproduce
coexistence with the installed app and check native onboarding/restart on the newly packaged bytes.

| Candidate | Pin / license | Platform and boundary fit | Decision |
| --- | --- | --- | --- |
| Existing Electron Packager | 20.3.0 / BSD-2-Clause | Native app, helper, executable, bundle ID and icon metadata without another packaging framework | Select released API with a narrow fixed Preview target |
| Runtime `app.setName` alone | Electron 44.2.0 / MIT | Does not change Finder/Dock application identity | Insufficient |
| Manual plist/executable renaming | Apple app bundle contract | Would duplicate Packager's helper metadata, integrity and signing responsibilities | Reject because existing dependency covers the gap |

## Reuse decision

Use the existing package API with an explicit `--preview` mode. Production identifiers and package
manifest stay unchanged. Only Preview's staged package receives `name: openbot-preview` and
`productName: OpenBot Preview`, so Electron creates its own profile before the single-instance lock
or Session is created. No environment variable or renderer input can override the profile.
Preview uses `dev.openbot.desktop.preview`, executable `OpenBot Preview`, and an `out/preview`
destination. Packager 20.3.0 also sets the main `CFBundleDisplayName` from `executableName`,
so Preview deliberately uses the full brand as its executable name. Reject a production Worker
companion in Preview: its independent background service identity is not isolated by Desktop's profile. The bundled local Server remains available.
Unknown packaging arguments fail before staging. No auto-launch or `/Applications` replacement is
added. If upstream identity or resource checks fail, the package command fails.

## Artifact-validation finding

The actual Preview package exposed a pre-existing native-resource defect: Packager 20.3.0
`src/platform.ts` / installed `dist/platform.js:copyExtraResources` calls `fs.cp` without
`verbatimSymlinks`. Node resolves copied links to absolute source paths. The packaged workspace
modules and PostgreSQL libraries then pointed outside the app into the build worktree, and strict
code-sign verification rejected them. This is not an acceptable movable test artifact.

Use Packager's documented `afterCopyExtraResources` hook and the existing Node.js
[`fs.cp` option](https://nodejs.org/docs/latest-v24.x/api/fs.html#fscpsrc-dest-options-callback)
`verbatimSymlinks: true` for the fixed native resources and optional companion. Preflight each
resource tree: reject absolute, broken, cyclic or external symlinks, then preserve internal
relative links. This thin adapter addresses the observed gap without a new dependency, fork or
manual binary rewrite. Test a moved artifact after its source directory is unavailable.

Preview downloads use a worktree-local cache and the checksums already shipped by the locked
Electron 44.2.0 npm package, matching upstream `electron/install.js`; checksum validation remains
enabled. An existing cached ZIP may be copied into this isolated cache, then validated normally.

## Source incorporation

- No source copied or substantially adapted; only released APIs are used.
- Existing Electron/Packager notices remain in `THIRD_PARTY_NOTICES.md` and packaged dependencies.

## Verification plan

- Test production defaults, Preview path mapping, staged manifest isolation, invalid arguments and
  rejection of a production Worker companion.
- Build the macOS arm64 Preview; inspect bundle/helper plist identity, packaged manifest, icon,
  native Server/PostgreSQL resources and fuse validation. Do not launch until the renderer is ready.
- Document launch command and profile location in both Desktop onboarding documents.
- This is a local development artifact, not Developer ID signing or notarization evidence.

## Local verification results

On 2026-09-05, the macOS arm64 Preview package passed ASAR inventory and all fuse checks.
Its main display name, bundle name and executable are `OpenBot Preview`; its bundle ID is
`dev.openbot.desktop.preview`. All bundled helpers carry Preview names and identifiers. The icon
bytes match the repository's OpenBot `.icns` asset. The staged manifest retains the separate
Preview `productName`, and 24 native-resource links are relative, resolvable and contained inside
the packaged runtime. `codesign --verify --deep --strict` passes after preserving those links;
this validates the local ad-hoc signature, not Developer ID signing or notarization.
The focused policy/resource tests pass, including source removal and destination relocation.
No application was launched by the packaging command or these artifact checks.
