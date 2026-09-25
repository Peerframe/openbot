# Durable product tool results

- Status: implementation review, 2026-09-25; opt-in product composition.
- Acceptance: a deferred tool's actual bounded JSON result reaches the next model turn;
  loss of the Activity acknowledgement reads the same committed bytes without another call.
- Security boundary: Server Action admission still grants execution. Tool output is untrusted
  data, never permission, independent business-effect verification, or proof of task quality.

## Reuse review before implementation

Reviewed the existing reuse-ledger entries for product deferred approval, model observations,
corrections and the product Worker, including their release/source/test/license and issue reviews.
Rechecked GitHub release/search results for `pydantic-ai v2.47.0 DeferredToolResults` and
`temporalio sdk-python 1.33.0`, and the official
[deferred-tool contract](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/).
Pydantic AI [2.47.0](https://github.com/pydantic/pydantic-ai/releases/tag/v2.47.0),
commit `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`, and Temporal Python
[1.33.0](https://github.com/temporalio/sdk-python/releases/tag/1.33.0), commit
`ab52fdde33ee8ed193402625bfdba25d240a762d`, remain the pinned MIT dependencies.
The installed pinned `_deferred.py`, `toolsets/external.py`, existing continuation tests and
Worker code were inspected. The SDK already supports JSON results indexed by tool-call ID;
Temporal already records Activity outcomes. Neither owns OpenBot's authority or private receipts.
GitHub source/issue pages were intermittently unavailable; retained reviewed sources and the
installed exact release were used, without claiming a new complete upstream issue audit.

Select a thin adapter over those released APIs, PostgreSQL 17.11 and the existing immutable blob
store. The exact local gap is that current deferred outcomes contain only Action status, dropping
the content required by real reads. No alternate engine, framework, dependency or copied upstream
implementation is needed. The existing project MIT notice remains unchanged.

## Contract

- Add one private tool-observation table. Bind each immutable JSON blob to the admitted Action,
  Task, Run and intent digest. Enforce the existing Runtime 128 KiB tool-result ceiling, strict
  bounded JSON, hash/size readback and exact original settlement evidence. No public receipt write.
- A control adapter may record an actually received tool response before acknowledgement. Its
  receipt proves only that response was observed, including reported tool errors. It cannot prove
  a remote business effect or task correctness. Lost/unrecorded responses stay unknown; recovery
  performs stored readback only and never resends the tool. Adapters needing authoritative remote
  effect lookup retain the existing separate EffectServices contract.
- Supply an optional trusted result reader to the product Worker. A separate Activity rechecks
  accepted identity, Task authority, applied Action scope, result bounds and reader-specific
  content permissions. Recorded `load_task.toolResultProtocol=1` selects it for new executions;
  historical load results without this flag retain their exact command path. No global default.
- Keep corrected and uncorrected workflow behavior aligned. Superseded proposals return status
  without invented results. The result-reader callback receives the Action's original correction
  context, and must independently revalidate any versioned or revoked knowledge.
- Reuse the existing `runtime_host.json_copy` tool contract (128 KiB, 64-level depth, completed
  strict JSON) and sort object keys for immutable observation bytes. Action intents keep their
  unchanged narrower codec. Independent review reproduced valid long/empty keys, NUL text,
  5,000-element arrays, 13-level nesting and large integers that an initial shared Action codec
  would wrongly reject after execution; that candidate was corrected before qualification.

## Verification

Actual owned PostgreSQL tests cover acknowledgement loss, immutable results, corruption, wrong
scope, missing settled observations, pending approval, cancellation and unknown readback without
resend. Workflow tests cover the old recorded path and the opt-in result path; actual Temporal
history/replay will be checked during product composition. This slice alone does not activate
automatic execution, verify task quality, or qualify Linux isolation.

## Adjacent product admission seam

Real product model composition also requires the existing Action admission transaction to recheck
its selected configuration and consumed data. An optional trusted async callback receives the same
transaction and detached Task/Action records and must return exactly `True`; the existing final
fence check still runs after it. Missing callbacks retain old behavior. Public inputs cannot select
or supply a callback. The model Action records a closed non-secret configuration projection
(source, revision, provider, model, endpoint, protocol and optional connection ID), so a rotated
configuration cannot silently change an already proposed operation. The existing no-resend model
receipt path remains the recovery owner. Product composition research and synthetic transport
qualification are in the separate product-model packet; no automatic dispatch is enabled here.
