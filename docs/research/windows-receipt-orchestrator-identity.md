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
