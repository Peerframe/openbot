# Research: bounded Windows installer progress

- Status: Accepted for implementation; native verification required
- Date: 2026-09-15
- Owner: OpenBot maintainers
- Acceptance journey: a progressing NSIS installation completes and then passes the existing installed-runtime, ten cold-start and uninstall checks; a stalled installation fails with bounded evidence and cleanup.
- Security boundary: observe only the fresh test installation directory and the held process launched by the harness. No user process discovery, security exclusions, installer behavior changes or credential logging.

## Search evidence

Reviewed the Windows cold-start and receipt lifecycle entries in `docs/OPEN_SOURCE_REUSE.md` and their research before expansion. GitHub searches on 2026-09-15: `repo:electron-userland/electron-builder nsis slow install timeout Get-CimInstance`; inspected the current open issue inventory, the pinned templates, MIT license and NSIS tests. No matching confirmed Windows native fix was found. The Wine PowerShell proposal [10042](https://github.com/electron-userland/electron-builder/pull/10042) concerns a different platform and is not adopted.

Primary references: [.NET bounded WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit), [Kill and descendant limitations](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill), and [NSIS silent command arguments](https://nsis.sourceforge.io/Which_command_line_parameters_can_be_used_to_configure_installers).

Evidence: PR #71's last successful native run installed and completed ten cold starts. Its install-preflight-to-first-Electron interval was 102.26 seconds, including installation and ASAR hashing. The final PR failed earlier with an HTTP 504 download; subsequent main and PR #72 native installation attempts hit the harness's unconditional 120-second cutoff. Current logs do not identify extraction versus process-check delay. Do not assert a product installer root cause before the added progress evidence is available.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Fit and decision |
| --- | --- | --- | --- | --- |
| Existing NSIS installer | electron-builder 26.16.1 / `7d3b30f3b15950d19f7c5ff882cf2d161cd3ba2c`; NSIS 3.0.4.1 | MIT; NSIS component licenses | Pinned released builder, NSIS templates and tests reviewed | Keep unchanged; no evidence supports a fork or disabling process/security checks |
| Existing PowerShell/.NET process API | PowerShell 7 hosted Windows runner; .NET `Process` and `Stopwatch` public API | MIT; Microsoft documentation terms | Existing native harness uses held process objects and bounded waits | Reuse polling and elapsed-time APIs, no dependency |
| Unconditional longer timeout or ignored failure | No upstream selected | Not applicable | Would provide no evidence of progress | Reject; distinguish stalled work from active extraction and retain a hard ceiling |

## Reuse decision

Use the existing held-process observer with a small fixture-only progress adapter. Count files and bytes under the harness-created installation destination; changes extend an idle deadline of 120 seconds, while an independent 300-second overall ceiling always applies. Polling evidence contains only elapsed time, byte/file counts and CPU duration. A live but stalled process cannot pass; successful exit still requires exit code zero, installed ASAR equality, native bootstrap, ten independent cold starts, cleanup and uninstall.

On timeout, terminate the held installer process tree and wait boundedly before uninstall/cleanup. `WaitForExit` proves the held process exited, not that arbitrary detached descendants did; do not enlarge claims beyond the existing fixture cleanup evidence. Add native fixture tests for progress, stall and the absolute ceiling, and keep all existing native checks.

If the actual installer still stalls, use this evidence to locate and fix the responsible upstream step; no timeout-only success claim. Remove this adapter if an upstream progress API supplies the same bounded fixture contract.

## Source incorporation

- Source copied or substantially adapted: no.
- Existing public .NET APIs only; installer templates and runtime packages remain unchanged.
- No additional license notices or dependencies.

## Verification plan

Run native Windows process fixtures in CI before packaging, then run the real installer and ten cold starts. Record progress even on failure in the existing allowlisted summary. Run `npm run check`; Linux/macOS checks do not replace Windows evidence. Maintain the Chinese research translation.

## Unresolved questions

Native CI must establish whether extraction actually continues beyond the former cutoff. A successful longer run without progress evidence is insufficient to classify the old failure.
