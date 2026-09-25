# Native product Task execution profile — proposed bounded contract

Status: accepted by root; implementation confined to this isolated packet.
Date: 2026-09-25. Root remains the only repository writer.

## Existing gap

`POST /api/v1/tasks` atomically creates a Work Task, initial Run and handoff obligation,
but records no immutable Employee execution-profile/model-selection snapshot. The
product model port requires a `work_sources` mapping to a channel Run. Independent
Tasks therefore cannot execute through the product port without an invented channel.
That invention would violate the accepted channel/task identity boundary.

## Reuse and research

Read the reuse ledger's Work-domain/channel/model-connection entries and the accepted
research `work-domain-admission.md`, `work-channel-admission.md`,
`python-work-product-model.md`. Reuse their pinned PostgreSQL17.11, Psycopg3.3.6,
Pydantic AI2.47.0, Temporal1.33.0 and released official SDK ports. Existing OpenBot
feature model-selection source is MIT `9cc73c9e78451e572f57d142d6b9caf62ccb78e2`.
No new dependency, framework or external source copy is proposed.

Rechecked the official PostgreSQL17 [INSERT contract](https://www.postgresql.org/docs/17/sql-insert.html),
[transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) and
[row locks](https://www.postgresql.org/docs/17/explicit-locking.html), and requested the
pinned [REL_17_11 insertion implementation](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/executor/nodeModifyTable.c)
(the web cache could not retrieve that already reviewed upstream file; no source claim
is inferred from its absence).
The existing `INSERT ... ON CONFLICT DO NOTHING` plus a separate follow-up SELECT
remains the correct idempotency boundary: a competing committed insert can suppress
the first INSERT even though its row was not visible to that statement's snapshot.
Create the profile only on the successful new-Task branch. Replays cannot rewrite
the selection or fail because today's Bot configuration differs.

The first viable option is a narrow application provenance record plus the existing
model/source binding ports. Replacing the scheduler or adapting an unrelated upstream
Task framework cannot supply OpenBot's Owner transaction or immutable Bot selection
semantics and is outside this concrete gap.

## Proposed API and data

New `work_task_profiles.py` provides a product-only creation hook:

```python
WorkTaskProfiles()
await profiles.capture_in_transaction(db, task_id, bot_id)
await resolve_product_source(db, task, bot_id) -> dict
product_capabilities(source) -> frozenset[str]
await task_profile_prompt(db, context) -> dict
```

Add optional `PostgresWorkStore(..., task_profiles=None)` composition. In the successful
new `create_in_transaction(..., source=False)` branch, capture the Bot under the
existing SHARE lock and write the snapshot in the same Owner transaction before the
initial Run/admission/event commit. Default/reference stores and trusted channel
`source=True` admissions keep their current contract. Replays return the existing Task
without new profile validation or historical backfill.

Proposed additive `0038_work_task_profiles.sql`:

```text
work_task_profiles(
  task_id text primary key references work_tasks,
  bot_id text not null references bots,
  execution_profile text not null check none|model,
  model_selection jsonb null|{connectionId,modelId},
  profile_digest text not null check lower hex64,
  created_at timestamptz not null default now()
)
```

Digest binds an exact version-1 Task/Bot/profile/selection object. `none` requires null
selection; `model` requires a valid explicit `ModelSelection`. No credential, base URL,
connection revision or mutable Bot configuration is copied. Current provider settings,
allowlists, connection enablement/revision and keys remain resolved at model dispatch.
Queued selection never follows later Bot edits. Old Tasks with neither source nor
profile remain unable to start product execution.

`resolve_product_source` returns `source_kind='channel'|'task'`. Channel scope retains
the source Run and current membership checks; native Task scope validates the immutable
profile against the locked Task/Bot identity. Missing, conflicting or corrupt provenance
fails closed. The minimal Model._source and Binding.check patches share this discriminator,
allowing the existing report adapter and result verifier to reuse their accepted checks.

For native Tasks, capabilities are only `model`, `report`, `result_review`. Channel reads,
attachments, Bot knowledge, plugins and web tools remain unavailable until separate
scope contracts exist. The native prompt contains Bot descriptive profile and Task
provenance only, never a fake channel, source message or attachment identity. Root owns
runtime catalog, before-send, completion and capability-branch integration.

## Accepted root decisions

1. `model` without explicit valid selection rejects new product Task
   creation rather than creating a Task that must fail at dispatch. Replay of an
   existing request is still unaffected by current Bot configuration.
2. Immutable by insertion-only application API and digest validation,
   consistent with existing Work immutable intents; no schema trigger unless required.
3. Root requested an independent PostgreSQL copy of this agent's owned `work_reads`
   database. Apply only the final `0038` candidate there and document exact DDL/hash/history
   steps; root alone updates the canonical journal and Python migration hash gate.
4. Enable corrections on the initial native Work Run in the same transaction, only
   when the product profile hook is explicitly configured. Do not backfill historical
   Tasks. The native prompt includes the actual Task creation time and validated Bot
   descriptive bounds; it uses the supplied ProductWorkBinding to derive current SDK
   scope before projecting data.

## Planned acceptance

Real disposable PostgreSQL plus actual FastAPI route and Owner-cookie/Origin checks:
new creation, identical/different replay, concurrent same key, atomic rollback, Bot
configuration changes, unsupported execution profiles and malformed/missing selection.
Use the existing synthetic SDK/history/HTTP seams to test actual ProductWorkModel
receipt generation/recovery, report binding and result-review source resolution without
paid accounts or a fabricated complete Temporal journey. Preserve channel-source tests.


## Integrated guard regression, 2026-09-25

The final full Worker gate initially reported one stale artifact-test expectation
(860 passed). Channel membership revocation is now checked by resolve_product_source,
shared with the existing model adapter: it raises product_model_scope_changed before
artifact bytes are written or an Action is admitted. Source identity mismatches still
raise product_source_changed. The old artifact assertion was updated to the exact
shared-guard code; no implementation check was removed or broadened. The independent
read-only review traced prepare -> binding.check -> resolve_product_source and retained
the separate execution_claim_required assertion.
