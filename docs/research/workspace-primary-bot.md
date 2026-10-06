# Workspace primary Bot (C26)

- Status: Accepted for implementation under the Owner's 2026-10-05 request.
- Reviewed baseline: `010439bb9002fabb7e1facd8450ee85edbafa309`, with retained C28 changes.
- Trigger: additive public command, routing preference and persistent data.
- Acceptance: at most one primary per Server workspace; explicit recipients/direct conversations
  retain their rules; preference changes grant no execution or approval authority.

Reuse [identity transactions](python-identity-transactions.md),
[direct conversations](desktop-direct-conversations.md), [C7 preferences](desktop-owner-preferences.md)
and [quick creation](quick-bot-creation.md). Reviewed releases remain PostgreSQL17.10
(PostgreSQL License), psycopg3.3.6 (LGPL-3.0), and Pydantic2.13.5 (MIT).
No dependency, copied external source or new event infrastructure is introduced.

Targeted searches on 2026-10-05: `site.postgresql.org/docs/17 explicit locking SELECT FOR SHARE
FOR UPDATE foreign keys`, `site.github.com/psycopg/psycopg transaction row locks tests`.
Rechecked [PostgreSQL row locks](https://www.postgresql.org/docs/17/explicit-locking.html) and
[Psycopg's transaction contract](https://github.com/psycopg/psycopg/blob/3.3.6/docs/basic/transactions.rst).
Shared readers and exclusive writers serialize against the same row; lock ordering is necessary
to avoid a task holding channel/Bot locks while waiting on deletion's preference lock.

| Candidate | Fit and cost | Decision |
| --- | --- | --- |
| Reuse C7 Owner-preference row/revision | Existing authority, but couples primary changes to time zone/default model/transcription CAS | Reuse its transaction/input pattern, keep an independent revision |
| One `workspace_settings` SQL row | Enforces one workspace preference, supports independent Server writers and atomic identity/audit publication | Selected; migration 0054 (renumbered before publication to retain the published 0052 greeting migration) |
| Bot boolean flags or in-memory primary | Multiple flags need partial uniqueness and a separate no-primary revision; process-local defaults race | Rejected |

The existing product hosts one workspace per database; the singleton key is constrained to
`workspace`. Existing Bots are not silently elected during migration. New ordinary/quick creation
and new reviewed imports lock the preference and fill it only if empty. Import receipt replay
does not re-elect an old Bot. Preference publication and old/new-ID audit commit with identity;
audit/authority failure rolls back both. Deleting the primary clears it with a version increment
and audit in the same tombstone transaction; existing Bots are never automatically elected.
The foreign key's physical-delete nullification supports referential integrity/disposable fixtures;
the public deletion path remains the audited tombstone transaction.

All participating preference, creation, import, deletion and submission paths acquire the
workspace row before Bot/channel row locks. Submission holds SHARE through immutable recipient
publication; preference changes cannot revise queued Runs or change current claims, permissions,
budgets, plugin grants or computer profiles. An explicit structured mention wins, then a fixed
direct Bot, then a primary that is an actual channel member, then the retained Chief/roster fallback.
Delegation retains its existing same-channel child-task authority checks and per-Bot grants.

GET workspace always returns nullable `primaryBotId` and `revision`. Shared TS snapshot fields
remain optional solely for pre-C26 Servers and frozen oracle fixtures; the new PUT contract is
strict. Clearing is explicit null, CAS is bounded to 1..2147483647, deleted/unknown Bots return 404,
stale revisions return 409, and unchanged writes do not increment/audit the persisted preference.
The existing authenticated polling `workspace.ready` stream compares the complete persisted
snapshot and emits its content-free reload hint within its next three-second poll. This also
observes changes from an independent store; it needs no process-local broadcaster or new event type.

Validate Owner cookie/Origin, unknown authority-shaped fields, concurrent writers/default creation,
selection versus deletion, ordinary/quick/import defaults, replay, tombstone behavior, routing,
nullable old/new audit projection/rollback, SSE, and the General-settings empty/conflict states.
Use owned PostgreSQL fixtures and synthetic browser preview; no model or production data is needed.
