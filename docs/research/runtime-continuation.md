# Research: cross-process pause/resume of an agent segment with the pinned SDK

- Status: independently reproduced; narrow SDK compatibility evidence
- Date: 2026-09-23
- Owner: WorkBuddy (TASK018 dispatch); Codex owns independent acceptance
- Related issue: none (task card `.workbuddy-handoff/TASK_018_RUNTIME_CONTINUATION.md`)
- Acceptance journey: a scripted SDK model requests two tools; both are deferred without side effects;
  the SDK's own message history is checkpointed to a file, the first process exits, a fresh Python
  process restores it, supplies control-provided outcomes through the SDK's official continuation
  argument, and produces the final report without reissuing the original model request or repeating a
  completed tool.
- Security boundary: a scripted in-process `Model` and a synthetic temporary directory only; no
  provider API, credentials, network, product code, dependency install, database or worker is touched.
  The experiment measures what the SDK validates on its own and does not claim the SDK authenticates
  histories, results or authority.

## Search evidence

- Date 2026-09-23. GitHub queries: `pydantic-ai deferred tools`,
  `pydantic-ai DeferredToolRequests resume`, `pydantic-ai CallDeferred`,
  `pydantic-ai human in the loop tool approval`, `pydantic-ai durable execution checkpoints`.
- Primary documentation: the Pydantic AI deferred-tools page, the durable execution backends page and
  the installed distribution metadata (license/version), fetched 2026-09-23.
- Existing OpenBot entries checked: `apps/agent-runtime-python/RESEARCH.md` (§1 pin, §2 API surface,
  §3 probes, §3a.6 banner, §3a.9 near-miss serialization, §5 constraints),
  `docs/WORK_EXECUTION_CONTRACT.md` ("One owner of continuation"), `docs/OPEN_SOURCE_REUSE.md`.
  TASK016's durability review is not repeated; this note covers only the continuation seam.

## Candidate comparison

| Candidate | Exact release or commit | License | Maintenance and tests | Platform/API/security fit | Decision |
| --- | --- | --- | --- | --- | --- |
| SDK deferred tools (`ExternalToolset`, `CallDeferred`, `ApprovalRequired`, `Agent.run(deferred_tool_results=...)`) | `pydantic-ai-slim==2.47.0`, tag commit `77d5fce751ab8ab04bd5db4ed6acc1131a4baed6` | MIT | shipped by the pinned dependency already reviewed in `RESEARCH.md` §1; upstream tests and docs fetched from the tag | released stop-the-world API; the caller owns the checkpoint, the wait and the trust decision | selected |
| `pydantic_ai.durable_exec` integrations (`TemporalDurability` / deprecated `TemporalAgent`, plus the DBOS and Prefect variants) | same commit | MIT | present in the installed source; the engine packages are **not installed** in this venv, so this row was read, not run | mature: `TemporalDurability` routes model requests and toolset I/O through Temporal activities inside a workflow (`durable_unit_noun='activity'`, `IDENTITY_CODEC`), wraps function/MCP/dynamic toolsets with per-tool `ActivityConfig` for retry/heartbeat semantics, and its `run`/`run_sync`/`run_stream` accept `deferred_tool_results` | **retained as a later candidate.** One deferred-tools probe cannot rank or rule out the official durable integration; engine selection stays open |
| Custom graph/node serialization of the SDK internals | n/a | n/a | would require reimplementing the SDK's run graph and its private state | new local protocol with no upstream commitment; the SDK already ships a reviewed continuation interface | rejected |

## Reuse decision

- Selected option: dependency (released SDK API), plus a thin control-side envelope owned by OpenBot.
- Selected upstream: `pydantic-ai-slim` 2.47.0 deferred tools, the same pin as the rest of the unit.
- Why this is the first viable option: the continuation seam is a released public API — `Agent.run` /
  `Agent.iter` accept `deferred_tool_results`, and `DeferredToolRequests` is a declared output type — so
  no adapter, fork or local protocol is needed to resume across a process boundary. It answers the task
  card's question and nothing wider: it is not a comparison against the official durable-execution
  integration and must not be read as one.
- Exact OpenBot-specific gap: the SDK checkpoints and resumes **messages**, not Task/Run/Action
  identity, authority, approval, budget reservation or artifact registration. Everything the contract
  assigns to the control service stays outside the SDK payload.
- Upgrade, replacement, or exit plan: a changed SDK version, strategy or message schema is a control
  decision, not an automatic discard. The control service either keeps a compatible execution
  environment for the Task or runs a documented migration that rebuilds the checkpoint, and only then
  resumes; what it cannot reconcile is an explicit reconciliation item — never a silent resume, and
  never a Task thrown away because the runtime moved. Exit is to another mechanism behind the same
  control service; no product code depends on the probe.
- Failure behavior when the upstream is missing, incompatible, or compromised: the probe exits
  non-zero with the observed SDK error and builds no fallback; the Runtime keeps failing closed.

## Source incorporation

- Source copied or substantially adapted: no. The probe imports the installed distribution and
  constructs its own fixtures; upstream code was read for contract confirmation only.
- Files read for evidence (none copied): `pydantic_ai/_deferred.py`, `_agent_graph.py`
  (`UserPromptNode._handle_deferred_tool_results`), `_tool_execution.py` (`ToolCallDeferredProcessor`
  resume validation), `tool_manager.py` (the external-call refusal), `toolsets/external.py`,
  `durable_exec/_codec.py` and, for the row above,
  `durable_exec/temporal/{__init__,_durability,_function_toolset,_agent}.py`.
- Required copyright or license notice location: unchanged; the dependency notice already exists in
  `THIRD_PARTY_NOTICES.md` for `pydantic-ai-slim` 2.47.0.

## Verification plan

- Automated tests: `experiments/runtime-continuation/probe.py` is the one-command reproducer. The
  parent owns the expected outcome per case and re-checks child-written JSON reports, so a child cannot
  declare its own success; counters are cross-process append-only events, so model steps, tool bodies
  and deferred-tool call attempts are counted independently of the process boundary.
- Negative and fail-closed tests: one result missing; result id outside the last response; wrong-kind
  result (approval for an external call); result for an already completed call; duplicate tool-call
  ids; corrupted checkpoint (truncated, id-mutated, empty); run-id reuse; budget carried versus reset.
- Platforms and devices: macOS (darwin) with CPython 3.12.13 from the package-local `.venv`. No claim
  about Linux, Windows or any worker isolation.
- User-visible documentation and translations: an internal experiment record with no user-visible
  behaviour, API or claim change, so no product translation is added and `npm run check` is not run
  (no product file changes; the task card forbids it).
- Support level the evidence permits: SDK-level compatibility evidence for one pinned release on one
  POSIX host with synthetic fixtures — explicitly **not** evidence of production durability, approval
  persistence, budget enforcement, execution isolation or engine selection, and it neither qualifies
  nor disqualifies the official durable-execution integration, which this task did not run.

## Measured results

Command: `apps/agent-runtime-python/.venv/bin/python experiments/runtime-continuation/probe.py`.
WorkBuddy reported four successful local runs. Codex independently reproduced all 14 cases,
inspected the cross-process event ledger and added counter assertions for invalid continuations.
The experiment has no real model usage or production outcome verifier.

Journey across two processes (scripted model, no provider, no network):

- Segment 1 ended with `DeferredToolRequests` — `calls=[external_read c-read, external_write
  c-write]`, `approvals=[]` — after 2 model steps, with one local read-only tool executed and the
  external toolset never invoked locally. Checkpoint: 2197 bytes, 4 messages, digest recorded.
- Segment 2, a fresh interpreter, restored it and finished with `report:2` in exactly **1** model step.
  The read-only tool's body ran **1** time in total (0 in segment 2), so a completed call is not
  repeated; the single request the resumed model saw carried the two `ToolReturnPart`s instead of a
  reissued prompt; resumed usage continued the recorded one (2 → 3 requests).

Fail-closed behaviour the SDK already provides, observed exactly as stated:

| Probe | Observed |
| --- | --- |
| one of two results missing | `UserError`: "Tool call results need to be provided for all deferred tool calls. Expected: {...}, got: {...}"; 0 model steps, no tool body |
| result id outside the last response | the same `UserError`, naming the unknown id |
| approval value given for an external call | `RuntimeError: External tools cannot be called`, raised in `tool_manager.py` before the toolset |
| result for a call the SDK already completed | `UserError`; the completed body did not run again |
| duplicate `tool_call_id` in the response | `UnexpectedModelBehavior`: "Deferred tool calls must have unique tool_call_id values" |
| reusing the paused `run_id` | `UserError`: every run needs a distinct id; correlate with `conversation_id` |
| empty history plus results | `UserError`: results were provided but the history is empty |

What the SDK does **not** validate, and therefore what the control service must own:

- **Shape is not authenticity.** `validate_json` refuses a truncated checkpoint (`ValidationError`) but
  accepts one whose `tool_call_id` was rewritten — `"c-read"` → `"c-r3ad"` loads, and the rewritten id
  is what the SDK then correlates against — and accepts `[]` as a history. A digest catches exactly
  that and **nothing more**: it is an integrity check, not authentication and not authorization. It
  shows the bytes are the ones recorded, never that recording them was authorized.
- **Budget is opt-in.** With the recorded usage carried, `request_limit=1` raised
  `UsageLimitExceeded`; with a fresh `RunUsage` the *same* limit passed, so a resume that forgets to
  carry usage silently resets the SDK's counter.
- **Deferred proposals do not increment this SDK tool counter.** A segment that proposed two deferred actions and executed one
  local function tool reported `RunUsage(requests=2, tool_calls=1)`. The fixture does not account for external executor costs; these counters cannot replace the
  control service's action budget or establish whether a provider bills the operation.
- **Local tools execute with no handshake.** A plain function tool ran its body and wrote its file the
  moment the scripted model asked. The same body behind `ApprovalRequiredToolset` did not run and
  surfaced as `DeferredToolRequests.approvals`; supplying `approvals={"c-guarded": True}` then executed
  that body during the resume. An approval decision is not by itself authority.
- **Final text needs no deferral.** A run with no tools returns `str` directly.

### Checkpoint envelope the future implementation must pin

The probe writes a candidate envelope beside the history, not inside it, because the SDK serializes
messages and hands `DeferredToolRequests` back as a separate object. It pins: envelope format id; SDK
package/version/**commit** (the input to a compatibility or migration decision, not a reason to drop a
Task); strategy id and output types; message-schema adapter and version; run id and conversation id;
history message count, byte size and `sha256`; recorded `RunUsage`; and the deferred calls/approvals
with their ids and arguments. It also lists the facts it deliberately does not carry: Task/Run/Action
identity, authority and its revocation state, the approval decision bound to an Action intent, budget
reservation and settled usage, and artifact registration. No pickle, no cached positive grant, no
client-supplied history.

### Control validations that must precede an SDK resume

1. envelope format, and the SDK version/commit the Task's execution environment was selected for, still
   describe this attempt — or an explicit compatibility/migration step has already run;
2. the history bytes still match the recorded digest. That is an integrity check against corruption or
   tampering, **not** authorization: the SDK will not tell you, and a digest grants nothing;
3. the history is non-empty and ends in a `ModelResponse`; its tool-call ids are unique; the result ids
   equal the deferred ids exactly (no missing, no unknown, no extra);
4. every result id maps to a control-store Action with a **confirmed** terminal outcome — an unknown
   external result must never be handed over as a completed fact;
5. new model/tool admission rechecks current authority and the control-store budget. Recording a
   verified past effect remains possible after revocation; it must not require reviving its grant.
   Carrying SDK usage prevents counter reset but does not reserve or settle the business budget;
6. the resumed segment gets a **new SDK** run id with the same SDK conversation id. Neither identifier
   replaces OpenBot's Task/Run/Action identities; a continuation need not create a new business Run.

## Remaining integration gates

The control service must own checkpoint provenance, access and compatible version selection. A
co-modified history and digest are not authenticated; adding a signature by itself cannot establish
authorized state. Choose any signing requirement only from the real storage/threat boundary.
Qualify the official durable adapters against OpenBot's process/authority boundary before choosing
an orchestration integration. Confirm live-provider usage and action receipts separately: these
scripted request/tool counters are not token costs, external billing, or recovered product Tasks.
