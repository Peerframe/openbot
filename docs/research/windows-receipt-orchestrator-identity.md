# Research: Windows install-gate receipt↔orchestrator identity conformance

- Status: Accepted for implementation
- Date: 2026-09-13
- Owner: @yxflc11
- Related issue: Windows Desktop cold-start install gate failure on hosted CI
- Acceptance journey: After NSIS install, the PowerShell orchestrator records the held Electron
  process identity with the same .NET fields the smoke helper publishes, compares them with
  strict equality (case-insensitive path only), and projects only those three fields into
  bounded evidence — without relaxing precision or skipping the receipt↔held check.
- Security boundary: Identity observation stays on owned / held processes. Cleanup still refuses
  PID-only kills. Failure diagnostics project only `pid`, `startTimeUtc`, and `executablePath`
  for held vs receipt. No raw config, secret logs, or ciphertext.

## Search evidence

- Search date: 2026-09-13
- CI job (public log):
  https://github.com/yxflc11/openbot/actions/runs/34747105460/job/103696935315
  - Merge tip `6a326ce…` merges baseline `7e8a7636ec212c0ea7481edcf3ebd07e31406d75`; install-gate
    sources for this concern are identical to baseline.
  - Failure: `FAIL: Round receipt does not match the Electron process held by the orchestrator.`
    at bootstrap (`summary.json`: `lastStage=bootstrap`, `rounds=[]`, `passed=false`; smoke exit 0).
  - Shell: `C:\Program Files\PowerShell\7\pwsh.EXE` (PowerShell 7.x on the runner).
  - Secondary: `Remove-Item -Recurse` threw `Could not find file '…elicitationUrlExample.d.ts.map'`
    during fixture teardown (enumeration/delete race); `fixtureRemoved=false`.
- Smoke / harness Windows observer (baseline, unchanged by this fix):
  `apps/desktop/scripts/windows-native-smoke-harness.mjs` → WinPS 5.1
  `System32\WindowsPowerShell\v1.0\powershell.exe` with
  `[Diagnostics.Process]::GetProcessById`, pin `.Handle`, then
  `StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)` and
  `MainModule.FileName` (base64 on the IPC line).
- Orchestrator before fix (`scripts/check-windows-desktop-install.ps1`):
  `$smoke.StartTime.ToUniversalTime().ToString('o')` (no InvariantCulture) and
  `[string]$smoke.Path` — different fields/API than the smoke receipt.
- ConvertFrom-Json docs:
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/convertfrom-json?view=powershell-7.5
  (`-DateKind` exists on newer releases; **not** on pwsh 7.4.6 used in this box experiment).
- NSIS silent uninstall wait (official FAQ):
  https://nsis.sourceforge.io/When_I_use_ExecWait_uninstaller.exe_it_doesn%27t_wait_for_the_uninstaller%3F
  Ordinary `/S` copies the uninstaller to `%TEMP%`, starts the copy, and the **original** process
  exits immediately — so `WaitForExit`/`ExitCode` on the first process only observe the stub.
  Fix: copy the uninstaller **once** outside the install directory and invoke
  `Uninstall OpenBot.exe /S _?=<install-dir>` with `_?` last and the path unquoted; hold that
  process for a bounded wait. `openbot.exe` vanishing alone does not prove uninstall finished.
- Empirically verified on this box with pwsh **7.4.6** (`/tmp/json-date-roundtrip.ps1`):

  | Step | Result |
  | --- | --- |
  | Input ISO | `2026-09-13T08:25:04.1234567Z` |
  | Default `ConvertFrom-Json` type | `System.DateTime` |
  | `[string]$date` | `09/13/2026 08:25:04` (`string_eq_input=False`) |
  | `ToUniversalTime().ToString('o', InvariantCulture)` | exact ISO (`o_Invariant_eq_input=True`) |
  | `-DateKind String` | parameter missing on 7.4.6 |
  | `System.Text.Json` `GetString()` | preserves original ISO |

## Candidate comparison

| Candidate | Fit | Decision |
| --- | --- | --- |
| Loosen equality (drop start/path, truncate fractional seconds, PID-only) | Would green the gate without proving identity | Reject |
| Rely on `-DateKind String` only | Missing on pwsh 7.4.6; CI may not be 7.5+ | Reject as sole path |
| Align orchestrator observer to smoke (.NET GetProcessById + Handle + InvariantCulture `o` + MainModule.FileName) **and** read receipt/state/live identity fields via **System.Text.Json** `GetString`/`GetInt32` (preserve original ISO-7); `ConvertTo-IsoStartTimeUtc` only if a value is already `DateTime` | Matches smoke; keeps strict equality; summary stays original ISO without DateTime mutation | Select |
| Normalize-after-`ConvertFrom-Json` as the primary receipt path | Works on 7.4 but re-derives ISO from DateTime instead of preserving the wire string | Reject as primary (keep as DateTime fallback only) |
| Json.NET `DateParseHandling.None` (or Newtonsoft) to keep string dates | Same intent as STJ preserve; not needed — install gate already on Core / STJ | Reject (STJ is the in-box equivalent) |
| Change smoke.mjs / harness to match orchestrator Path/`ToString('o')` | Product/test helper churn; still leaves JSON `[string]` cast bug in evidence | Reject (out of allowed file set; incomplete) |

## Reuse decision

- Selected option: local gap in the install-gate PowerShell only — canonical process observer +
  **STJ-preserve** primary reads of known identity fields (`pid` / `startTimeUtc` / `executablePath`)
  from receipt and live/state JSON, with `ConvertTo-IsoStartTimeUtc` only as a DateTime fallback;
  shared helpers under `scripts/windows-receipt-identity-helpers.ps1`; resilient fixture removal;
  independent Linux-runnable identity test that exercises those same helpers.
- Why first viable: the JSON DateTime comparison/projection failure is independently reproduced. Aligning process observation keeps both sides on the same API; field/API differences alone are not an established failure cause. STJ `GetString` avoids the
  coercion entirely for identity fields; normalize-DateTime remains only when a value is already
  `DateTime`. Json.NET `DateParseHandling.None` is the same idea on Newtonsoft — unnecessary here.
- Exact OpenBot-specific gap: orchestrator must observe Electron the same way smoke does, and
  must never project `[string]$DateTime` for `startTimeUtc`.
- Failure behavior: mismatch throws with held vs receipt projection of the three identity fields
  only; preflight compares the held PowerShell host with the **actual Node/WinPS smoke observer** (20-second outer limit, existing 15-second WinPS/`maxBuffer` limit); fixture delete retries /
  treats vanished paths as success while still failing if the install tree remains.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none (Microsoft docs cited above; no vendor source copied)

## Verification plan

- Automated: `scripts/check-windows-receipt-identity.ps1` on Linux pwsh asserts STJ-primary
  JSON→compare→summary round-trip keeps the original 7-fraction-digit UTC ISO, and rejects
  last-digit / wrong-PID / wrong-path mismatches; on Windows also compares the held host against the actual Node/WinPS observer (shared helpers, not a duplicated copy).
- Hosted Windows CI continues to run NSIS install → smoke → uninstall via
  `scripts/check-windows-desktop-install.ps1` (strict receipt↔held check retained).
- The integration adds the shared preflight entry before native packaging in CI; smoke.mjs, its Node observer, product code and package.json remain unchanged by this repair.

## Unresolved questions

- Hosted Windows CI must re-run the install gate on branch `grok/windows-receipt-conformance`
  to confirm bootstrap receipt matches held Electron after this alignment.


## Integration verification

The integration also reproduces the JSON comparison failure on macOS PowerShell 7.5.4. Process field differences alone were not proven to cause the failure. Two reads in one .NET runtime do not establish agreement with the actual smoke observer. Reuse the existing Node 22.22.2 observeProcessIdentity helper, including its 15-second WinPS limit and bounded output, to inspect the held PowerShell host. Launch this trusted helper through .NET ProcessStartInfo.ArgumentList with a 20-second outer process limit, closed stdin and bounded response validation. The Microsoft contract is https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.argumentlist . The Node/Electron helper is already pinned; no dependency or source is copied. Run the shared regression entry before native packaging in CI, and repeat the identity preflight inside the full installed-runtime gate.

NSIS _?= binds the held process to the real uninstall (https://nsis.sourceforge.io/Docs/Chapter3.html#uninstallerusage). If timeout cleanup cannot confirm that process exited, the summary must set cleanupVerified=false.

## Get-Command Application multi-match (Node FileName)

- CI evidence (job failed early before identity compare):
  https://github.com/yxflc11/openbot/actions/runs/34748591201/job/103701010236
  - `Start process 'C:\hostedtoolcache\windows\node\22.22.2\x64\node.exe C:\Program Files\nodejs\node.exe'`
  - Cause: `(Get-Command node -CommandType Application).Source` when multiple Application
    matches exist — `.Source` becomes an `Object[]` that stringifies to a space-joined multi-path,
    unfit for `ProcessStartInfo.FileName`.
- Official semantics:
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-7.5
  - `-CommandType Application` searches `$Env:PATH` for executables.
  - `-TotalCount <int>` limits how many commands are returned.
  - Use `-TotalCount 1` so the first PATH entry (the command that runs / precedence first) is the
    sole `.Source` string — implemented as `Get-NodeApplicationPath` in
    `scripts/windows-receipt-identity-helpers.ps1`.
- Regression: `scripts/check-windows-receipt-identity.ps1` dual-node PATH fixture (Linux/Windows).

Integration exercises paths containing spaces. Unix fixtures link to the installed Node, while Windows copies the executable without requiring symlink privileges. The held version-check process has bounded stream/exit waits; fixture deletion errors fail the check. Local sandbox-restricted execution is not native Windows evidence.

## Process image identity during startup

Research completed before implementation on 2026-09-13. [Windows CI 34748988049](https://github.com/yxflc11/openbot/actions/runs/34748988049/job/103701932039), running PowerShell 7.6.5, completed bootstrap but rejected cold-start 1: the held and receipt PID/start time matched exactly, while the immediately observed held executable path was empty. Uninstall and fixture cleanup passed. This is a new observation failure, not permission to weaken identity comparison.

- [Microsoft `Process.MainModule`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.mainmodule?view=net-10.0) explicitly permits `null` before the main module finishes loading.
- [Microsoft `Process.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.refresh?view=net-10.0) invalidates cached process information. Reviewed **dotnet/runtime v10.0.9**, Git ref `5eaa18a9f3398d54ba9b8c0974d88171663be892`: `Refresh` and Windows `RefreshCore` preserve the held handle. This establishes handle retention, not that the first nonempty main-module result identifies the executable.
- Reviewed **PowerShell v7.6.5**, Git ref `8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac`; its [`global.json`](https://github.com/PowerShell/PowerShell/blob/v7.6.5/global.json) pins SDK 10.0.303. The previous CI log did not capture its exact loaded .NET patch; the regression now prints that framework identity instead of inferring it from PowerShell's version.

The first implementation retried null modules for five seconds without native interop. **That decision is superseded by new native evidence.** [CI 34750084879](https://github.com/yxflc11/openbot/actions/runs/34750084879), on PowerShell 7.6.5 / .NET 10.0.11, observed `ntdll.dll` for startup 9 and then `node.exe` after refresh. PID 6716, UTC start `2026-09-13T09:44:03.3549414Z` and held handle 2216 were unchanged. A nonempty module path therefore is not a readiness signal. [Upstream issue #14652](https://github.com/dotnet/runtime/issues/14652) recorded the same class of failure (`ntdll` instead of the executable), and [Microsoft's module enumeration contract](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-enumprocessmodulesex) permits incorrect information during initialization.

Reviewed the actual framework release **dotnet/runtime v10.0.11**, commit `79d0c463f1b55624c874a11585f7e47731e8d675`. Its [`Process.Windows.cs`](https://github.com/dotnet/runtime/blob/79d0c463f1b55624c874a11585f7e47731e8d675/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Windows.cs) still selects the first enumerated module. Its [`Interop.GetProcessName.cs`](https://github.com/dotnet/runtime/blob/79d0c463f1b55624c874a11585f7e47731e8d675/src/libraries/Common/src/Interop/Windows/Kernel32/Interop.GetProcessName.cs) uses `QueryFullProcessImageNameW` internally, but the public Process API does not expose the full image query. [Microsoft recommends this API for another process's executable](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getmodulefilenameexw), instead of module enumeration.

Selected: a narrow binding to the standard [QueryFullProcessImageNameW API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew), passing the existing `Process.SafeHandle` directly with flags 0 (Win32 path). The marshaler retains the borrowed SafeHandle during the call; the adapter neither opens by PID nor closes that handle. A fixed 32,768-character Unicode buffer must produce a nonempty, untruncated result with matching returned length; native errors fail closed. Process identity observation checks the same held object's liveness before and after reading and retains exact PID/start/path comparison. Cleanup uses that same observation API. No sleep, DLL-name filter, receipt-derived path or weaker matching remains.

The reuse ledger already points to this research for Windows receipt integration. Repository inspection found no existing QueryFullProcessImageName/Win32 binding to reuse; the existing `Add-Type -TypeDefinition` pattern in `scripts/install-desktop-download.test.ps1` supplies the compilation convention. A single platform API binding is narrower than adding a general interop dependency or invoking WMI by PID. Runtime sources were inspected, not copied or substantially adapted; no additional dependency or license notice is introduced.

Regression: repeatedly create real Node children and observe them immediately through the shared helper, compare their reported PID/executable against the held observation, retain the same handle across refresh, and reject the same object after its confirmed exit. Every child has bounded I/O and cleanup. This is a real process-start test on the host executing it; macOS/Linux results do not prove Windows readiness or the full Electron/NSIS lifecycle. No dependency added and no upstream source copied or substantially adapted (runtime source is MIT, consulted for API semantics only).

The prior null-retry version passed local macOS PowerShell 7.5.4 / .NET 9.0.10 checks, but that result did not predict Windows module enumeration behavior. The revised binding must compile and reject invalid/closed handles; the unchanged ten real child lifetimes and detailed diagnostics must pass on native Windows, followed by the full installed-runtime gate. Non-Windows results explicitly do not establish successful invocation of the Windows API.

## Dual-Node fixture deletion after confirmed exit

Research completed before implementation on 2026-09-13. [Main CI 34766658986](https://github.com/yxflc11/openbot/actions/runs/34766658986/job/103748719956), source `546127e1b70bf39bac9b87a522834233be0e1b93`, passed the JSON and dual-PATH assertions, including the real `node --version` child. The child was waited for and disposed, but removing the copied `first node/node.exe` immediately afterwards failed because another process held the file. The log does not identify that process; antivirus involvement is not established.

Reviewed the existing reuse-ledger entry and local `Remove-FixtureTreeResilient`: it handles vanished paths in the installer, not sharing violations in this independent preflight. [Microsoft DeleteFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilea) documents deletion failure with incompatible open handles. GitHub searches covered `PowerShell Remove-Item file in use retry`, including [PowerShell documentation issue 6625](https://github.com/MicrosoftDocs/PowerShell-Docs/issues/6625). Reviewed the maintained inbox implementation **PowerShell v7.6.5**, commit `8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac`, MIT: [`FileSystemProvider.RemoveFileSystemItem`](https://github.com/PowerShell/PowerShell/blob/8d7d14a86bf05f45ed163b1b1fbfde1ac4682bac/src/System.Management.Automation/namespaces/FileSystemProvider.cs) passes the original `IOException` in its error record. The existing preflight runs on native Windows CI and already verifies child exit before deletion.

Select the standard `Remove-Item -LiteralPath` operation with a narrow bounded adapter: retry only `IOException` sharing/lock violations (Win32 codes 32/33), at most eight deletion attempts with seven bounded backoff waits (7.1 seconds total). Permanent errors and the last failed attempt still throw. A generic cleanup dependency or changing the unrelated installer helper is unnecessary; suppressing deletion errors or weakening process identity checks is rejected. The adapter touches only this invocation's self-created fixture, after the held child is stopped and disposed. No upstream source copied or substantially adapted, no dependency added, no product runtime or permissions changed.

Verification: exercise the existing real-child preflight locally; test the extracted cleanup block against transient and persistent sharing failures and unrelated errors; require the unchanged hosted Windows identity and install lifecycle gates to pass before release. Injected failures validate branching and bounds, not native Windows file-lock behavior.
