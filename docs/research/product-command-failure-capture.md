# Research: retain failed remote process evidence

- Status: narrow candidate repair; no new SSH connection or remote action.
- Date: 2026-09-25.
- Failure: stdout EOF/invalid protocol caused `gather` to raise, then finally cancelled stderr
  before writing it. The original process's diagnostic and exit code were lost.

Reuses the existing OpenSSH/command qualification review in OPEN_SOURCE_REUSE and
`product-command-remote-probe.md`. Inspected installed CPython **3.12.13** `Lib/asyncio/tasks.py`
(gather implementation/docstring) and the official Python3.12 [task documentation](https://docs.python.org/3.12/library/asyncio-task.html#asyncio.gather)
and [subprocess documentation](https://docs.python.org/3.12/library/asyncio-subprocess.html).
CPython is PSF-licensed; no source is copied. No dependency is added. `gather(return_exceptions=True)`
retains sibling readers after a protocol error. `wait_for` still sets the original170s capture ceiling;
partial buffers survive reader cancellation. Subprocess stdout and stderr are read concurrently.

The adapter reports the first observed failure promptly to pending readiness, then retains bounded
stdout/stderr prefixes and exit facts before rethrowing that same failure. It does not turn a timeout
into permission to resend. Capture stops at the existing limit; the pre-existing owned-process
termination/reap grace is not a new remote runtime window. Remote150s and all native limits unchanged.
Raw diagnostic files are0600, at most32KiB each, with enrollment values/prefixes redacted before writing.
Finite JSON metadata separates natural exit from local stop and flags incomplete/oversized captures.

Root's read-only findings: no remote run/Action reservation, helper/Node/socket/port absent; common
stage SSH flags worked. Run adds -R and timeout, then pre-try configuration/token/peer/listener/hash
checks. The four read-back sshd flags permit forwarding. No retained stderr exists, so the original
cause is **unknown pre-run**, not proven SSH-policy failure. This patch changes no argv or run conditions
and does not recover or repeat the consumed attempt. Root separately owns controlled unused-key cleanup.

Tests use synthetic streams, including delayed stderr after stdout EOF, early remote_finished,
oversized stderr, hanging stderr/exit, and token crossing the capture boundary. No remote qualification
or support claim follows from those tests.
