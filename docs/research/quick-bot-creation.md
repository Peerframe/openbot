# Quick Bot creation contract (C12)

- Status: Accepted for implementation
- Date: 2026-10-02
- Acceptance: one Owner request returns a new Bot and its persistent singleton conversation.
- Trigger: additive public HTTP command and composition of existing persistent identity writes.

Reuse [Python identity transactions](python-identity-transactions.md),
[direct conversations](desktop-direct-conversations.md), [conversation semantics](python-conversations.md)
and [Owner defaults](desktop-owner-preferences.md). Reviewed pins remain PostgreSQL17
`ec3f6a6a7dd82a8ce455a0710ef75172f9f318d1`, psycopg3.3.6 and Pydantic2.13.5.

Targeted searches on 2026-10-02: GitHub `psycopg psycopg transaction ON CONFLICT DO NOTHING RETURNING`
and `postgres postgres REL_17_STABLE advisory lock transaction tests`; primary documentation
`PostgreSQL17 INSERT partial unique index pg_advisory_xact_lock`. Rechecked official
[INSERT](https://www.postgresql.org/docs/17/sql-insert.html),
[transaction advisory locks](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
and [locking](https://www.postgresql.org/docs/17/explicit-locking.html). Empty DO NOTHING RETURNING
is a conflict, not a created identity. Advisory locks release on transaction exit.

| Candidate | Fit and cost | Decision |
| --- | --- | --- |
| Existing PostgreSQL17 / psycopg3.3.6, PostgreSQL License / LGPL-3.0 | Existing real transaction and concurrency tests; shared across Server instances; existing partial name uniqueness | Selected: thin composition |
| Sequence-backed names on the same database | Atomic but skips free names after deletion and adds persistent state/migration | Rejected for next-free-name contract |
| Client name probing and retries | Can race and leaves a Bot without its conversation after a failed second request | Replaced by one Server transaction |

No dependency, schema migration or third-party source is added. The existing active-Bot unique
index remains the arbiter for ordinary creation, rename and quick creation. A transaction-level
advisory lock serializes quick creators; bounded conflict retries also cover ordinary name writes.
Scan suffixes 1–10001 (1 means the unsuffixed name); exhaustion or sustained contention fails closed.
Owner authority is rechecked before commit. Bot/evolution/direct channel/membership/audit all share
one transaction using the same identity/direct helpers as existing routes.

The fixed role is `通用助手`, computer profile is `none`, and the requested complete appearance is
required. Copy the C7 default model selection only after resolving its current enabled connection
in the transaction. It is configuration metadata on this no-computer Bot; no host, model call,
greeting or work starts. No default means no model field; a stale default prevents creation.

Validate real HTTP auth/Origin/body guards, parallel independent stores, deleted-name reuse,
ordinary creation conflicts, default model inheritance/refusal and audit-trigger rollback.
Preserve existing direct membership, session revocation and expiry checks. UI integration is
owned by Claude and is not claimed by this backend slice.
