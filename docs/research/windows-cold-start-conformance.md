# Research: Windows Desktop cold-start conformance

- Status: Accepted for implementation; native Windows verification required
- Date: 2026-09-13
- Owner: @yxflc11
- Related issue: alpha.8 Windows cold-start acceptance
- Acceptance journey: After first native initialization on Windows x64, ten separate Electron process lifetimes each start the installed native Server, prove a new process identity, verify retained PostgreSQL rows and DPAPI bootstrap ciphertext, complete Owner login, then exit normally with prior children gone.
- Security boundary: The harness uses only self-made temporary directories. It never reads the interactive user's real Desktop data roots. Product runtime code is unchanged. Failures still stop this run's Electron/Server/PostgreSQL children and leave a bounded summary without publishing secrets.

## Search evidence

- Search date: 2026-09-13
- GitHub / primary docs:
  - Electron [`v44.2.0`](https://github.com/electron/electron/releases/tag/v44.2.0) and [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage) (Windows DPAPI; protects other logins, not same-user malware)
  - Electron ESM readiness ordering already recorded in [windows-desktop-completion.md](windows-desktop-completion.md) (no top-level `await app.whenReady()`)
  - Node.js `child_process` / `process.kill(pid, 0)` liveness; PowerShell `Start-Process` / `Process.WaitForExit` / `Kill($true)` already used by `scripts/check-windows-desktop-install.ps1`
  - PostgreSQL REL_17_11 `postmaster.pid` and `pg_ctl` restricted-token contracts already reused by Desktop
- Existing OpenBot issue, ADR, and reuse-ledger entries checked:
  - `docs/OPEN_SOURCE_REUSE.md` Windows Desktop / DPAPI / `pg_ctl` entries
  - `docs/research/windows-desktop-completion.md` installed-runtime smoke receipt
  - `apps/desktop/scripts/windows-native-smoke.mjs` same-process controller stop/start only

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| Same-process `NativeServerController` stop/start ×10 | Existing OpenBot Desktop | MIT | Already in smoke | Proves retained files inside one Electron lifetime only; does **not** prove cold process identity or child teardown across OS process exits. | Reject as cold-start evidence; retain at most one same-process restart so historical assertions are not relaxed. |
| Ten independent Electron process lifetimes orchestrated by the existing PowerShell install gate | Electron 44.2.0; Node child_process; inbox PowerShell/.NET Process | MIT; Node.js; Microsoft docs | Hosted Windows CI already launches Electron for smoke | Matches product quit/reopen; can assert new PID, dead prior children, DPAPI ciphertext equality, PG row retention, Owner login. | Select. |
| Playwright / Spectron driving the packaged UI | Deferred Playwright 1.62.1 per foundation research | Apache-2.0 | Extra download/surface | Broader than alpha.8 native runtime gate; not required to prove Server/PG/DPAPI cold start. | Reject for this slice. |
| New process-supervisor dependency | n/a | n/a | n/a | Violates no-new-dependency constraint. | Reject. |

## Reuse decision

- Selected option: thin local harness gap on already-pinned Electron, Node, PowerShell, `NativeServerController`, `utilityProcess`, `safeStorage`, and Windows PostgreSQL PID contracts.
- Selected upstream or standard: Electron 44.2.0 safeStorage/DPAPI; Node process liveness; PostgreSQL `postmaster.pid`; PowerShell process wait/kill already in the install script.
- Why this is the first viable option: open standards and released APIs already in tree close the gap; only orchestration and assertions are missing.
- Exact OpenBot-specific gap: multi-lifetime smoke modes, shared self-made harness state, prior-child teardown checks, and receipt fields for ten cold starts.
- Upgrade, replacement, or exit plan: if Electron changes safeStorage async init or utilityProcess PID semantics, re-pin and re-run the Windows install gate; the helper unit tests stay portable.
- Failure behavior: bounded per-process timeouts; on failure stop this run's harness processes only after verifying recorded start-time + executable path (or a held Start-Process handle)—never bare JSON PID kills—remove harness temps when safe, keep install/uninstall assertions, and emit a short non-secret summary.

## Source incorporation

- Source copied or substantially adapted: no
- Files and upstream locations: none
- Required copyright or license notice location: n/a

## Verification plan

- Automated tests: portable Vitest for harness state/PID/receipt helpers under `apps/desktop/scripts/`; Windows CI continues to run NSIS install → smoke → uninstall.
- Negative and fail-closed tests: reject still-alive prior Electron/postgres/server identities (start time + path, not PID alone); refuse Stop-Process on identity mismatch; treat EPERM from `kill(pid,0)` as alive; reject bootstrap ciphertext drift; per-round receipts expose process identity, loginCount, and ciphertext digest only (no passwords/raw ciphertext); require fresh receipt paths; do not relax existing check inventory.
- Platforms and devices: Windows x64 hosted runner required for full evidence; Linux may run helper unit tests only.
- User-visible documentation and translations: bilingual Windows Desktop acceptance how-to.
- Support level that the evidence permits: installed native runtime cold-start conformance when CI prints the extended receipt; not SmartScreen, code signing, accessibility, or computer-control support.

## Unresolved questions

- Hosted Windows CI must still execute the ten cold-start lifetimes on this branch; Linux box evidence remains pending CI.

## Integration review: retained evidence and process handles

Reviewed 2026-09-13 before the alpha.8 integration changes:

- Existing reuse ledger entries for Windows Desktop and CI artifact retention apply.
- Reuse inbox .NET `System.Diagnostics.Process.Handle` and `Kill`, documented at
  https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.handle .
  Acquire and retain the process handle before checking start time and executable,
  then stop through that same object. A PID lookup followed by a fresh PID kill
  cannot establish ownership when Windows reuses process IDs.
- Reuse the already-pinned MIT `actions/upload-artifact` v7.0.1 at
  `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (source, tests, and action inputs:
  https://github.com/actions/upload-artifact/tree/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a).
  No new dependency or copied source. Store only explicitly projected round
  evidence, never the fixture profile, bootstrap ciphertext, password, or raw log.
- The integration gap is retaining all eleven validated process lifetimes and
  NSIS cleanup status after the private fixture is removed. The current successful
  log alone and a deleted final receipt do not provide that evidence.
- UtilityProcess identities must be observed after spawn and published before
  waiting for readiness, so a failed startup still has a bounded cleanup path.
  Electron 44.2.0 `utilityProcess` is already pinned; upstream contract:
  https://www.electronjs.org/docs/latest/api/utility-process .
- Verification: full repository check, native PowerShell parser and installed
  Windows runtime CI. CI results remain required; local helper tests do not prove
  DPAPI, Windows process cleanup, or successful installation.

### Native Windows CI follow-up

PR60 run `34746719361`, Windows job `103695874856`, failed two process
observation tests with `spawnSync powershell.exe ETIMEDOUT` at the unchanged
15-second bound, before installation. Review found that the new helper bypassed
the repository's established Windows launch contract. Reuse the fixed inbox
PowerShell path, encoded command, closed stdin, bounded output and direct .NET
calls already used by `windows-native-security.ts` and the native Node credential
ACL tests. Avoid cmdlet module autoload for process lookup and JSON output. The
failure alone does not prove whether stdin or cmdlet initialization caused the
hang; the corrected native CI must establish that the revised path works.

Primary contracts: Node 22.22.2 `child_process` stdio/execFileSync and Microsoft
PowerShell's `-EncodedCommand` UTF-16LE contract, plus .NET Process.GetProcessById.
No upstream source or new dependency is incorporated. The held Start-Process
object remains cleanup authority even if optional path metadata was unavailable;
JSON-only cleanup still requires full identity checks under a retained handle.
