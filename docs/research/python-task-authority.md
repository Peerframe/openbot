# Research: Python task authority migration sequence

- Date: 2026-09-23
- Status: design in progress; no task writer or execution switch accepted yet.
- Source baseline: 035bc95 and unchanged TypeScript task services.

Reuse the exact PostgreSQL 17.11, Psycopg 3.3.6, Pydantic 2.13.5 and Zod 4.6.2 pins reviewed for
[identity transactions](python-identity-transactions.md), [inputs](python-identity-inputs.md), and
[control reads](python-control-read-slice.md). Keep the existing SQL history, identifiers and audits.
No new workflow engine, ORM or model authority is selected. Existing released runtime/transport
reuse remains in apps/agent-runtime-python/RESEARCH.md; this document does not yet authorize an
invented second wire protocol or a dependency addition.

## Inspected responsibilities

- postgres-task-submission.ts owns one transaction for source message, chosen recipients, queued
  runs and MESSAGE_CREATED/RUN_CREATED audit. A locked channel serializes human/system timestamps
  so queued instructions retain distinct millisecond boundaries. Reply targets must be in-channel.
- task-routing.ts validates all one-to-six unique recipients before any writes; direct chats only
  address their Bot, a requested Bot must be a member, otherwise the chief/first candidate is used.
  Ordered SQL candidates are part of that fallback. A role name never grants tool authority.
- TaskAttachmentReferences and channel-attachments.ts lock/check Owner-authored attachment markers
  before the database transaction. Until Python has the equivalent file authority, it must refuse
  referenced-file submissions explicitly; accepting unchecked markers is not compatibility.
- postgres-task-records.ts and agent-observations.ts define Run/usage projection. Channel run reads
  return the latest 50, with full IDs and optional fields. Stored unknown status/profile values
  must not acquire execution authority. Model usage is reported evidence, not billing or a grant.
- native run cancellation, delegation, completion and channel member removal share PostgreSQL
  advisory namespace 731; cancellation includes active descendant runs and pending approvals.
  Their lock order, status predicates and callback timing must be reviewed together before porting.
- The current HTTP submission publishes committed events and invokes dispatch after persistence.
  Python must select one dispatcher per run and never schedule before commit. A successful queued
  write alone cannot establish that a task executed or survived a restart.

## Ordered implementation and gates

1. Frozen inputs/routing/Run projections and a paired TS/Python oracle, then atomic submission and
   channel reads in a dedicated synthetic fixture. Establish complete rollback, missing recipients,
   reply-scope rejection, exact audits and ordering. Do not expose unimplemented attachment behavior
   as supported or silently omit the multi-recipient `runs` envelope.
2. Python control-owned runtime supervision and guarded claim/complete/fail/cancel, retaining the
   accepted bounded untrusted worker framing. Deterministic process integration proves exactly one
   terminal publication, cancellation and refusal after revocation; it does not prove live models.
3. Tool/approval lifecycle plus membership removal, including transaction/dispatch boundaries and
   explicit handling of uncertain external effects. Durable restart continuation is qualified in S3.
4. Integrate each selected authority without two writers or double dispatch. Keep TS default until
   the full S2 contract/client gate, then prepare (not silently perform) the final selection change.

The public aggregate profile, snapshots/reconnect events, settings/files and schedules remain S2c.
Use larger independent implementation bundles now that the shared authority/input foundations are
stable; Root owns integrated behavior and independent real fixtures. Do not repeatedly re-implement
or re-review those settled foundations for each endpoint. Exact submission/runtime interfaces and
any intentional Unicode-title difference still need to be frozen before implementation begins.
