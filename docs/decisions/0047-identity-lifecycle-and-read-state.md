# ADR-0047: Channel and Bot lifecycle, read state and the Owner audit view

- Status: Accepted
- Date: 2026-09-30

## Context

The approved sidebar design adds rename and permanent delete for channels and Bots, automatic
unread counts and an Owner-readable audit list. The Server is the only authority for identity,
routing and audit (root `AGENTS.md`), so none of these can live in the client arrangement store
introduced for pins/groups/hidden rows.

Existing data constrains the delete semantics. `runs`, the durable Work tables
(`work_*`, `0027`–`0043`), `run_events` (the audit trail) and `employee_import_receipts` reference
`bots`/`channels` without cascading, and `work_sources`/`work_collaboration` reference individual
`messages`. Deleting those rows would either fail on foreign keys or erase task and audit facts.
The Owner chose (2026-09-30) "delete content, keep an audit tombstone".

## Decision and reasons

1. **Tombstones.** Migration `0045_identity_lifecycle` adds nullable `deleted_at` to `bots` and
   `channels`. Name uniqueness becomes partial (`WHERE deleted_at IS NULL`, and still excluding
   direct channels) so a deleted name can be reused. PostgreSQL 17 partial unique indexes
   ([docs §11.8](https://www.postgresql.org/docs/17/indexes-partial.html)) are the standard way to
   scope uniqueness to live rows; no dependency is added.
2. **Delete removes content, never facts.** In one Owner transaction, and only when the target has
   no active Run (`queued`/`assigned`/`running`/`waiting_approval`/`blocked`, the same set member
   removal uses):
   - channel: messages not referenced by durable Work are deleted (reactions cascade); messages a
     Work fact references keep their row with content replaced by a fixed placeholder; membership,
     automations and read state are removed; the row is tombstoned.
   - Bot: memberships, its direct conversation (as above), automations, memories, memory events,
     skills, knowledge proposals and evolution rows are removed; configuration is cleared; the row
     is tombstoned. Runs, Work, approvals, artifacts, import receipts and `run_events` remain and keep
     resolving the tombstoned name.
   - `CHANNEL_DELETED` / `BOT_DELETED` audit events record the actor, name and removed counts.
   Refusal while work is active is fail-closed: the Owner cancels or waits, the Server never
   cancels on a delete's behalf. Direct-conversation identity follows its Bot, so direct channels
   cannot be renamed or deleted separately.
3. **Rename** is an Owner identity write with `CHANNEL_RENAMED` / `BOT_RENAMED` audit (`from`,`to`).
   A Bot rename also renames its direct conversation. Names follow the existing create limits.
4. **Read state.** `channel_read_states(channel_id, last_read_at)` records when the single Owner
   last opened a channel. Unread = Bot/system messages after that instant, capped at 99 per channel.
   Existing channels are initialised as read at migration time so upgrades do not flood the list.
   Marking read is idempotent and is not an audit fact.
5. **Audit view.** `GET /api/v1/audit` returns the newest `run_events` (≤100, keyset `before`) with
   an allowlisted projection: type, time, channel/Bot/Run ids and names, and only named payload keys.
   Free-form payloads (for example message text) are never exposed through this view.
6. **Tombstone visibility.** Workspace, list, membership, routing, profile, automation and event
   entry points exclude tombstones and answer 404 for them. Historical Work/Run projections keep
   reading the retained row and show the name as recorded.

Alternatives: hard cascade deletion (erases audit and Work facts, rejected by the Owner and the
Server audit rule); "delete only unused" (safe but leaves every used Bot undeletable); archiving
without content removal (does not meet "permanent delete"). No upstream source was copied.

## Consequences and verification

Content deletion is irreversible; the UI requires an explicit confirmation that names the target.
After the tombstone commits, the route removes the channel's attachment files (and a deleted Bot's
direct-conversation files) under the attachment lock in a transaction that re-proves the tombstone,
so live channels' files can never be removed; the response reports `attachmentsRemoved`, and a
failure leaves files that no live route can read. Read state is
single-Owner, matching the current single-Owner model. Verification: Python store/route tests on
the disposable PostgreSQL fixture (rename conflicts, direct-channel refusal, active-work refusal,
content removal with Work-referenced message redaction, tombstone exclusion, read/unread counts,
audit projection), Web component tests and rendered checks. Hosted CI remains separate evidence.
