# OpenBot Python execution unit

A bounded, SDK-backed Python agent loop that **proposes** actions and owns no task
state. It is the reference implementation for OpenBot agent behaviour; the Server
remains the only authority for identity, tasks, routing, authorisation, approvals,
budget, artifacts, audit and persistence.

Status: implementation slice only. No persistence engine, no provider credentials,
no OS isolation. A normal Python process is not a sandbox, and nothing here claims
to be one. The one-invocation process adapter (below) is a *framing and lifecycle*
contract, not a security boundary: it does not confine the interpreter, and the
Server must still supervise the process.

## What it does

One call drives one bounded run through four ports supplied by a trusted host
adapter (in-process, or over the process profile in the next section but one; a
Server adapter owns the real implementations):

| Port | Required | Called | Purpose |
| --- | --- | --- | --- |
| `authority` | yes | before and after every awaited boundary, and before a result | Server guard for this exact run. A missing port, or one that answers without awaiting, fails the run closed. |
| `model` | yes | once per SDK model step | Receives bounded messages, the descriptors actually offered and the step index; returns a `pydantic_ai` `ModelResponse`. The Server adapter owns real step authority and usage persistence here. |
| `tool` | yes | once per admitted tool call | Receives the tool name, schema-validated arguments and the SDK call identifier. The identifier is **correlation only**: it is model-invocation data (the provider's tool-call entry, or an SDK-generated stand-in), so it is never authority and never an exactly-once key. The runtime performs no local effects. |
| `corrections`, `progress` | no | once / per stage | Non-durable. The runtime stores nothing and claims no durable state. |

The result carries bounded final text plus the identifiers of corrections actually
applied. It never carries run status, usage, artifacts, approval outcomes,
credentials, database handles or any Server write.

## Bounds

* Reviewed Server ceilings, kept as ceilings: **8** model steps, **16** tool calls,
  **128 KiB** per tool result (matching `AgentRuntimeToolPolicy.maximumResultBytes`
  in `apps/server/src/agent-runtime.ts`).
* Runtime-local bounds on catalog size and bytes, message bytes, history length,
  final output bytes, progress events and corrections.
* The Server may tighten any limit. A limit above its ceiling is refused **before**
  the run starts, so a looser budget cannot be smuggled in.
* Every bound is measured in UTF-8 **bytes** on the payload that would actually
  cross the boundary. Oversize tool results are refused, never truncated.
* One absolute monotonic deadline covers the **whole** run — the entry authority
  check, the corrections read, the SDK run and the exit authority check — rather than
  only the model loop. Preparation cannot reset it. Declared tool input schemas are
  self-contained: external `$ref`/`$dynamicRef` resolution is impossible, so argument
  validation can never fetch a URI.

Tool schemas are compiled with the reviewed `jsonschema-rs` dependency and `offline=True`.
External references fail during catalog admission, before any model/tool work; internal references
still work. Unicode ECMA patterns are retained with explicit backtracking and compilation bounds.

## Refusal semantics

* There is no permissive fallback. Authority, model and tool ports are mandatory.
* Failures are sticky: the first refusal seals the run, and a later attempt can only
  re-raise it. A port that swallows a cancellation and returns late therefore cannot
  produce a success.
* A refused tool call is never converted into a retry prompt or a failed observation.
  The SDK converts exactly `ToolFailed` and `ModelRetry` that way, so the runtime
  never raises either from a port failure, and the model is never asked again after a
  failure.
* Authority is re-checked after **every** awaited boundary, including the progress
  event; a revocation that happens while progress is emitted stops the step before the
  model port is asked to work.
* A blank or whitespace-only answer is refused (`output_invalid`) and accepted text is
  trimmed, matching the Server's own final validation.
* The tool-call identifier is treated as **correlation data only**. It is never passed
  to the authority port (which takes no arguments at all), so a well-formed or
  freshly chosen identifier grants nothing and cannot restore withdrawn authority.
  The `duplicate_tool_call` refusal catches only a literal repeat of one identifier
  inside one model response; it is **not** replay protection, and identical name-plus-arguments
  under a fresh identifier is admitted twice. A later model step may also reuse a
  consumed ID for a newly proposed intent. Exactly-once effect safety is the
  Server's, at authorisation or at the effect itself.
* Cancelling the caller's task re-raises `CancelledError`; it never becomes a result.
* The unit writes nothing to stdout on its own: the SDK's first-run banner is
  disabled, and a fresh-interpreter test asserts a completed run prints only what the
  caller asked for.

## Optional Temporal composition

`openbot_agent_runtime.temporal_agent.build_temporal_agent` composes one Agent before Worker
startup in the separately pinned Pydantic AI 2.47.0 / Temporal 1.33.0 environment. Typed per-Run
deps reach trusted sync/async factories only inside activities. Workflow preparation and replay
receive inert model metadata that cannot issue a request. Factories must create fresh ports and
bind deps to the accepted engine identity; control still owns authorization and durable budgets.

This builder does not replace `BoundedExecutor.execute`, apply corrections, validate final output
or publish completion. No default Runtime dependency or process profile changes. The real
[two-Run probe](../../experiments/work-journey/multirun_port_probe.py) checks overlapping isolated
calls and history replay without host work; it does not prove Worker crash recovery or S3 completion.
In the [pinned experiment environment](../../experiments/work-journey/README.md), run
`python -B experiments/work-journey/multirun_port_probe.py --address <owned-disposable-Temporal-address>`.
Never point the probe at a production namespace.

## Process adapter (`scripts/run-worker.py`)

The reviewed profile `openbot-agent-runtime/1` (fixed in `docs/AGENT_RUNTIME_PROTOCOL.md`) is a
**one-invocation** contract: one child, one request, one terminal frame, exit. The same unit above can
be driven in-process, or as this process with a trusted parent supplying the ports over pipes:

```sh
<package>/.venv/bin/python -I -u <package>/scripts/run-worker.py
```

* **Framing.** JSON-RPC 2.0, one object per line (UTF-8, LF-delimited) on stdin, answers on stdout.
  The child writes protocol frames to stdout only; stderr is never used for protocol, and a test
  asserts a clean stdout and empty stderr.
* **What the parent may send.** Exactly one `runtime.execute` request for id `run`, with
  `{protocol, tools[], deadlineMs}`, then one reply per child request. Batches, notifications, unknown
  fields, duplicate or replayed ids, non-finite JSON and invalid UTF-8 are refused.
* **What the child sends.** At most one outstanding request at a time, with monotonic ids `w1 … w512`:
  `authority.check` (empty params, empty result), `model.generate` (bounded messages) and
  `tool.execute` (id, name, validated arguments). A reply reuses the request id and carries exactly one
  of `result`/`error`.
* **Bounds.** 512 KiB per frame (excluding the newline), 8 MiB and 1024 frames per direction, 64 KiB of
  stderr, JSON nesting depth ≤ 64, and finite JSON only.
* **Lifecycle.** Parent EOF at any await cancels the run before it can publish. Success writes one
  `result` frame and exits `0`. A refused run writes one fixed `error` frame and exits `1`. A broken
  channel is closed with a fixed JSON-RPC error and exits `2`. Nothing is ever replayed or retried.
* **Isolation it does claim.** The child adds only its own resolved `src` directory to `sys.path`,
  derives no path from the environment or cwd, opens no network, database or plugin surface, and reads
  no credential. `-I` keeps the working directory and `PYTHONPATH` out of the import path.

The frozen limits the adapter fixes are the profile's own: `catalog_tools=64`, `history_messages=128`,
`output_bytes=32000`. No counter, correction id or usage reading is added to the final wire response —
those are Server-owned and have no port here.

## Layout

```
src/openbot_agent_runtime/
  contracts.py   typed request/result, limits and port protocols
  errors.py      closed failure vocabulary + advisory Server code mapping
  bounds.py      UTF-8 byte accounting and one-JSON-value checks
  catalog.py     catalog admission and JSON Schema argument validation ($ref never fetched)
  guard.py       authority checks, counters, one absolute deadline and the failure seal
  sdk_ports.py   the only two SDK touch points (PortModel, PortToolset)
  executor.py    composition and the bounded run
  wire.py        the process profile's framing and JSON codec (newline frames, strict bounds)
  profile.py     wire <-> SDK mapping: request parsing, message shapes, reason vocabulary
  worker.py      the one-invocation session: the three RPC ports, lifecycle and exit codes
requirements.lock          the frozen development closure (23 pins)
requirements-runtime.lock  the frozen runtime-only closure (18 pins, no test tooling)
scripts/
  bootstrap.sh            the only networked step: creates ./.venv from requirements.lock
  check.sh                verifies the dev profile, then runs the tests
  run-worker.py           the trusted process entry point (adds its own src dir, then serves stdin)
  verify_environment.py   profile-aware environment verifier (dev | runtime | auto)
tests/           deterministic fakes only: no paid API, no credentials, no database
RESEARCH.md      pinned upstream evidence for every SDK behaviour relied on
```

## Dependency profiles (`scripts/verify_environment.py`)

Two locked environments are approved. The **development** profile (`requirements.lock`, 23 pins) is the
default and includes the test runner. The **runtime** profile (`requirements-runtime.lock`, 18 pins) is
the same closure at the same pins with the test tooling removed, so a production image never ships
pytest. The split is derived from installed distribution metadata rather than guessed: `pytest` is the
only distribution that reaches `iniconfig`, `packaging`, `pluggy` and `Pygments`, and nothing in the
runtime closure reaches them (see [RESEARCH.md](RESEARCH.md) §10).

```sh
./.venv/bin/python scripts/verify_environment.py                   # dev (the default)
./.venv/bin/python scripts/verify_environment.py --profile dev
./.venv/bin/python scripts/verify_environment.py --profile runtime
./.venv/bin/python scripts/verify_environment.py --profile auto
```

* `dev` and `runtime` each check one exact lock: every pin installed at exactly that version, nothing
  else installed except `pip`/`setuptools`/`wheel`, and every direct pin of that profile present in the
  lock at the same version.
* `auto` matches the installed distributions against a *whole* lock and then applies that profile's
  checks. It succeeds only on an exact match, because a partial development install, a missing runtime
  pin, a version drift and an extra package are one and the same problem: the environment is not one
  this package approved. This is the mode the Server's startup preflight runs.
* Lock files accept only bare `name==version` pins. Non-pin lines, pip options and duplicate entries
  (even at the same version) are errors; none is silently skipped.
* The verifier reads distribution metadata only. It never installs, never uses the network, and takes no
  lock path from the caller: the lock is a fixed file beside the package, so it resolves identically
  from any working directory and under `python -I`.
* Exit status is `0` on a match, `1` for a lock or drift problem, and `2` for an invalid `--profile`
  value.

## Running the checks

```sh
./scripts/bootstrap.sh   # the only networked step: creates ./.venv from requirements.lock
./scripts/check.sh       # verifies the dev profile, then runs the tests
```

`check.sh` never installs anything: a missing environment is a failure. Requires
CPython >= 3.12 (`asyncio.timeout`); the pinned SDK itself only needs 3.10.

## Known limits

* Package tests use synthetic ports/parents. The separate real Server/PostgreSQL lane
  passed 222 cases on macOS with this child; see the [runtime guide](../../docs/NATIVE_AGENT.md).
  OS isolation, crash recovery and live provider quality are not established by those tests.
* `format` keywords in declared tool input schemas are annotations, not assertions:
  `validate_formats=False` is explicit.
* `ToolDescriptor` names are restricted to `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}` and
  input schemas must describe an object.
* The unit provides **no idempotency or replay protection** for tool effects, and does
  not claim any: the only per-call identifier it is given is model-invocation data.
  Exactly-once behaviour has to come from the Server's authorisation or from the
  effect itself.
* The process profile is implemented and covered by subprocess tests, but those tests use a
  *synthetic* parent. End-to-end behaviour against the Server's own process adapter is a Server-owned
  integration gate; its evidence is recorded in the runtime guide.
* The Linux/amd64 reference container passed 369 package and 222 Server/PostgreSQL tests.
  It ran under emulation on an ARM Mac; native hosted CI, Windows and production packaging are
  not established by that result. The existing TypeScript runtime remains the default.
* Profile tests use real locks, synthetic installed sets and the exact Server preflight invocation.
  The opt-in Server image separately verifies the installed runtime closure and actual SDK/tool loop;
  see [container verification](../../docs/SERVER_CONTAINER.md#optional-python-execution-image).
  These checks do not establish OS isolation or live-provider behavior.
* Running `--profile runtime` in a development checkout is *expected* to fail: it reports the five
  test-only distributions as unexpected. That is the check working, not drift.
* The adapter reads no environment variable and loads no provider client — asserted by tests — but
  `-I` does not hide `os.environ`, so this is a property of this code, not of the interpreter switch.
* No streaming: the child emits exactly one terminal frame and exits. Progressive output is not part of
  this profile.
