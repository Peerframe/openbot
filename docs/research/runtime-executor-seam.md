# Research: Server-selected runtime executor

- Status: Accepted for implementation
- Date: 2026-09-23
- Owner: OpenBot maintainers
- Acceptance journey: Compose a replacement executor through the real Server runner without
  moving task completion, reports, identity or authorization out of the Server.
- Security boundary: The injected function is trusted Server adapter code. An external worker
  cannot supply this function, select an executor, receive these ports verbatim or commit a Run.

## Search evidence

Reuse the completed native Agent, usage/cancellation and report entries in OPEN_SOURCE_REUSE.md,
plus [runtime execution ports](runtime-execution-ports.md) and
[headless acceptance](headless-runtime-acceptance.md). Reviewed OpenBot candidate commits
`7097c287b03365f7ef416c3634782e821c142ae9` and `32a990d1478ed9e3299aab2fae27cf84d69b584d` from candidate head
`3249c80b97b1ef35a4adf0e344bb82475eba647c`; selectively applied the two commits to main `ebce995`.

The existing review pins ai 7.0.93 to `6359fd58fe68eaade096b5d923bac26de84ca3bd`, its
ToolLoopAgent source, mock tests and issues 18518/15864. Reused that evidence and inspected the
installed SDK, local abortable helper and native runner completion path on 2026-09-23. A fresh
[reference fetch](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) returned an
unsupported text/markdown response in the web reader; it is not claimed as new evidence.
No dependency or new wire protocol is introduced by this slice.

## Candidate comparison

| Candidate | Pin | License | Fit and decision |
| --- | --- | --- | --- |
| Existing SDK Agent interface and explicit execution ports | ai 7.0.93 / 6359fd58; OpenBot candidate 3249c80 | Apache-2.0; MIT | Retain real SDK iteration and add a typed Server composition seam |
| Select runtime from model output or imported skill | Not selected | Not applicable | Would let untrusted content select authority-bearing code; reject |
| New service, database or public runtime registry | Not selected | Not applicable | Not needed to compose one reviewed adapter; defer |

## Reuse decision

Use the existing dependency and a thin local adapter. The exact gap is the hardcoded executor
call inside executeAgentRun. Add an optional Server-owned executor function, retaining the current
implementation by default. Pass it from NativeAgentRunner for roots, continuations and children.
The runner continues to own durable completion, errors, artifacts and publication.

Retain a durable-port failure even when an SDK catches a usage/audit/correction callback error,
so such a result cannot be committed. Validate the result at the Server boundary even for replacement adapters: bounded nonempty text,
unique bounded correction IDs previously read from the bound storage port, and active authority
before entry and after return. Race the executor against cancellation so an adapter that ignores
its signal cannot keep runner shutdown or final success pending indefinitely. This does not
terminate an external process or undo a tool effect; a subprocess adapter must separately own
its cleanup, tool/model gates, framing, budgets and integration acceptance.

A function boundary is not an OS sandbox. The trusted adapter still has local model/tool ports;
these must never be serialized wholesale to a worker. Python is not enabled by this change.

## Source incorporation

No upstream source copied or substantially adapted. Reuse existing OpenBot MIT code and ai APIs;
existing notices remain applicable.

## Verification plan

Test replacement dispatch, observed correction binding, invalid/oversized results, pre/post-return
revocation, cancellation of an uncooperative adapter and shared budget identity. Run the real SDK
native tests, disposable PostgreSQL headless journey and full npm run check. Document the seam
and current support boundary in both runtime manuals. No live provider or Python integration
claim follows from these checks.

## Python environment coexistence

The first combined check found that the documentation walker traversed installed SDK docs inside
`apps/agent-runtime-python/.venv` and reported upstream links omitted from the distribution.
Python 3.12 [venv documentation](https://docs.python.org/3.12/library/venv.html) describes virtual
environments as disposable and not checked into source control. Exclude `.venv` from repository
documentation and Biome traversal, just as existing `node_modules` is excluded. Continue checking
all authored Python-package Markdown. This changes no product behavior or dependency and copies
no upstream source. The failing installed-environment check is the regression evidence; rerun
docs and the full check with that same virtualenv present.

## Verification results (2026-09-23)

- Focused Server executor/SDK/native checks: 104 passed, including 16 adapter-boundary cases.
- `npm run test:runtime`: 129 passed against an invocation-owned PostgreSQL 17.11 fixture;
  fixture cleanup succeeded. This includes the real Owner API, delivery, cancellation, continuation
  and collaboration tests; no paid model or personal database was used.
- Full `npm run check` passed with Node 26.0.0 and npm 10.9.9. Server: 541 passed / 75 skipped;
  Web: 329 passed; Desktop: 359 passed / 1 skipped; Node: 51 passed / 3 skipped. The explicit
  headless command runs the relevant database suites that the default full check skips.
- Local evidence is a macOS host plus the Linux PostgreSQL fixture. Python execution, production
  subprocess isolation and Linux application compatibility are not established by this slice.

## Integration follow-up

Reuse the existing digest-pinned PostgreSQL CI service, disposable collaboration database and
required `database` job (existing [CI gate review](windows-ci-merge-gate.md)); add the headless
suite to its invocation with one worker and no file parallelism, because both suites reset that
fixture. No new action, credential or service is required. Hosted execution is not yet verified.
The first report-download acceptance now explicitly selects the replacement executor seam.

One concurrent local rerun passed 128 cases but hit Vitest's default five-second test timeout in
the saturation case, which seeds fifty complete Run/proposal transactions before testing delivery.
Give that individual fixture-heavy test a bounded 30-second total allowance; retain the four-second
terminal-state assertion. This changes the setup allowance, not product deadlines or assertions.
