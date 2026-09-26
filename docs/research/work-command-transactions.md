# Work command transactions: reuse and remaining transport seam

Date: 2026-09-25. Scope: the reviewed offline-command contract's second component slice. Implementation follows the prior [source/dependency review](work-command-authority.md) and root approval of the Work-specific adaptation, immutable model snapshot, lock ordering, mandatory input scope and original native deadline constraint. No new dependency, framework or distributed clock service is introduced.

## Existing implementation reused

The existing Work store owns proposal/Owner decision/admission, accepted handoff identity, correction generation and claim fences. The candidate calls those helpers and the existing `work_collaboration.lock_task` source-before-ancestor lock chain. The current `ModelConnectionsService` resolves the frozen independent selection and current policy/key availability. Existing `OwnerFiles.lock`, bounded local reads/reference checks and `ProductWorkReads._attachment` provide input byte/metadata/derived-text validation. The actual SDK ActivityEnvironment and existing one-start-event inspector are exercised; the fixture's history and host transport/readiness remain synthetic.

The existing owned `ControlDatabase` helper from `experiments/work-journey/active_restore_probe.py` supplies native Docker/PostgreSQL lifecycle and canonical Node migrations. This slice does not create a backup or fixture framework. A dedicated random loopback PostgreSQL 17.11 container/volume holds all 41 canonical migrations and the candidate table definitions. Only the owned container/volume is removed; private fixture passwords/session tokens are not included in public evidence.

## Primary-source basis and decision

[PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) and [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) support the retained READ COMMITTED, consistent row/advisory lock order and fresh statements after waiting. SQL rows provide the unique single-consume decision; process locks alone do not. The suite deliberately removes synthetic outer guards for one four-request test to exercise actual database serialization, and separately exercises production-order file/identity guards and both cancel/consume lock winners.

[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) and the previously reviewed joserfc/RFC 8785 pins remain the sole token/canonicalization implementation. An authenticated signature is not business authority or proof of command success. No cryptographic or time algorithm is copied or rewritten. Temporal owns Activity scheduling/recovery; the component preserves original Action/epoch and never starts a retry loop.

Inspection of the retained schema found `runs_model_selection_valid` allows a selection only for legacy `model` Runs. The approved local adaptation keeps `docker-linux` source Run selection NULL and freezes Bot configuration into the new Task-specific profile, avoiding a broader old-schema change. Current profile reads reject source ambiguity, changed identity and absent snapshots; historical Tasks are not upgraded.

## Exact unimplemented gap

ADR-0045 remains a proposed capability-lease design, not a reusable second Work approval authority. Its native readiness timing cannot be copied unchanged: the immutable dispatch needs a native deadline which must already be enforced. Existing codec tokens do not authenticate pre-admission readiness and Worker Host has no command-specific preparation request/response yet.

The next narrow implementation must add a bounded prepare/readiness exchange on the existing Node channel, backed by the separately trusted enforcer and its protected original Action/epoch ledger. It may stage fixed helper/runtime/input resources only after current Server policy/Owner decision checks; it must not execute model argv before Work admission and online consume. Unit identity, original monotonic deadline, conservative trusted time conversion and exact prepared input/runtime shape need authenticated readback. Missing acknowledgement permits only original lookup. This component's sealed Python preparation object proves local file/scope validation, not remote readiness or enforcement. No mock result closes this gap.

See [the component contract](../WORK_COMMAND_COMPONENTS.md) for the precise API, preparation ordering, hard-deadline restriction and required activation gates. Public product routing, native clock/readback, protected once-only create/start, bounded output receiver and final artifact/result review require their own real integration evidence before enablement.

## Incorporation and validation

Only existing OpenBot MIT code/interfaces are reused; no third-party source was copied or substantially adapted. New code is a small Work-specific transaction/schema adapter around reviewed components. The existing codec slice and dependency locks are not modified. Tests are real PostgreSQL/OwnerFiles and include real pinned SDK ActivityEnvironment, with explicit synthetic history/transport/readiness. No provider network, live Temporal engine, Linux sandbox command or product execution is claimed.

## Root integration

The frozen component was reviewed and integrated as migration0041/canonical42. Root corrected
the module introduction to state that local preparation is not remote readiness, and wired
the81-case suite into its own disposable database within the existing Worker/CI fixture.
The full entry passed789 base cases (+2 optional skips),1056 Worker cases (no skips), the
TypeScript/Python contract oracles, and repository npm check. No command transport or Provider
was enabled. The42-entry S7 and active paired restoration also passed; new command tables were
empty in the active restore, so no in-flight command recovery is implied.

## Product deferred-tool envelope integration decision (2026-09-25)

Read the retained DeferredActivities / WorkEffects / CommandDispatches source before adapting.
The pinned PydanticAI/Temporal releases and prior deferred-tool source/license review remain
unchanged; current primary [deferred tool documentation](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
and [Temporal Event History](https://docs.temporal.io/encyclopedia/event-history) were also read.
Reuse the existing durable deferred tool Action and Owner decision, rather than create a second
command Action or SDK executor. No third-party source or new dependency is introduced.

The concrete integration gap is that DeferredActivities stores an immutable deferred_tool
envelope, while the command transaction component originally accepted only a bare work_command
intent. A narrow Server-only adapter accepts either that retained precursor or the exact
run_command envelope. Its arguments must equal the embedded command argv/output. The operation
uses the canonical digest of the *whole Action envelope*, retaining model arguments and effect
as one reviewed fact. It does not strip the wrapper and accidentally bind only its effect.
The frozen wire operation/token/frame contracts remain unchanged; Node never accepts this
Server-private Action envelope as authority. Existing TypeScript/Python command codec vectors
continue to cover the bare wire-related contract. New tests cover the envelope and complete
operation digest. Public product activation remains pending the full native execution journey.

Receipt integration uses the existing Work event transaction to retain the exact permit-token
digest alongside the consumed dispatch. No new table or migration is needed. Original readback
requires exactly one matching event and never re-signs an expired permit just to reconstruct its
digest. A historical consumed precursor without that fact remains unverifiable; it is not silently
backfilled or re-executed. The wire receipt still proves only the protected command observation,
not independent correctness of its generated business content.

## Product execution composition decision (2026-09-25)

Reuse the retained DeferredPlan, EffectServices, ToolResults, private LocalWorkFiles,
ProductWorkBinding and independent result-review/publication barriers. The source adapter has
already frozen the channel CommandProfile. The specific remaining gap is sequencing: a command
must prepare native resources before its existing WorkStore admission, while the generic effect
path admits before calling apply. Add one optional, trusted EffectServices execution callback;
the command implementation calls CommandDispatches for preparation/admission/consumption and
then the existing readback-only resolver. Generic tools retain their existing path. The callback
cannot come from a model, Node, JSON or catalog. Its reported result is checked against the
durable Action row by DeferredActivities. No second approval, Action, scheduler or SDK tool
executor is introduced. This is an OpenBot-specific thin adapter around the reviewed releases
above; no third-party code is copied or new dependency selected.

The model supplies only bounded argv and one output descriptor. Server policy supplies image,
limits, offline network, readonly rootfs and fixed uid. Original Owner attachment references
deterministically map to input-01, input-02, etc.; their bytes and snapshots are checked again at
preparation, consumption, readback and publication. A bounded read-only observation sequence may
wait on the original running command until its original deadline; it never resends preparation,
dispatch or permit. Missing, expired or mismatched evidence remains unknown.

Exact output bytes stay in the existing private blob store. A bounded UTF-8 excerpt, explicit
truncation, exit status, hash and descriptor form untrusted model evidence. A persisted signed
receipt is verified at its recorded receipt time when reading historical private evidence,
while current product source/input permissions are checked independently. Download publication
still requires the existing independent result review and atomic completion transaction.
## Product claim composition correction — 2026-09-25

The actual Owner/Temporal/Node entry reached approval but refused preparation before any Host
frame: the generic60-second Activity claim cannot contain the reviewed30-second preparation,
approximately50-second conservative runtime upper bound and5-second stop allowance. Reuse the
existing trusted `_claim_bound_activity(expires_seconds=...)` and unchanged Work claim transaction,
which already bounds1..300 seconds and never renews a replayed claim. The command adapter selects
a fixed120-second claim through its trusted EffectServices composition; other tools keep60.
This does not change the original Action/root deadline, receipt timing, native50-second unit,
SDK Activity timeout, online consume rule or source/approval checks. The original root/Action/claim
minimum still must contain the entire timing envelope. No model or HTTP field selects the lifetime.
