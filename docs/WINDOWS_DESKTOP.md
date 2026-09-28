# Windows Desktop

Windows x64 Desktop is a remote client in current builds. Connect it to an existing OpenBot
Server; only macOS arm64 currently bundles the local Python service. Installing Desktop does not
enroll a Worker Host or grant computer-control authority.

## Install and run

Use the versioned `openbot-desktop-<version>-win32-x64.exe` and verify its SHA-256 against that
release's `SHA256SUMS`. NSIS installs per user, creates a Start menu shortcut and preserves
application data on uninstall. Development installers retain Windows trust prompts; OpenBot does
not bypass SmartScreen, policy or antivirus controls.

Open OpenBot, configure the existing Server address and sign in to that Server. Current Windows
packages contain no local PostgreSQL or Server runtime and do not initialize a local database.
The installer itself needs no Internet connection after download; using the remote Server requires
access to that Server. See [Desktop Server connection](DESKTOP_ONBOARDING.md).

## Retained data

Existing installations, encrypted settings and databases are preserved. Historical local-Server
profiles contain `local-server/bootstrap.json`, PostgreSQL data, uploaded objects and model settings.
Keep those files together, under the original Windows login: copying a DPAPI-encrypted bootstrap to
another login is not a supported migration. Current remote clients do not restart that retired local
Server or automatically migrate its database. See [database recovery](DATABASE.md).

DPAPI protects data under the Windows login boundary; it does not protect against malicious software
running as that same user. Backup and migration must retain the existing credential and data rules.

## Current installation gate (Windows x64)

The current [CI definition](../.github/workflows/ci.yml) builds NSIS and runs
[check-windows-desktop-install.ps1](../scripts/check-windows-desktop-install.ps1). It verifies
per-user installation and in-place upgrade, installed ASAR identity, absence of the retired
`native-runtime`, two independent Electron lifetimes with real DPAPI encryption/decryption and
stable ciphertext, process identity, uninstall and fixture cleanup. It uses only a disposable
profile. The separate native ACL tests retain their real NTFS negative checks.

Use a built installer, its matching packaged directory and the pinned development Electron:

```powershell
$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
$electronPathFile = Join-Path $env:TEMP 'openbot-electron-path.txt'
node -e "const r=require('node:module').createRequire(require('node:path').resolve('apps/desktop/package.json'));require('node:fs').writeFileSync(process.argv[1],r('electron'));" $electronPathFile
$electron = Get-Content -LiteralPath $electronPathFile -Raw
$env:RUNNER_TEMP = $env:TEMP
./scripts/check-windows-desktop-install.ps1 `
  -Installer "$PWD/apps/desktop/out/installers/win32-x64/openbot-desktop-$version-win32-x64.exe" `
  -PackagedDirectory "$PWD/apps/desktop/out/OpenBot-win32-x64" `
  -Electron $electron `
  -SmokeScript "$PWD/apps/desktop/scripts/windows-remote-smoke.mjs"
```

The gate must complete both remote safeStorage lifetimes and uninstall/cleanup. Its allowlisted
`summary.json` records process identities and ciphertext digests, excluding raw ciphertext,
passwords and fixture profiles. The CI artifact retains the historical name
`windows-desktop-cold-start-<source SHA>`; inspect its schemaVersion2 and remote receipts rather
than inferring ten PostgreSQL cold starts from that name. Read the actual result for the source
commit: a workflow definition alone is not execution evidence. This cleanup has not run native
Windows installation, DPAPI or installed-app GUI on the current source.

Portable identity/helper tests remain available:

```bash
npm test --workspace @openbot/desktop -- scripts/windows-native-smoke-harness.test.mjs
```

## Historical local-Server evidence and limits

The earlier [pre-cold-start run](https://github.com/yxflc11/openbot/actions/runs/34497646235) and
[main CI34768475942](https://github.com/yxflc11/openbot/actions/runs/34768475942) are historical.
The latter record is for `64569ece36141fa112266cdf93e2694bc88a632b`: one bootstrap plus ten independent
Electron cold starts, twelve Owner logins, retained PostgreSQL rows/bootstrap ciphertext, process
identity negatives and cleanup. It does not qualify the current remote-client source or its GUI.
The old `windows-native-smoke.mjs` entry and Windows PostgreSQL build chain have retired; use the
current gate above. Retain source-build licensing/provenance records for previous recipients; see
[the historical research](research/windows-desktop-completion.md).

Windows ARM64, Windows 10/11 real-device GUI, signing, SmartScreen, accessibility and computer-control
conformance remain separate evidence gates. The Windows Worker Host service is separately reviewed;
Desktop installation cannot qualify its SCM identity or enrollment lifecycle.
