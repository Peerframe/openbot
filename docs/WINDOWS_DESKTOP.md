# Windows Desktop

Windows x64 Desktop can run its own local OpenBot Server and PostgreSQL, or connect to an existing Server. The local process belongs to the signed-in user's Desktop session. Installing it does not enroll a Worker Host or grant computer-control authority.

## Install and run

Use the versioned `openbot-desktop-<version>-win32-x64.exe` and verify its SHA-256 against that release's `SHA256SUMS`. The NSIS installer installs per user without requesting administrator rights. It creates a Start menu shortcut and preserves application data on uninstall. Unsigned development installers retain Windows trust prompts; OpenBot does not bypass SmartScreen, policy or antivirus controls.

Open OpenBot and choose this computer as the Server. The application initializes a private PostgreSQL 17 cluster, starts the bundled Server on loopback, migrates its schema and signs in the local Owner. Configure a model through Settings before asking a Bot to work. There is no Docker, PowerShell installer, separately installed Node.js or public network listener required for this local mode.

The installer itself needs no Internet connection once downloaded. A configured remote model or external tool can require network access. The application package includes the exact PostgreSQL binaries; it never downloads database executables on first use.

Windows uses PostgreSQL’s official restricted-token launcher even when Desktop inherits an administrator token. The private database log is `postgres.log` beside the cluster; it is local diagnostic data and is not uploaded. Stop operations verify the database process identity before acting.

## Data and lifecycle

Data lives below Electron's per-user application-data directory in `openbot/local-server`: PostgreSQL data, uploaded objects, model settings and an encrypted bootstrap file. Electron `safeStorage` uses Windows DPAPI for bootstrap encryption. The directory gets an owner-only inheritable NTFS DACL; existing unexpected access is rejected rather than silently repaired. DPAPI is a user-login boundary, not protection from malicious software running under the same login.

Normal quit first asks the Server to stop through its private parent process channel, then invokes PostgreSQL's Windows-aware `pg_ctl stop`. Reopening reuses the same encrypted identity and database. Before manually backing up, quit OpenBot and verify its PostgreSQL process has stopped. Keep the encrypted bootstrap with the database; copying it to another login is not a supported migration. Major PostgreSQL version changes require an explicit migration.

## Verification and current limits

The Windows CI job builds and makes NSIS, installs it into a unique temporary directory, verifies the installed ASAR hash, exercises the **installed** native runtime with Electron DPAPI, real PostgreSQL, schema migration, Owner authentication, one same-process retained restart, **ten independent Electron process cold starts** (new process identity via start time + path, prior children ended, PG row + bootstrap ciphertext digest persistence, Owner login counts), and uninstall. The separate native ACL test checks actual NTFS ACLs. Read the actual CI run result for the source commit; adding a workflow is not evidence it passed.

### How to run the cold-start acceptance gate locally (Windows x64)

Prerequisites: a built per-user NSIS installer, the matching packaged `OpenBot-win32-x64` directory, the pinned Electron development executable, and the smoke script from this repository. Use only disposable temp directories (the script creates its own under `%RUNNER_TEMP%` or fails closed).

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
  -SmokeScript "$PWD/apps/desktop/scripts/windows-native-smoke.mjs"
```

Pass criteria: the script prints `PASS: native smoke receipt verified (postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup,cold-start-10)` and completes uninstall. Same-process controller stop/start loops alone are **not** cold-start evidence.

The gate retains `summary.json` in the printed evidence directory (or the explicit
`-EvidenceDirectory`). CI uploads it as `windows-desktop-cold-start-<source SHA>`,
including on failure after the gate starts. It records bootstrap plus ten cold
rounds, observed Electron/Server/PostgreSQL identities, successful login counts,
the unchanged bootstrap ciphertext digest, process-ownership negative checks,
and uninstall outcome. Only these projected fields are retained; fixture
profiles, raw ciphertext, passwords, and diagnostic logs are not uploaded.


Portable harness unit tests (Linux/macOS/Windows):

```bash
npm test --workspace @openbot/desktop -- scripts/windows-native-smoke-harness.test.mjs
```

The development host for earlier Windows Desktop work was macOS. Historical [hosted Windows execution](https://github.com/yxflc11/openbot/actions/runs/34497646235) passed the pre-cold-start receipt. **Ten-lifetime cold-start evidence for this branch remains pending Windows CI.** The smoke harness uses the same controller and installed runtime but does not drive the installed application window. Manual Windows desktop/SmartScreen, code signing, accessibility and real computer-control conformance remain separate acceptance steps. Windows ARM64 is not a supported package target.

The Windows Worker Host service remains a separately reviewed component. Its SCM installer, identity and real-device acceptance cannot be inferred from Desktop installation. Windows PostgreSQL is built from the pinned official 17.11 source using Meson/MSVC with optional dependencies disabled and a static MSVC runtime. Packaging requires the source-build manifest and verifies every installed file; the former npm binary package is not accepted. Review the CI provenance, bundled licenses and code-signing result before advertising an attested production binary; see [research](research/windows-desktop-completion.md). No new macOS or Linux adaptation is included in this milestone.
