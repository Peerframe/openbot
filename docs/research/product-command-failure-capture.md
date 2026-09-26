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

## Product2 input-bound diagnosis — 2026-09-25

The explicitly approved fresh product2 attempt preserved a finite pre-run diagnostic at
`read_stdin`: the unchanged command codec accepts only512/8192/16384/32768-byte classes,
while the fixture called it with1024. Local reproduction using the actual codec and an86-byte
synthetic enrollment message rejects1024 and accepts512. No Node, Action or native unit started;
the original pre-run cleanup removed the unused key, and read-only reconciliation confirmed no
fixture process/socket/forward, unchanged10 production containers and unchanged firewall rules.

Reuse the existing reviewed strict JSON codec and its512-byte class for this tiny envelope;
do not broaden the codec or change native/Host/crypto pins. This narrows the fixture input ceiling
and preserves duplicate-key, malformed-value and size rejection. The earlier preflight tests
mocked the parser, so add real stdin-to-codec coverage through the preflight entry, with external
native checks stubbed. The consumed remote identity remains consumed; a future attempt requires
its own authorized fresh packet. No external implementation or dependency is added.
