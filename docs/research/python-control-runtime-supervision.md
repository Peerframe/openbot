# Research: Python control-owned runtime supervision

- Date: 2026-09-23
- Status: S2b-2 design frozen; implementation and process acceptance pending.
- OpenBot baseline: 1057104 (queued task reference); existing runtime profile v1 unchanged.
- Selected implementation: CPython 3.12.13 standard-library subprocess/asyncio/json, with a thin
  adapter for the already-frozen OpenBot profile. No added dependency or copied upstream source.

## Primary-source review

The installed interpreter reports 3.12.13. Reviewed the matching
[asyncio subprocess source](https://github.com/python/cpython/blob/v3.12.13/Lib/asyncio/subprocess.py),
[tests](https://github.com/python/cpython/blob/v3.12.13/Lib/test/test_asyncio/test_subprocess.py),
and [PSF license](https://github.com/python/cpython/blob/v3.12.13/LICENSE). The test source was also
retrieved directly from that fixed tag after the browser reader failed. Tests exercise process
sessions, kill/terminate, broken pipes, stream backpressure and cancellation during waiting/spawn.
No tests from upstream will be copied into OpenBot.

The [official subprocess API](https://docs.python.org/3.12/library/asyncio-subprocess.html) exposes
exec without a shell, bounded stream-reader buffers and asynchronous process waiting. It warns
that waiting without draining both output pipes can deadlock. communicate collects output and
closes stdin, so it cannot replace the interactive bounded RPC transport here. The current online
documentation labels itself 3.12.14; exact source compatibility is checked against installed 3.12.13.

Reviewed upstream issue [139373](https://github.com/python/cpython/issues/139373) on cancellation
of communicate and [114177](https://github.com/python/cpython/issues/114177) on subprocess teardown
when a loop closes. Both pages currently say closed; that is not proof that every fix is present
in 3.12.13. The adapter must own explicit bounded draining, group termination and reaping before
returning, and tests must cover cancellation while spawning or dispatching. Destructor cleanup is
not an acceptance condition.

## Reuse decision and boundary

The existing [runtime profile](../AGENT_RUNTIME_PROTOCOL.md), TypeScript agent-runtime-process.ts
and agent-runtime-wire.ts remain the executable compatibility reference. The accepted Python
worker already runs the real SDK. Do not add another agent loop, change the wire or add a generic
JSON-RPC server. Standard-library APIs are the first viable maintained implementation for process
lifetime. The local adapter only supplies profile-specific bounds, direction/ID validation,
dispatch sequencing and fixed failure mapping; generic JSON-RPC packages do not remove those rules.

The control package must not import openbot_agent_runtime: its package initializer loads the SDK
and would couple trusted control dependencies to the worker environment. The existing child wire
module is a reference for strict JSON and limits, not a justification to import the runtime into
control or copy its entire file-descriptor transport. Parent-side async streams are a different
adapter to the same frozen protocol. A future shared pure codec is possible only after both
adapters' packaging and security tests justify that extraction.

POSIX reference only: use a fresh invocation-owned working directory, absolute trusted executable,
fixed trusted arguments, no shell, only LANG/LC_ALL in the child environment, and a new session.
No task/model may supply any executable path, environment, DB handle, credential or working path.
This is process supervision, not an OS sandbox. Linux qualification remains explicit; Windows is
unclaimed. Model/tool authority and final publication stay in the control host and database.

## Frozen supervision seam

`supervise_runtime(executable, args, invocation, dispatch, *, deadline_seconds) -> str` is an
internal trusted-code seam, never an HTTP endpoint. It runs one invocation, enforces all v1 frame,
byte, depth, stderr, ID and request-count bounds, and invokes one async dispatch at a time. It must
observe incoming frames concurrently with dispatch so overlapping requests fail instead of being
queued as if they arrived later. A Server dispatch exception remains authoritative; a late child
result cannot replace it. No retry/resume occurs in this adapter.

The returned text is provisional: one final response, no outstanding operation, clean stdout EOF,
zero exit and successful bounded cleanup are required. The control host later verifies it equals
the last admitted model answer and rechecks stored scope before publication. Cancellation closes
pipes, terminates only the invocation's process group, escalates to SIGKILL and waits for reaping;
it never returns success. A child that returns a result then hangs fails within one second.

Root owns authority, model/tool intent admission, SQL claim/complete/fail/cancel, composition and
independent integration. The assisted worker may own pure framing and the subprocess adapter with
synthetic process tests. No package initializer, application startup, live model, schema or current
default selection changes belong to that task. Child-process tests must be independent of model
credentials and may exercise the installed worker with a deterministic parent once integrated.

## Required gates

- Real child success; split and invalid UTF-8/JSON, duplicate keys, excess nesting/non-finite values;
  frame/byte/count/stderr limits and unterminated output; unknown/extra methods and keys.
- Replayed/skipped IDs, overlapping requests, final while busy, extra frames after final, premature
  EOF/nonzero exit, forged result, dispatcher failure followed by claimed success, result then hang.
- Deadline; cancellation before/during spawn and during dispatch; bounded SIGKILL escalation and
  inherited-pipe descendants; no live owned processes or leftover working directories.
- Exact actual TS/Python contract differential where both implementations admit the same valid
  profile. Deliberate stricter duplicate-key handling remains documented, not hidden as parity.
- Root's separate authority and PostgreSQL tests establish claims, revocation, terminal exclusivity
  and no duplicate publication. A subprocess test cannot substitute for those database gates.
