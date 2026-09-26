# Research: local Python product Runtime composition

- Date: 2026-09-25
- Status: implementation candidate; integrated Temporal journey remains required.
- Scope: restore the retained product's model/tool execution using the existing Work contracts,
  and own its explicitly configured service lifecycle. Linux/runsc qualification remains deferred.

## Reviewed implementation and choice

Reuse the ledger's Work Worker, model receipts, deferred approval, corrections, knowledge,
publication and engine client entries. Temporal Python **1.33.0**
(`ab52fdde33ee8ed193402625bfdba25d240a762d`, MIT) and PydanticAI **2.47.0** (`77d5fce751ab8ab04bd5db4ed6acc1131a4baed6`, MIT) retain their full pinned commits and
source/releases/tests/issues/platform/license review in those records. The existing SDK Worker
async lifecycle, Activity identity/history checks, durable timers and external-tool results are
the maintained implementation. Official references:

- [Temporal SDK release](https://github.com/temporalio/sdk-python/releases/tag/1.33.0)
- [PydanticAI release](https://github.com/pydantic/pydantic-ai/releases/tag/v2.47.0)
- [Deferred tools](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
- [PostgreSQL 17 locking](https://www.postgresql.org/docs/17/explicit-locking.html)

Queries and source inspection are recorded in `work-product-worker.md`,
`work-deferred-approval.md`, `work-owner-corrections.md`, `work-tool-results.md` and
`python-work-product-model.md`. No new framework, dependency, retry owner or copied upstream
implementation is selected. The local gap is trusted composition of existing services.

The Server periodically invokes the existing **finite admission pass** for new work and
unconfirmed handoffs. That pass never restarts a reserved execution; original Temporal history
remains the recovery authority. The same lifecycle may admit due existing schedules and deliver
explicit closed-workflow repair commands. It does not retry a failed Worker or tool operation.
Configuration is one private, bounded operator file using the existing mutual-TLS reader;
startup failure is explicit, cancellation drains the owned Worker, and errors expose no raw
configuration or provider bodies. No production default changes.

## Corrections and publication

The new product profile records its history-reset protocol in `load_task` output. Existing
histories keep their original command path. A new Owner correction discards the entire earlier
model conversation before resuming, including knowledge that might have been copied into model
text. The replacement prompt contains the original objective, all current corrections and
Control-owned prior Action identity/tool/status facts, never old results, arguments or knowledge
content. Unknown Actions still block progression. This permits the knowledge adapter to check
only the current correction generation, while retaining every old receipt for audit/recovery.

Publication hooks are trusted composition, never Workflow/model values. Under the existing
completion transaction they check consumed knowledge before the terminal update, then insert
an optional pending memory proposal after verified completion. No active memory is written.
The final fence check follows all hooks. Receipt/content checks prove recorded observations and
publication integrity; they do not claim external business success or arbitrary answer quality.
Attachment verification acquires the existing Owner file lock before completion opens its
transaction, preserving `files -> Task` ordering. The independent result review uses short
validation scopes around database checks and holds no attachment lock across model HTTP.
Its exact observed Task revision includes only its own separately admitted review accounting;
completion still refuses a concurrent mutation after that snapshot.
The same short outer scope takes the plugin state read lease before Task. A lease-local checker
only compares recorded grants, expires on exit and cannot execute a tool or expose private state.
The Work adapter separately validates current Activity/source/correction and original ToolResults
inside the Task transaction. Final publication therefore cannot race a plugin grant revocation.

## Prepared report arguments

The retained report contract permits 24 KiB, while immutable Work intents deliberately remain
16 KiB. Reuse the existing private `LocalWorkFiles` content-addressed store and its digest/size
readback (ledger: Artifact read integrity; OCI descriptor verification, commit
`13cff54902ec9ad6320cbc487a685b66fcd67171`). The prepared Action stores a small blob descriptor
and the canonical original proposal digest. The Worker checks that digest on Activity retry;
the report adapter re-reads the exact bytes before returning or publishing a report.
No Action bound or SQL limit is raised. A recorded new product profile allows at most 64 KiB
encoded tool arguments, retaining all structure limits; prior histories keep the 16 KiB parser.
Only a trusted planner can replace arguments with a bounded reference. The model still supplies
the retained `{name, markdown}` shape, and a reference never grants file or execution authority.

Additional search: `temporalio/sdk-python large payload external storage workflow data converter`
and `docs.temporal.io blob store large payloads external storage`. Reviewed the already pinned
Temporal 1.33.0 [external-storage implementation and documentation](https://github.com/temporalio/sdk-python/tree/ab52fdde33ee8ed193402625bfdba25d240a762d/temporalio/converter)
and [official external storage guidance](https://temporal.io/changelog/external-storage-public-preview).
Its payload converter addresses engine history limits, not OpenBot's Action authorization record,
and would add storage configuration to every client/worker. The existing local artifact adapter
already supplies the missing control-owned storage with no dependency or copied source.

## Fresh-checkout test inputs

The two original model-connection TypeScript oracles are retained byte-for-byte under
`apps/server-python/tests/fixtures/model-feature`, from OpenBot MIT source
`9cc73c9e78451e572f57d142d6b9caf62ccb78e2`, with SHA-256 and provenance. They are test-only and
remove reliance on an unpublished/local Git object in a shallow contributor/CI checkout.
