# Offline Work command components — inactive candidate

This candidate validates Control transactions for a future offline Linux command path. It does not register a product tool, HTTP/WebSocket endpoint, Node command, Provider or execution service. `docker-linux` remains unavailable for product Work until the integration gates below are closed. Browser execution is outside this candidate.

## Authority and immutable source

Every v1 command requires explicit Owner approval. Work proposal, Owner decision and `PostgresWorkStore.admit` remain the only Action authority. A command dispatch is a subordinate row inserted by the existing admission callback in that same transaction, with zero model-token reservation. A failed INSERT/signature/final fence rolls back admission too. No separate approval, lease authority, retry loop or Run executor is introduced.

New channel Tasks alone may capture `work_command_profiles`: the source message/Run, Task and Bot must exactly agree, the Bot must still be a channel member with `docker-linux`, and the route is supplied by trusted Server composition. The original source Run retains `node_id=NULL` and **`model_selection=NULL`**, preserving `runs_model_selection_valid`. Its role is source provenance only. The new profile independently freezes the exact `Bot.configuration.model` under the same transaction's Bot lock. Current connection enablement/credentials/policy are rechecked through `ModelConnectionsService`; later Bot model edits never replace the queued selection. Native and historical Tasks have no fallback; a simultaneous native profile is refused.

The profile privately pins Node credential digest, Provider, enforcement key/ledger, image and limit policy digest. No key, credential digest or signed token is added to the public Action intent/DTO.

## Fixed dispatch and transaction order

The component reuses `_task`/`_action`, accepted Workflow binding, actual SDK Activity identity, original Work claim/fence and correction checks. The private dispatch stores the original Action/Run, epoch, claim, connection UUID, operation fingerprint, engine start provenance, correction context and bounded input scope. Unique `action_id` prevents reminting. The ticket cannot outlive the original Action or claim expiry. States are only `issued → consumed` or `issued → closed`. Later epochs cannot consume the old dispatch. Unknown outcomes and consumed/cancelled outcomes keep their original identity for lookup; duplicate consumption returns `lookup_required` and never another permit.

`files.lock → registry identity_guard → existing channel/source/ancestor-Task/Action locks → dispatch → credential SHARE` is mandatory. The concrete `CommandInputScope` is required, with no permissive default. Its files/metadata are read by the existing OwnerFiles implementation and retained `ProductWorkReads._attachment` snapshot validator. It binds Task, Work Run, authority generation, correction, source identity and exact sorted filename/size/hash manifest. Preparation is additionally bound to the original Action, epoch and complete operation fingerprint. Admission and consumption reread referenced attachment bytes/metadata/derived-text version while holding the same file lock. Cross-channel, unreferenced, deleted, changed and cross-generation inputs fail closed. This first adapter accepts text attachments and explicitly processed documents supported by the existing read tool; it never runs extraction/OCR/transcription silently.

The integrated [v2 readiness adapter](WORK_COMMAND_READINESS.md) replaces the former process-sealed
`PreparedCommand` and caller-provided native deadline. `reserve`, signed Host challenge,
`authorize_preparation` and signed `accept_ready` precede Work admission. Remote preparation permits
only bounded staging; it cannot execute model argv. The first verified proof fixes the original
native identity and conservative Server-domain stop bound. The same Action is never prepared again.

The deadline proof uses a qualified causal interval, not a Host UTC timestamp. Control checks the
original root/Action/claim budget before preparation; the first valid readiness receipt fixes
`nativeDeadline == hardDeadline`. Consume still issues at most one five-second launch permit.
Recovery, lookup and late acknowledgement cannot extend the deadline or create another unit.
The protected Host, actual transport and current-authority lookup/stop composition remain required
before activation; the pure adapter tests do not establish those runtime facts.

## API and integration gates

- `CommandProfiles(connections, policies=...)`: `capture_in_transaction(db, task, route=..., credential_digest=..., policy_id=...)` only in the new source creation transaction; `resolve_in_transaction(db, task)` rejects changed scope and resolves the frozen model independently.
- `CommandInputScope(files)`: required composition; wraps the existing file lock and original input-snapshot revalidation.
- `CommandDispatches(..., input_scope=..., transport=..., signer=..., verifier=..., timing_policy=..., prepare_clock=...)`: await `start()`, then `reserve`, `authorize_preparation`, `accept_ready`, `admit(..., preparation_id=...)` and single `consume`. Private `original` and `close_unconsumed_in_transaction` retain the original identity; see [readiness](WORK_COMMAND_READINESS.md) for timing and restart conditions.
- `transport.guard(opaque_connection)` must use the existing registry identity lock, reject stale/replaced/closed sockets and yield Server-assigned `LiveCommandConnection`. Registry currently has no command connection UUID/frame composition; a model or Node cannot provide this object.

Root still must integrate the new source/model-selection branch, mandatory consumed-read revalidation for the new source kind, approval/catalog/admission policy, actual registry/Node relay, protected preparation/once-only execution, independent whole-producer deadline, bounded artifact receipt collection, model receipts and final artifact/result review. Existing Docker precursor guarantees are not an end-to-end product claim. Signature verification is producer authentication, not effect verification; only validated observations/bytes under the real enforcement and review path can settle an Action.

The authority SQL is integrated as `0041_work_command_authority.sql`; readiness migration `0042_work_command_preparations.sql` brings canonical history to 43 entries. All 40 retained migration/restore cases and 8 cleanup cases previously passed on the 42-entry history. Active paired restoration also passed; the newly inactive command tables were empty in that fixture. No historical profile/dispatch backfill is permitted. No source/dependency lock from the integrated codec slice is overwritten.

## Verification

The focused suite uses a fresh owned loopback PostgreSQL 17.11 fixture, the complete canonical migration history, real Work/Owner/model-connection/file services, real SDK `ActivityEnvironment` for one entry test, and explicitly synthetic immutable history, transport and native readiness. It covers concurrent single consume, both cancel/consume lock winners, SQL-trigger rollback, stale handoff/claim/source/model/member/correction/Node identity, fixed original deadlines, changed/deleted/foreign inputs and opaque preparation identity. It runs no provider network, model request, Docker command workload or live Temporal engine.

Run `test_work_command_store.py` only with a separate disposable `OPENBOT_COMMAND_TEST_FIXTURE` JSON (`fixtureKind=work-command-authority`, loopback `openbot_control_test_...` DSN and synthetic Owner token). Apply the complete canonical migration history first. The Worker dependency profile and both Python source packages are required. The cross-language codec vectors already live in the standard test fixtures directory. Tests delete only their own model connection IDs; the enclosing disposable fixture owns all remaining synthetic rows/files and must clean up its exact container/volume. Do not point this suite at a shared test fixture or real profile.
