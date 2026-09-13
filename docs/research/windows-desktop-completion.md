# Research: Windows Desktop local Server

- Status: Accepted for implementation; native Windows verification required
- Date: 2026-09-10
- Acceptance journey: On Windows x64, install the per-user Desktop, select this computer as the Server, create a local authenticated cluster without Docker, stop it, and reopen the retained database.
- Security boundary: Electron main owns paths and child lifetimes. Server remains authority. Loopback PostgreSQL uses SCRAM; bootstrap secrets use Electron DPAPI. Refuse unsafe ACLs and missing binaries. No privileged service, firewall rule, public listener, or policy bypass is introduced.

## Search evidence

Reviewed the integrated Desktop onboarding and Windows Worker Host entries in `docs/OPEN_SOURCE_REUSE.md`. The latter is a separate unattended service, not required for an app-owned PostgreSQL process. GitHub queries included `leinelissen embedded-postgres windows win32 x64 17.10`, upstream open issues, and Electron safeStorage Windows failures (including issue 33640). The upstream Windows package source, distribution inventory, download implementation and tests were inspected at the pin below. Upstream open issues 28, 32–35 and 38 document reused Windows clusters, plaintext temporary passwords and unsettled shutdown/start promises; binary-only reuse avoids adopting that lifecycle wrapper. The existing Darwin bootstrap incorrectly assumes POSIX modes, `/dev/stdin`, Unix signals and extensionless executables on every supported host.

## Candidate comparison

| Candidate | Exact release / commit | License | Maintenance / fit | Decision |
| --- | --- | --- | --- | --- |
| PostgreSQL native contracts | 17.10, `REL_17_10` source | PostgreSQL | initdb source opens a real password filename; `pg_ctl stop -m fast -w` supports Windows rather than Node signal emulation. | Reuse unchanged native tools. |
| `@embedded-postgres/windows-x64` | 17.10.0-beta.17, `c23ad8a026c711c8666c3c2596d0fde643cf378a` | MIT packager; native components retain separate terms | Same reviewed publisher/version as current Darwin packages; Windows x64 package has initdb.exe, postgres.exe and pg_ctl.exe, plus DLLs and data. npm integrity `sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==`. | First viable released binary adapter; no runtime download or new database implementation. |
| Electron | 44.2.0 | MIT / Chromium notices | Existing pinned runtime: utilityProcess, safeStorage DPAPI and package fuses. DPAPI protects against other logins, not a malicious process running as the same user. | Reuse existing APIs and fail if encryption unavailable. |
| Windows ACL APIs through inbox PowerShell/.NET | Windows PowerShell 5.1 `DirectorySecurity` / `FileSystemAccessRule` | Microsoft platform terms | Set a protected owner-only inheritable DACL on new app data; inspect existing ACLs instead of assuming chmod works. Fixed script, literal environment path, bounded output and timeout. | Thin adapter; no downloaded ACL library or arbitrary command input. |
| Docker / external PostgreSQL | Existing remote path | Component-specific | Requires separate deployment and does not satisfy native local onboarding. | Remains an option but does not replace native Windows path. |

Primary sources: [initdb](https://www.postgresql.org/docs/17/app-initdb.html), [pinned initdb source](https://github.com/postgres/postgres/blob/REL_17_10/src/bin/initdb/initdb.c), [pg_ctl](https://www.postgresql.org/docs/17/app-pg-ctl.html), [DirectorySecurity](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity), [Electron safeStorage](https://github.com/electron/electron/blob/v44.2.0/docs/api/safe-storage.md), [binary upstream](https://github.com/leinelissen/embedded-postgres/tree/c23ad8a026c711c8666c3c2596d0fde643cf378a).

## Reuse decision

Keep the existing controller; adapt the minimum platform seams (binary names, ACLs, initdb password transport, environment and shutdown). Windows stages workspace copies rather than privileged symlinks. A password file exists only within the newly protected staging directory and is removed in `finally`; no password enters command arguments or logs. Runtime code cannot choose an executable or ACL script from renderer data. Future PostgreSQL upgrades must explicitly validate retained cluster major versions.

## Source incorporation

No implementation source is copied or substantially adapted. Binary-only PostgreSQL is staged from the exact optional package with its packager license and OpenBot's native notices. Distribution inventory is not a complete provenance attestation: Windows includes additional third-party DLLs, and their corresponding-source/license inventory must be completed before claiming an attested redistributable binary. No WiX installation or acceptance of its separate commercial terms is implied.

## Verification plan

Portable tests cover Windows command/environment policy, bounded startup failures and packaging resource selection. A Windows-native smoke gate initializes the actual PostgreSQL package with the actual controller, launches the built Server, authenticates, checks health, persists data across restart and checks shutdown. The hosted runner can prove execution and migrations, not an interactive user installation, SmartScreen/code-signing trust, or desktop-control Provider behavior. macOS tests do not substitute for native Windows evidence. User instructions and limitations are maintained in bilingual Windows Desktop documents.

## Source-build replacement (2026-09-10)

The embedded Windows package inventory did not provide complete matching source and build provenance for its bundled modified gettext/libiconv DLLs. It is no longer a distributable input. The accepted replacement is PostgreSQL's official 17.11 source archive (`https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2`, SHA-256 `dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979`), built on Windows using the reviewed Meson/MSVC script and minimal optional features. See `scripts/build-windows-postgresql.ps1` and `licenses/windows-postgresql` for exact tool pins, build options, licenses and source URLs. Existing Darwin binaries are unchanged.

Windows staging requires `OPENBOT_WINDOWS_POSTGRES_RUNTIME` from that build. It validates pinned identity/source, required disabled-feature/static-runtime options, each listed file's size/SHA-256, canonical relative paths, absence of symlinks and completeness of the inventory before copying verified bytes. Missing or unexpected files, modified bytes, and the old npm binary package fail closed. The manifest proves consistency with the CI build output, not that an arbitrary externally supplied manifest is trustworthy; the workflow's pinned source download/build is the provenance boundary. Native CI must still install the NSIS output and exercise PostgreSQL authentication, migration and retained restart.

## Native ACL invocation follow-up

Windows CI 34485963429 still reached the fixed process deadline after unused stdin was closed, so EOF alone is not evidence of a complete fix. The existing PowerShell wrapper relied on module-autoloaded `Get-Item`, `New-Object`, `Get-Acl` and `Set-Acl`. Reviewed Microsoft's [.NET Framework 4.8.1 DirectoryInfo.GetAccessControl](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.getaccesscontrol?view=netframework-4.8.1), [SetAccessControl](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.setaccesscontrol?view=netframework-4.8.1) and [PowerShell module-path construction](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath). Use the same inbox .NET ACL primitives directly inside the fixed Windows PowerShell 5.1 command, avoiding command/module discovery and string-overload identity resolution. The directory must exist, be a directory and not be a reparse point; all SID/DACL checks remain. No module search path is inherited, no new dependency or code copied. Native CI must confirm whether this resolves the process stall before release.

Failure diagnostics retain only a fixed phase label from the bounded child output (launch/started/identity/protecting/reading), never the command, directory path or raw error stream. This distinguishes process launch from an ACL operation without publishing local data.

## Installed-runtime harness executable resolution

CI 34486636717 passed the real ACL fixture, PostgreSQL source build/upstream regression, retained 17.10 upgrade, NSIS creation and installed-ASAR comparison, then found no executable at a hard-coded root `node_modules/electron/dist/electron.exe`. Inspected the selected Electron 44.2.0 npm `index.js`: its supported `require('electron')` entry lazily ensures the development executable exists, while Packager can use a separate download cache. Resolve that entry relative to the Desktop workspace with Node's `createRequire`; write the returned path to a dedicated runner-temp file so download progress on stdout cannot corrupt the path. Keep the installed native-runtime path and all smoke assertions unchanged. No dependency or copied source.

## Positive evidence from the native smoke process

CI 34488540915 returned a successful installation step but did not expose the smoke program's completion log. That alone is insufficient evidence that the GUI-subsystem executable completed its assertions. Reviewed PowerShell 7.5 [Start-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-7.5), explicit redirected streams/PassThru, and .NET [Process.WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit?view=net-9.0). The harness must wait at most 120 seconds for the exact process, require exit zero and a fresh structured result written only after every smoke assertion and cleanup completes, and verify the exact check inventory. Temporary result/log paths are per-install UUID under RUNNER_TEMP and contain only synthetic fixture diagnostics; no user data is read. This adds evidence rather than weakening an existing check. No dependency or source copied.

## Electron ESM readiness ordering

CI 34490611680 correctly rejected the smoke process after 120 seconds with no receipt. The harness used top-level `await app.whenReady()`. Electron 44.2.0's [ESM tests](https://github.com/electron/electron/blob/v44.2.0/spec/esm-spec.ts) explicitly assert that top-level await completes before `ready`; its [ESM guide](https://www.electronjs.org/docs/latest/tutorial/esm) documents this ordering. Waiting for `ready` during module evaluation creates a circular wait. The product entry already uses a non-awaited `app.whenReady().then(...)` chain. Apply that existing lifecycle pattern to the smoke entry, with an explicit rejection exit and phase-only progress logs. Keep the 120-second process limit and positive receipt mandatory; print bounded synthetic test logs on timeout as well as nonzero exit. No dependency or copied upstream source. Hosted Windows execution remains required for the full lifecycle verdict.

## Startup failure diagnostics for the native acceptance gate

CI 34492902691 passed source build, old-cluster upgrade and packaging, then reached Electron and failed the first native startup assertion. The public state correctly concealed the underlying error, but the test had no phase/cause evidence. Reviewed Node v22.22.2's [diagnostics_channel API](https://github.com/nodejs/node/blob/v22.22.2/doc/api/diagnostics_channel.md): reuse its stable, synchronous, in-process publish/subscribe interface instead of a new logging dependency or renderer error field. A private main-process channel reports startup phase/cause; bounded native command stderr is captured only when a trusted main-process subscriber exists. There is no subscriber or logging by default. The synthetic Windows acceptance process subscribes, removes generated secret strings from bounded diagnostics and unsubscribes during cleanup. Public failure state and IPC remain unchanged; tests assert that distinction. No source copied. The next Windows run must provide actual evidence before release.

## Native Windows PostgreSQL launcher

CI 34494925061 located failure after successful initialization: the directly spawned postmaster exited. Reviewed PostgreSQL REL_17_11 `src/backend/main/main.c` (`check_root`) and `src/bin/pg_ctl/pg_ctl.c` (`start_postmaster`, `CreateRestrictedProcess`). Direct Windows postmaster execution rejects an administrator token; the hosted runner uses that token. The successful upgrade gate already uses `pg_ctl`, which creates the restricted token through upstream Windows APIs. Reuse that released CLI for Windows start as well as stop instead of implementing token manipulation or disabling the upstream check. Track the resulting private `postmaster.pid` identity (PID, data directory, start time and port), reject an already-running cluster, and verify ownership before stopping; retain the POSIX child-process path. All parameters come from the trusted controller, never renderer/model input. Windows runtime execution must confirm the inference. No upstream code copied.

The Windows-only synthetic harness also uses Electron 44.2.0's reviewed `utilityProcess.fork` stderr pipe, retaining at most 4,096 characters and emitting it through the same secret-sanitizing reporter only on an unsuccessful Server exit. External search credentials and plugin endpoint overrides are excluded from the fixture environment. The product Server process configuration is unchanged.

## Hosted acceptance result (2026-09-11)

[CI 34497646235](https://github.com/yxflc11/openbot/actions/runs/34497646235), source `7d0b0cfd18ac80a91a75001ebc6d295abd604202`, completed all jobs. Windows job 102940089408 explicitly printed `PASS: native smoke receipt verified (postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup)` and confirmed NSIS install, installed native runtime and uninstall checks. This validates the restricted-token launcher with the actual installed runtime; a successful main push CI is still independently required as the source for a published installer. No real-device, signing or arbitrary computer-control conformance is inferred.

## Cold-start lifetimes (alpha.8)

The historical smoke proved retained data inside **one** Electron process (controller stop/start). Alpha.8 acceptance requires ten **separate** Electron process lifetimes after bootstrap. Research and implementation notes live in [windows-cold-start-conformance.md](windows-cold-start-conformance.md). The install script orchestrates `bootstrap` then ten `cold-start` Electron invocations; the final receipt must include `cold-start-10` without dropping `postgresql,migrations,dpapi,owner-login,retained-data,stop,restart,cleanup`. Hosted Windows evidence for the extended receipt remains required before claiming the gate passed on a given commit.
