# Research: Python control-owned runtime supervision

- Date: 2026-09-23
- Status: S2b-2 control host/process seam accepted on local macOS and the Linux/amd64 fixture; persisted execution remains pending.
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

## Frozen control-host gates (implementation basis)

Port the existing AgentRuntimeHost responsibilities into a control-only adapter, using existing
Pydantic 2.13.5/RunUsage and stdlib dataclasses/asyncio/json. No model SDK belongs in this package
for this seam: a resolved trusted one-step model port owns provider-specific calls; the worker's
SDK owns iteration. Tools require explicit local schema validation and execution callbacks, a
web-budget flag and bounded result policy. Declarative catalogs omit executors and policy objects.

Preserve 8 model steps, 16 tool calls, 4 public-web calls, reported input/output thresholds, 64 tools,
64 KiB catalog, 128 messages/256 KiB conversation, 8 corrections/40 KiB, and per-tool output at most
128 KiB. Shared budgets survive a host continuation. A token count absent/invalid/overflowed at any
step remains unknown rather than becoming zero. Usage commits before the model response is released.
All async boundaries recheck authority, cancellation and the first latched failure. Concurrent
operations poison the invocation; only the operation that acquired the busy gate may release it.
Cancellation swallowed by a callback is detected before any later operation/publication.

Retain the original Server-bound instruction/messages; the child can never supply instructions,
provider settings, new user corrections or original media. Rebuild model history from the trusted
original context plus the child's validated wire tail. Additionally compare that tail against the
host's actual model/tool transcript before every model call: this prevents forged observations
from being presented as executed evidence. The fixed worker translation preserves text/tool order
and groups adjacent tool returns; the host records exactly that shape. This is a deliberate stronger
check than the current TypeScript host, using existing protocol data without a wire change.

Model tool calls are proposals, validated as a complete set. Only exact admitted IDs/names/arguments
can reach execution, and the intent is consumed before validation/side effects; failure never makes
it reusable. A consumed ID may be proposed again in a later step. Tool output must be completed,
finite bounded JSON and gets recorded only after scope checks. Final text must equal the last
admitted model answer after ECMAScript trimming, with no pending intent. The host returns text and
applied correction IDs only; it cannot write terminal state. SQL completion must separately lock
and recheck scope/corrections. A deterministic host test proves these gates, not provider integration.

The existing disposable Linux/amd64 runtime fixture will also install the already-reviewed
control requirements in a separate venv and run the control framing/host/process/real-worker
journeys. It keeps the same pinned CPython 3.12.13 and Node image digests, no production changes.
The control tests receive only PATH/LANG/LC_ALL; they cannot inherit the synthetic PostgreSQL
credential used by the earlier TS fixture. A missing worker environment fails this acceptance
entry instead of silently skipping real-worker tests. Hosted CI invokes this existing fixture.


The Linux qualification container must have an init process: a killed process group can leave an
orphan descendant awaiting PID 1 reaping; a shell wrapper is not a process reaper. Reuse Docker's
existing `--init` option for the acceptance runner only, as described in the
[official container guide](https://docs.docker.com/engine/containers/multi-service_container/).
The local engine is 29.5.2; reviewed the [matching CLI option](https://github.com/docker/cli/blob/v29.5.2/cli/command/container/opts.go)
and [Tini 0.19.0's process/reaping behavior](https://github.com/krallin/tini/blob/v0.19.0/README.md)
([MIT](https://github.com/krallin/tini/blob/v0.19.0/LICENSE)). This uses the engine-provided init;
OpenBot adds no binary or dependency and does not infer the engine's embedded Tini version from
the upstream tag. Record the actual init version during qualification. It does not change the
production image or weaken the no-network, no-capabilities, unprivileged test scope.

## Integrator correction: own the PID before attaching pipes

Actual cancellation probes found that `create_subprocess_exec` can still be connecting its pipes
when cancellation reaches `_make_subprocess_transport`. At CPython 3.12.13 that path closes the
transport, kills only its leader, and awaits exit; an early fork can retain a pipe and survive.
Shielding creation for a fixed grace does not solve a connection that never finishes: abandoning
it still loses the group. Root takes over the lifecycle fix after stopping the assisted writer.

Reuse `subprocess.Popen` synchronously (as asyncio itself does) to retain the PID before the first
suspension, then attach the standard library's `connect_read_pipe`/`connect_write_pipe`,
`StreamReaderProtocol`, `StreamWriter` and existing `asyncio.streams.FlowControlMixin` for
backpressure. Reviewed [3.12.13 streams source](https://github.com/python/cpython/blob/v3.12.13/Lib/asyncio/streams.py)
and the [official pipe API](https://docs.python.org/3.12/library/asyncio-eventloop.html#asyncio.loop.connect_write_pipe).
No upstream source is copied. The mixin is a pinned stdlib implementation detail; the actual
CPython reference and process tests are required before changing interpreter support. Polling
Popen's maintained waitpid implementation avoids detached wait threads and keeps cleanup owned.
No shell, preexec_fn, credential, new dependency or model-controlled path is introduced.

Cancellation during a pipe attachment can now cancel that attachment while the already-owned PID
and raw pipes remain available to group termination and bounded reaping. First cancellation during
successful cleanup must also be re-raised; repeated cancellation must not replace an earlier
Server denial or interrupt teardown. OS process creation itself is synchronous, just as in the
original asyncio implementation; this is not an operating-system sandbox or an OS-hang watchdog.


## Local integration evidence

The integrator accepted the assisted wire validation and fault fixtures, independently implemented
control model/tool gates, and took over the process lifecycle after reproducing three cancellation
failures. Final local package verification passes 651 cases; 45 database-dependent cases skip in
that invocation and pass separately in the owned PostgreSQL/HTTP fixture. The process/actual-SDK
selection passes 83 cases without unraisable resource warnings. It includes cancellation before
startup, during pipe attachment (including attachment that never completes), during dispatch and
during otherwise successful cleanup, plus repeated cancellation and inherited descendants.

The control host passes 49 cases, including exact tool intent consumption, transcript forgery,
usage/authority failure, unknown usage counts, shared budgets and a provider callback swallowing a
stream refusal. The final answer cannot bypass a latched refusal. The installed TS/Python oracle
agrees on 48 profile cases; existing 129 input and 60 task projection comparisons and the full
repository check pass. These counts describe different suites, not user-task success rates.

The actual SDK is separately installed, while model/tool ports are deterministic. No live model,
production database, external write, task HTTP dispatch, persisted execution completion, approval
or restart recovery is claimed. The next persisted lifecycle boundary is recorded in
[task authority](python-task-authority.md).


Linux/amd64 qualification passed in the owned Docker fixture: 418 existing SDK-worker cases,
222 existing TS Server/real-PostgreSQL cases, and 306 Python control host/wire/process/actual-SDK
cases. Docker Engine 29.5.2 supplied `tini version 0.19.0 - git.de40ad0`; the fixture runs unprivileged,
without capabilities or external networking. Its containers and tagged image were removed by the
fixture cleanup. The TS headless task/artifact checks remain TS-authority evidence; they do not
turn the Python queued-only HTTP reference into a completed execution service. Hosted CI has not
run for this unpushed change; the existing job invokes the same entrypoint. Windows is unclaimed.
