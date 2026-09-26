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

Use the existing held-process observer with a small fixture-only progress adapter. Count files and bytes under the harness-created installation destination and observe CPU time on the held installer process; file growth or at least 250 ms of accumulated CPU work extends an idle deadline of 120 seconds, while an independent 300-second overall ceiling always applies. Polling evidence contains only elapsed time, byte/file counts and CPU duration. A live or CPU-busy process cannot pass by itself; successful exit still requires exit code zero, installed ASAR equality, native bootstrap, ten independent cold starts, cleanup and uninstall.

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

## PR #96: account for work before destination files appear (2026-09-26)

The [failed Windows job](https://github.com/Peerframe/openbot/actions/runs/36166820890/job/108176484131)
recorded zero destination files at 120 seconds, but the held installer's CPU time increased from
0.86 seconds at 75 seconds to 13.78 seconds at termination. The preceding successful job recorded
26.64 CPU seconds before the first destination files appeared, and completed installation in
117.34 seconds. The old observer ignored CPU work when calculating its idle deadline.

Rechecked the existing reuse entry and the pinned electron-builder 26.16.1 template at
`7d3b30f3b15950d19f7c5ff882cf2d161cd3ba2c`: its
[extractAppPackage.nsh](https://github.com/electron-userland/electron-builder/blob/7d3b30f3b15950d19f7c5ff882cf2d161cd3ba2c/packages/app-builder-lib/templates/nsis/include/extractAppPackage.nsh)
places the archive in `$PLUGINSDIR`, extracts it into `$PLUGINSDIR/7z-out`, and only then copies it
to the destination. Destination file growth therefore cannot observe that earlier work. This
explains the monitoring gap; it does not identify exactly which upstream operation consumed CPU
in the failed run. GitHub search `repo:electron-userland/electron-builder nsis installer slow
extraction TEMP` did not establish a matching upstream fix. Keep the pinned installer unchanged.

The existing [.NET TotalProcessorTime API](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.totalprocessortime)
provides accumulated processor time for the held process. Count accumulated increases of at least
250 ms as activity, without resetting the hard ceiling. The threshold avoids treating every tiny
timer wakeup as progress, and a busy loop still fails at the absolute limit. A missing CPU sample
must not invent activity. Do not enumerate other processes or scan the shared temporary directory.

Extend the real-process fixtures to cover CPU work without destination writes, CPU work followed
by a stall, and an endless CPU loop that hits the hard ceiling; retain file-progress, sleeping,
nonzero-exit and file-writing hard-limit cases. Windows CI must run these fixtures and the actual
installation, ASAR comparison, ten cold starts and uninstall. No dependency, copied source,
product-runtime change or weaker success condition is introduced.

Before hosted qualification, the old observer reproduced `stalled` at 2.5 seconds despite 2.78
CPU seconds. All seven real-process cases pass with the new observer on macOS PowerShell 7.5.2
and in the Linux PowerShell fixture; the CPU-only case fails against the old observer. These
validate the shared observer behavior and bounds, not Windows installation support.
