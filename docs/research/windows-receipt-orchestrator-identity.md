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
- Why first viable: both mismatch vectors are code-backed (Process field/API drift vs smoke;
  ConvertFrom-Json DateTime coercion → `[string]` locale short form). STJ `GetString` avoids the
  coercion entirely for identity fields; normalize-DateTime remains only when a value is already
  `DateTime`. Json.NET `DateParseHandling.None` is the same idea on Newtonsoft — unnecessary here.
- Exact OpenBot-specific gap: orchestrator must observe Electron the same way smoke does, and
  must never project `[string]$DateTime` for `startTimeUtc`.
- Failure behavior: mismatch throws with held vs receipt projection of the three identity fields
  only; preflight is a **bounded held-handle double canonical read** (no unbounded WinPS `&`
  child — smoke's WinPS path stays 15s/`maxBuffer` in the Node harness); fixture delete retries /
  treats vanished paths as success while still failing if the install tree remains.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none (Microsoft docs cited above; no vendor source copied)

## Verification plan

- Automated: `scripts/check-windows-receipt-identity.ps1` on Linux pwsh asserts STJ-primary
  JSON→compare→summary round-trip keeps the original 7-fraction-digit UTC ISO, and rejects
  last-digit / wrong-PID / wrong-path mismatches; on Windows also runs bounded canonical
  held-handle preflight (shared helpers, not a duplicated copy).
- Hosted Windows CI continues to run NSIS install → smoke → uninstall via
  `scripts/check-windows-desktop-install.ps1` (strict receipt↔held check retained).
- Do not edit smoke.mjs, harness, product code, workflows, or package.json for this fix.

## Unresolved questions

- Hosted Windows CI must re-run the install gate on branch `grok/windows-receipt-conformance`
  to confirm bootstrap receipt matches held Electron after this alignment.
